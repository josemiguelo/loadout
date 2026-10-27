package loadout.dsl

import kotlinx.serialization.json.JsonPrimitive
import loadout.core.manifest.ManifestAssembler
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/** A child repo's draft over its parent's declarations (contract 18), as `loadout compile` builds it. */
class ChildRepoTest {
    private class ParentData : MachineData() {
        var work by flag(false)
    }

    private class ChildData : MachineData() {
        var secret by flag(false)
    }

    /** The parent: a program, a profile, a machine of its own and a data schema. */
    private fun parent(): Pair<Registry, Map<String, Any>> {
        val registry = Registry(isParent = true)
        val names = mutableMapOf<String, Any>()
        Registry.into(registry) {
            repo(name = "dots", state = "state", configs = "configs", minToolVersion = "3.1.0", data = ::ParentData)
            val git = Dir("programs").program("git") { custom { command = "true" } }
            // Named as the repo root, in the parent: the parent's root.
            val unusedHere = root.program("htop") { custom { command = "true" } }
            val base = profile("base") { install(git) }
            machine("laptop") { extends(base); install(unusedHere) }
            names["git"] = git
            names["base"] = base
        }
        return registry to names
    }

    private fun child(parent: Registry, block: () -> Unit): Registry {
        val registry = Registry()
        Registry.into(registry) { block() }
        return registry
    }

    @Test
    fun aChildMachineUsesTheParentsDeclarationsButNotItsMachines() {
        val (parent, names) = parent()
        val child = child(parent) {
            repo(name = "work", state = "state", minToolVersion = "3.3.0")
            val tool = Dir("programs").program("worktool") { custom { command = "true" } }
            machine("work-mac") {
                extends(names.getValue("base") as Profile)
                install(tool)
                data(::ParentData) { work = true }
            }
        }
        val draft = child.draftOver(parent, "dotfiles")
        val manifest = ManifestAssembler.assembleWithoutFiles(draft)
        assertEquals(setOf("work-mac"), manifest.machines.keys)
        assertEquals(setOf("git", "worktool"), manifest.machines.getValue("work-mac").pm.keys)
        assertEquals("parent:programs", manifest.programs.getValue("git").origin)
        assertEquals("parent:", manifest.programs.getValue("htop").origin)
        assertEquals("programs", manifest.programs.getValue("worktool").origin)
        assertEquals(JsonPrimitive(true), manifest.machines.getValue("work-mac").data["work"])
        // The floor is the higher of the two; meta and layout are the child's.
        assertEquals("3.3.0", manifest.meta.minToolVersion)
        assertEquals("work", manifest.meta.name)
        assertEquals(null, manifest.layout.configs)
    }

    @Test
    fun aNameBothReposDeclareIsRefusedNamingTheParent() {
        val (parent, _) = parent()
        val child = child(parent) {
            repo(name = "work", state = "state")
            root.program("git") { custom { command = "true" } }
            machine("laptop") { }
        }
        val message = assertFailsWith<DslException> { child.draftOver(parent, "dotfiles") }.message.orEmpty()
        assertTrue("program 'git' is declared by parent dotfiles too" in message, message)
        assertTrue("machine 'laptop' is declared by parent dotfiles too — a machine belongs to one repo" in message, message)
    }

    @Test
    fun aChildCantDeclareADataSchema() {
        val (parent, _) = parent()
        val child = child(parent) { repo(name = "work", state = "state", data = ::ChildData) }
        val message = assertFailsWith<DslException> { child.draftOver(parent, "dotfiles") }.message.orEmpty()
        assertTrue("a child repo's data schema is its parent's — drop data = … from repo(…)" in message, message)
    }

    @Test
    fun warningsAreAboutTheChildsOwnDeclarationsOnly() {
        val (parent, names) = parent()
        val child = child(parent) {
            repo(name = "work", state = "state")
            root.program("forgotten") { custom { command = "true" } }
            machine("work-mac") { install(names.getValue("git") as Program) }
        }
        val draft = child.draftOver(parent, "dotfiles")
        val manifest = ManifestAssembler.assembleWithoutFiles(draft)
        val warnings = unusedWarnings(draft, manifest, child.spares, parent.declaredNames())
        // htop and the base profile are unused here, but they're the parent's.
        assertEquals(listOf("program 'forgotten' isn't installed on any machine"), warnings.map { it.substringBefore(" —") })
    }
}
