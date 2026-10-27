package loadout.core

import loadout.core.engine.ConfigEngine
import loadout.core.engine.ConfigException
import loadout.core.model.ConfigState
import loadout.core.model.ConfigStatus
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ConfigEngineTest {
    private val cz = "chezmoi --source '/repo/configs' --no-pager"
    private val managed = "$cz managed --include files,symlinks"
    private val status = "$cz status --include files,symlinks"

    private fun engine(runner: FakeProcessRunner) = ConfigEngine(runner, "/repo/configs")

    private val managedOut = """
        .config/tmux/tmux.conf
        .config/zsh/.zshrc
        .config/zsh/conf.d/a.zsh
        .config/starship.toml
        .zshenv
        .local/bin/x
    """.trimIndent() + "\n"

    @Test
    fun unitsAreAConfigFolderOrATopLevelName() {
        val runner = FakeProcessRunner().apply { onCommand(managed, stdout = managedOut) }
        val units = engine(runner).units()
        assertEquals(listOf(".local", ".zshenv", "starship.toml", "tmux", "zsh"), units.map { it.name })
        assertEquals(listOf(".config/zsh/.zshrc", ".config/zsh/conf.d/a.zsh"), units.first { it.name == "zsh" }.targets)
    }

    @Test
    fun aUnitDriftsWhenApplyWouldChangeOneOfItsFiles() {
        val runner = FakeProcessRunner().apply {
            onCommand(managed, stdout = managedOut)
            // Second column: apply would change it. First column alone: edited
            // here but already what the repo says, so nothing to apply.
            onCommand(status, stdout = " M .config/zsh/.zshrc\nM  .config/tmux/tmux.conf\n A .config/zsh/conf.d/a.zsh\n")
        }
        val configs = engine(runner).observe(emptyMap())
        assertEquals(ConfigState(ConfigStatus.DRIFTED, listOf(".config/zsh/.zshrc", ".config/zsh/conf.d/a.zsh")), configs["zsh"])
        assertEquals(ConfigState(ConfigStatus.APPLIED), configs["tmux"])
        assertEquals(ConfigState(ConfigStatus.APPLIED), configs[".zshenv"])
        assertEquals(5, configs.size)
    }

    @Test
    fun onlyFilesEditedHereThatApplyWouldReplaceNeedADecision() {
        val runner = FakeProcessRunner().apply {
            onCommand(status, stdout = "MM .config/zsh/.zshrc\n M .zshenv\nM  .config/tmux/tmux.conf\n")
        }
        val engine = engine(runner)
        assertEquals(listOf(".config/zsh/.zshrc"), engine.edited())
        assertEquals(emptyList(), engine.edited(listOf(".zshenv")))
    }

    @Test
    fun withoutChezmoiTheUnitsLastSeenAreUnknown() {
        val runner = FakeProcessRunner() // every command: exit 127
        val engine = engine(runner)
        val previous = mapOf("zsh" to ConfigState(ConfigStatus.APPLIED))
        assertEquals(
            mapOf("zsh" to ConfigState(ConfigStatus.UNKNOWN, reason = "chezmoi is not on PATH")),
            engine.observe(previous),
        )
        assertEquals("chezmoi is not on PATH", engine.lastReason)
    }

    @Test
    fun aChezmoiErrorIsTheReasonInItsOwnWords() {
        val runner = FakeProcessRunner().apply {
            onCommand(managed, stdout = managedOut)
            onCommand(status, exitCode = 1, stderr = "chezmoi: .bad: template: dot_bad.tmpl:1:8: map has no entry for key \"nope\"\n")
        }
        val engine = engine(runner)
        val configs = engine.observe(mapOf("tmux" to ConfigState(ConfigStatus.APPLIED)))
        assertEquals(ConfigStatus.UNKNOWN, configs.getValue("tmux").status)
        assertTrue(engine.lastReason!!.startsWith("chezmoi: .bad: template"), engine.lastReason)

        // The next good answer clears it.
        runner.onCommand(status, stdout = "")
        engine.observe(configs)
        assertNull(engine.lastReason)
    }

    @Test
    fun applyNamesAbsoluteTargetsAndForcesOnlyWhenAsked() {
        val runner = FakeProcessRunner().apply { onCommand("$cz target-path", stdout = "/home/me\n") }
        val engine = engine(runner)
        assertEquals("$cz apply --no-tty", engine.applyCommand(null, force = false).line)
        assertEquals(
            "$cz apply --no-tty --force '/home/me/.config/zsh/.zshrc' '/home/me/it'\\''s'",
            engine.applyCommand(listOf(".config/zsh/.zshrc", "it's"), force = true).line,
        )
    }

    @Test
    fun aChezmoiThatCantAnswerIsARefusal() {
        assertFailsWith<ConfigException> { engine(FakeProcessRunner()).units() }
    }

    // ─── a child repo: its parent's source and its own (contract 18) ──

    private val parentCz = "chezmoi --source '/dots/configs' --no-pager"
    private val childCz = "chezmoi --source '/work/configs' --no-pager"
    private val loadoutEnv = mapOf("LOADOUT_REPO" to "/work", "LOADOUT_MACHINE" to "work")

    private fun both(runner: FakeProcessRunner) = ConfigEngine(
        runner,
        listOf(ConfigEngine.Source("/dots/configs", "parent dots"), ConfigEngine.Source("/work/configs")),
        loadoutEnv,
    )

    private fun twoSources(parentManaged: String, childManaged: String, parentStatus: String = "", childStatus: String = "") =
        FakeProcessRunner().apply {
            onCommand("$parentCz managed --include files,symlinks", stdout = parentManaged)
            onCommand("$childCz managed --include files,symlinks", stdout = childManaged)
            onCommand("$parentCz status --include files,symlinks", stdout = parentStatus)
            onCommand("$childCz status --include files,symlinks", stdout = childStatus)
            onCommand("$parentCz target-path", stdout = "/home/u\n")
            onCommand("$childCz target-path", stdout = "/home/u\n")
        }

    @Test
    fun aUnitSpansBothSourcesAndDriftsWhenEitherWould() {
        val runner = twoSources(
            parentManaged = ".config/zsh/.zshrc\n.zshenv\n",
            childManaged = ".config/zsh/conf.d/zz-work.zsh\n",
            childStatus = " M .config/zsh/conf.d/zz-work.zsh\n",
        )
        val engine = both(runner)
        assertEquals(listOf(".config/zsh/.zshrc", ".config/zsh/conf.d/zz-work.zsh"), engine.units().first { it.name == "zsh" }.targets)
        val observed = engine.observe(emptyMap())
        assertEquals(ConfigState(ConfigStatus.DRIFTED, listOf(".config/zsh/conf.d/zz-work.zsh")), observed["zsh"])
        assertEquals(ConfigStatus.APPLIED, observed.getValue(".zshenv").status)
        // chezmoi sees the repo and machine loadout runs as.
        assertTrue(runner.received.all { it.env == loadoutEnv })
    }

    @Test
    fun aFileBothSourcesManageIsUnknownAndApplyRefusesIt() {
        val runner = twoSources(parentManaged = ".config/git/config\n.zshenv\n", childManaged = ".config/git/config\n")
        val engine = both(runner)
        val git = engine.observe(emptyMap()).getValue("git")
        assertEquals(ConfigStatus.UNKNOWN, git.status)
        assertEquals(".config/git/config is managed by parent dots and this repo — a file belongs to one repo", git.reason)
        val refusal = assertFailsWith<ConfigException> { engine.applyCommand(listOf(".config/git/config"), force = false) }
        assertTrue("a file belongs to one repo" in refusal.message.orEmpty())
        assertFailsWith<ConfigException> { engine.applyCommand(null, force = false) }
        // A target only one repo manages still applies.
        assertEquals("$parentCz apply --no-tty '/home/u/.zshenv'", engine.applyCommand(listOf(".zshenv"), force = false).line)
    }

    @Test
    fun applyRunsEachSourceOnItsOwnTargetsTheParentsFirst() {
        val runner = twoSources(parentManaged = ".zshenv\n", childManaged = ".config/work/x\n")
        val engine = both(runner)
        assertEquals("$parentCz apply --no-tty && $childCz apply --no-tty", engine.applyCommand(null, force = false).line)
        assertEquals(
            "$parentCz apply --no-tty --force '/home/u/.zshenv' && $childCz apply --no-tty --force '/home/u/.config/work/x'",
            engine.applyCommand(listOf(".config/work/x", ".zshenv"), force = true).line,
        )
        assertEquals(loadoutEnv, engine.applyCommand(null, force = false).env)
    }
}
