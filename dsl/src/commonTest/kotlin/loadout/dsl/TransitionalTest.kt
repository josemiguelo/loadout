package loadout.dsl

import loadout.core.manifest.ManifestAssembler
import loadout.core.model.RepoLayout
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/** `transitional()` scripts: what `loadout compile` says once every machine has done one. */
class TransitionalTest {
    private fun declared(block: () -> Unit): Pair<loadout.core.model.Manifest, Set<String>> {
        val previous = Registry.current
        val registry = Registry()
        Registry.current = registry
        try {
            block()
        } finally {
            Registry.current = previous
        }
        val draft = registry.draft().let { it.copy(manifest = it.manifest.copy(layout = RepoLayout(state = "state"))) }
        return ManifestAssembler.assembleWithoutFiles(draft) to registry.transitional.toSet()
    }

    private val repo: () -> Unit = {
        val cleanup = script(name = "cleanup") {
            run("rm -f old")
            check("test ! -e old")
            transitional()
        }
        val other = script(name = "other") {
            run("true")
            check("true")
        }
        val shared = profile(name = "shared") { run(cleanup) }
        machine(hostname = "m1") { extends(shared) }
        machine(hostname = "m2") {
            extends(shared)
            run(other)
        }
        machine(hostname = "m3") { run(other) }
    }

    @Test
    fun aScriptEveryRunnerHasDoneIsNamedForDeletion() {
        val (manifest, transitional) = declared(repo)
        assertEquals(setOf("cleanup"), transitional)
        val out = transitionalWarnings(manifest, transitional, mapOf("m1" to setOf("cleanup"), "m2" to setOf("cleanup", "other")))
        assertEquals(listOf("script 'cleanup' is done on every machine that runs it (m1, m2): it's transitional, so delete it"), out)
    }

    @Test
    fun oneRunnerNotDoneOrWithoutStateKeepsItQuiet() {
        val (manifest, transitional) = declared(repo)
        assertEquals(emptyList(), transitionalWarnings(manifest, transitional, mapOf("m1" to setOf("cleanup"), "m2" to setOf("other"))))
        assertEquals(emptyList(), transitionalWarnings(manifest, transitional, mapOf("m1" to setOf("cleanup"))))
    }

    @Test
    fun aTransitionalScriptNeedsACheckOnItselfOrEveryVariant() {
        val message = assertFailsWith<DslException> {
            declared {
                val s = script(name = "nocheck") {
                    run("true")
                    transitional()
                }
                machine(hostname = "m1") { run(s) }
            }
        }.message.orEmpty()
        assertTrue("script 'nocheck' is transitional, so it needs a check" in message, message)
        val variants = assertFailsWith<DslException> {
            declared {
                val s = script(name = "half") {
                    transitional()
                    variant(name = "a") {
                        run("true")
                        check("true")
                    }
                    variant(name = "b") { run("true") }
                }
                machine(hostname = "m1") { run(s.variant(name = "a")) }
            }
        }.message.orEmpty()
        assertTrue("script 'half' is transitional, so it needs a check" in variants, variants)
    }

    @Test
    fun transitionalBelongsToTheScriptNotAVariant() {
        val message = assertFailsWith<DslException> {
            declared {
                val s = script(name = "v") {
                    variant(name = "a") {
                        run("true")
                        check("true")
                        transitional()
                    }
                }
                machine(hostname = "m1") { run(s.variant(name = "a")) }
            }
        }.message.orEmpty()
        assertTrue("transitional() goes on the script, not on its 'a' variant" in message, message)
    }
}
