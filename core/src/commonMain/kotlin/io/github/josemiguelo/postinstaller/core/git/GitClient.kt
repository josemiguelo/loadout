package io.github.josemiguelo.postinstaller.core.git

import io.github.josemiguelo.postinstaller.core.exec.ExecResult
import io.github.josemiguelo.postinstaller.core.exec.ProcessRunner
import okio.Path

class GitException(message: String) : Exception(message)

/** Thin wrapper over the `git` binary, always operating on the config repo. */
class GitClient(
    private val runner: ProcessRunner,
    private val repoRoot: Path,
) {
    private fun git(args: String): ExecResult =
        runner.capture("git $args", workDir = repoRoot.toString())

    private fun require(result: ExecResult, what: String): ExecResult {
        if (!result.success) {
            val detail = result.stderr.trim().ifEmpty { result.stdout.trim() }
            throw GitException("git $what failed (exit ${result.exitCode}): $detail")
        }
        return result
    }

    fun isRepo(): Boolean = git("rev-parse --is-inside-work-tree").success

    fun hasUpstream(): Boolean = git("rev-parse --abbrev-ref @{upstream}").success

    fun init() {
        require(git("init"), "init")
    }

    fun pullRebase() {
        require(git("pull --rebase --autostash"), "pull")
    }

    /** Stage [path] and commit; returns false if there was nothing to commit. */
    fun addCommit(path: String, message: String): Boolean {
        require(git("add '$path'"), "add")
        if (git("diff --cached --quiet").success) return false
        require(git("commit -m '${message.replace("'", "'\\''")}'"), "commit")
        return true
    }

    fun push() {
        require(git("push"), "push")
    }
}
