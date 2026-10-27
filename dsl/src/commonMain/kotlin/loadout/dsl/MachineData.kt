package loadout.dsl

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.properties.PropertyDelegateProvider
import kotlin.properties.ReadWriteProperty
import kotlin.reflect.KProperty

/**
 * A repo's data schema: a class whose keys are delegated properties with
 * their defaults, so `data { work = true }` is type-checked. Each
 * instance records what was set on it, which is what lets two profiles that
 * disagree still be an error (contract 2). Keys keep the property's name.
 *
 * ```
 * class Data : MachineData() {
 *     var work by flag(false)
 *     val kitty by table(::Kitty)
 *     class Kitty : MachineData() { var opacity by number(0.85) }
 * }
 * ```
 */
abstract class MachineData {
    private val defaults = linkedMapOf<String, () -> JsonElement>()
    private val values = linkedMapOf<String, JsonElement>()
    private val tables = linkedMapOf<String, MachineData>()

    protected fun flag(default: Boolean): Key<Boolean> = key(default) { JsonPrimitive(it) }

    protected fun text(default: String): Key<String> = key(default) { JsonPrimitive(it) }

    protected fun number(default: Double): Key<Double> = key(default) { JsonPrimitive(it) }

    protected fun whole(default: Int): Key<Int> = key(default) { JsonPrimitive(it) }

    protected fun list(default: List<String>): Key<List<String>> = key(default) { JsonArray(it.map(::JsonPrimitive)) }

    /** A nested table: a property holding another schema class. */
    protected fun <T : MachineData> table(make: () -> T): PropertyDelegateProvider<MachineData, ReadOnlyTable<T>> =
        PropertyDelegateProvider { _, property ->
            val table = make()
            tables[property.name] = table
            defaults[property.name] = { table.defaults() }
            ReadOnlyTable(table)
        }

    private fun <T> key(default: T, json: (T) -> JsonElement): Key<T> = Key(default, json)

    inner class Key<T> internal constructor(private val default: T, private val json: (T) -> JsonElement) {
        operator fun provideDelegate(thisRef: MachineData, property: KProperty<*>): ReadWriteProperty<MachineData, T> {
            defaults[property.name] = { json(default) }
            return object : ReadWriteProperty<MachineData, T> {
                private var value = default

                override fun getValue(thisRef: MachineData, property: KProperty<*>): T = value

                override fun setValue(thisRef: MachineData, property: KProperty<*>, value: T) {
                    this.value = value
                    values[property.name] = json(value)
                }
            }
        }
    }

    class ReadOnlyTable<T : MachineData> internal constructor(private val table: T) {
        operator fun getValue(thisRef: MachineData, property: KProperty<*>): T = table
    }

    /** Every key with its default. */
    internal fun defaults(): JsonObject = JsonObject(defaults.mapValues { it.value() })

    /** Only what was set, tables included when anything in them was. */
    internal fun written(): JsonObject = JsonObject(
        values + tables.mapValues { it.value.written() }.filterValues { it.isNotEmpty() },
    )

    internal companion object {
        val EMPTY_JSON = JsonObject(emptyMap())
    }
}
