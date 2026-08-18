package loadout.core

import loadout.core.engine.ScriptOutcome
import loadout.core.engine.ScriptRunner
import loadout.core.model.OsFamily
import loadout.core.model.ScriptStatus
import loadout.core.model.ScriptStep
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue
import okio.Path.Companion.toPath

class ScriptRunnerTest {
    private val repo = "/repo".toPath()

    private fun runner(fake: FakeProcessRunner) = ScriptRunner(fake, repo)

    @Test
    fun skipsWhenOsDoesNotMatch() {
        val step = ScriptStep(file = "x.sh", os = listOf("macos"))
        val outcome = runner(FakeProcessRunner()).run(step, OsFamily.LINUX)
        assertIs<ScriptOutcome.NotApplicable>(outcome)
    }

    @Test
    fun skipsWhenCheckPasses() {
        val fake = FakeProcessRunner()
        fake.onCommand("test -d \$HOME/.dotfiles")
        val step = ScriptStep(file = "x.sh", check = "test -d \$HOME/.dotfiles")
        val outcome = runner(fake).run(step, OsFamily.LINUX)
        assertIs<ScriptOutcome.AlreadyDone>(outcome)
    }

    @Test
    fun forceIgnoresCheck() {
        val fake = FakeProcessRunner()
        fake.onCommand("test -d \$HOME/.dotfiles")
        fake.onCommand("echo hi")
        val step = ScriptStep(run = "echo hi", check = "test -d \$HOME/.dotfiles")
        val outcome = runner(fake).run(step, OsFamily.LINUX, force = true)
        val ran = assertIs<ScriptOutcome.Ran>(outcome)
        assertEquals(ScriptStatus.DONE, ran.state.status)
    }

    @Test
    fun runsScriptFileThroughSh() {
        val fake = FakeProcessRunner()
        fake.onCommand("sh 'scripts/setup.sh'")

        val step = ScriptStep(file = "scripts/setup.sh")
        val outcome = runner(fake).run(step, OsFamily.LINUX)
        val ran = assertIs<ScriptOutcome.Ran>(outcome)
        assertEquals(ScriptStatus.DONE, ran.state.status)
        assertTrue("sh 'scripts/setup.sh'" in fake.executed)
    }

    @Test
    fun argsReachFileScriptAndCheck() {
        val fake = FakeProcessRunner()
        // Check receives args as positional params via `set --`; fails -> script runs.
        fake.onCommand("set -- fedora; test -f \$HOME/.ssh/\$1", exitCode = 1)
        fake.onCommand("sh 'scripts/setup-ssh.sh' fedora")

        val step = ScriptStep(file = "scripts/setup-ssh.sh", check = "test -f \$HOME/.ssh/\$1")
        val outcome = runner(fake).run(step, OsFamily.LINUX, args = "fedora")
        assertIs<ScriptOutcome.Ran>(outcome)
        assertTrue("sh 'scripts/setup-ssh.sh' fedora" in fake.executed)
    }

    @Test
    fun argsCheckPassingSkipsRun() {
        val fake = FakeProcessRunner()
        fake.onCommand("set -- fedora; test -f \$HOME/.ssh/\$1", exitCode = 0)
        val step = ScriptStep(file = "scripts/setup-ssh.sh", check = "test -f \$HOME/.ssh/\$1")
        assertIs<ScriptOutcome.AlreadyDone>(runner(fake).run(step, OsFamily.LINUX, args = "fedora"))
    }

    @Test
    fun recordsFailure() {
        val fake = FakeProcessRunner()
        fake.onCommand("false", exitCode = 1)
        val outcome = runner(fake).run(ScriptStep(run = "false"), OsFamily.LINUX)
        val ran = assertIs<ScriptOutcome.Ran>(outcome)
        assertEquals(ScriptStatus.FAILED, ran.state.status)
        assertEquals(1, ran.state.exitCode)
    }
}
