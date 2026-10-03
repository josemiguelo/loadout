package loadout.core.manifest

import com.akuleshov7.ktoml.Toml
import com.akuleshov7.ktoml.tree.nodes.TomlKeyValueArray
import com.akuleshov7.ktoml.tree.nodes.TomlKeyValuePrimitive
import com.akuleshov7.ktoml.tree.nodes.TomlStubEmptyNode
import com.akuleshov7.ktoml.tree.nodes.TomlTable
import com.akuleshov7.ktoml.tree.nodes.pairs.values.TomlValue
import kotlinx.serialization.json.JsonObject
import loadout.core.model.MachineConfig
import loadout.core.model.MachineGroup
import loadout.core.model.scriptEntry

/**
 * Reads a machine or profile file (contract 2): `extends = [...]`, the
 * machine-wide `[data]`, and any other table as a group — a tool or concern
 * with its `install` (a variant key for the program named like the group, or
 * a table of program = variant), its `scripts` opt-ins and its `[<group>.data]`
 * (which is `[data.<group>]`). The groups fold into one program mapping and
 * one script list, so nothing downstream knows they existed. Read from the
 * TOML tree: group names are free-form.
 */
object MachineFile {
    /** Read [text] (from [label]); problems go to [errors], the config is what could be read. */
    fun read(toml: Toml, text: String, label: String, errors: MutableList<String>): MachineConfig {
        val root = try {
            toml.tomlParser.parseString(text)
        } catch (e: Exception) {
            throw ManifestException("Failed to parse $label: ${e.message}")
        }
        var extends = emptyList<String>()
        var data = MachineData.EMPTY
        val groups = linkedMapOf<String, MachineGroup>()
        val pm = linkedMapOf<String, Pair<String, String>>() // program -> (variant, group)
        val scripts = mutableListOf<String>()
        val scriptGroup = mutableMapOf<String, String>()

        for (node in root.children) {
            when {
                node is TomlStubEmptyNode -> Unit
                node is TomlKeyValueArray && node.name == "extends" ->
                    extends = strings(node, label, "extends", errors)
                node is TomlKeyValuePrimitive && node.name == "extends" ->
                    errors += "$label: extends is a list of profiles (extends = [\"${node.value.content}\"])"
                node is TomlKeyValuePrimitive && node.name == "base" ->
                    errors += "$label: base = true is gone; profiles live in the [layout] profiles directory"
                node is TomlTable && node.name == "data" -> data = MachineData.merge(data, MachineData.table(node))
                node is TomlTable -> {
                    val group = readGroup(node, label, errors)
                    groups[node.name] = group.first
                    for ((program, variant) in group.first.install) {
                        val previous = pm.put(program, variant to node.name)
                        if (previous != null) {
                            errors += "$label: program '$program' is mapped twice ([${previous.second}] and [${node.name}])"
                        }
                    }
                    for (entry in group.first.scripts) {
                        val name = scriptEntry(entry).first
                        val previous = scriptGroup.put(name, node.name)
                        if (previous != null) {
                            errors += "$label: script '$name' is opted into twice ([$previous] and [${node.name}])"
                        } else {
                            scripts += entry
                        }
                    }
                    group.second?.let { groupData ->
                        val wrapped = JsonObject(mapOf(node.name to groupData))
                        MachineData.conflicts(data, wrapped).forEach {
                            errors += "$label: data key '$it' is set in both [data.${node.name}] and [${node.name}.data]"
                        }
                        data = MachineData.merge(data, wrapped)
                    }
                }
                else -> errors += "$label: unknown key '${node.name}' (machine files hold extends, [data] and groups)"
            }
        }
        return MachineConfig(
            extends = extends,
            pm = pm.mapValues { it.value.first },
            scripts = scripts,
            data = data,
            groups = groups,
            label = label,
        )
    }

    /** A group's mapping and opt-ins, plus its `data` table when it has one. */
    private fun readGroup(node: TomlTable, label: String, errors: MutableList<String>): Pair<MachineGroup, JsonObject?> {
        val install = linkedMapOf<String, String>()
        var scripts = emptyList<String>()
        var data: JsonObject? = null
        val where = "$label: [${node.name}]"
        for (child in node.children) {
            when {
                child is TomlStubEmptyNode -> Unit
                child is TomlKeyValuePrimitive && child.name == "install" -> {
                    val variant = child.value.content as? String
                    if (variant == null) errors += "$where install is a variant name (install = \"omarchy\")"
                    else install[node.name] = variant
                }
                child is TomlTable && child.name == "install" -> for (entry in child.children) {
                    val variant = (entry as? TomlKeyValuePrimitive)?.value?.content as? String
                    if (entry is TomlStubEmptyNode) continue
                    if (variant == null) errors += "$where.install: ${entry.name} must name a variant (${entry.name} = \"omarchy\")"
                    else install[entry.name] = variant
                }
                child is TomlKeyValueArray && child.name == "scripts" -> scripts = strings(child, label, "[${node.name}] scripts", errors)
                child is TomlTable && child.name == "data" -> data = MachineData.table(child)
                else -> errors += "$where has unknown key '${child.name}' (install, scripts, data)"
            }
        }
        return MachineGroup(install, scripts) to data
    }

    private fun strings(node: TomlKeyValueArray, label: String, what: String, errors: MutableList<String>): List<String> {
        val items = (node.value.content as? List<*>).orEmpty().map { (it as? TomlValue)?.content ?: it }
        if (items.any { it !is String }) errors += "$label: $what is a list of strings"
        return items.filterIsInstance<String>()
    }
}
