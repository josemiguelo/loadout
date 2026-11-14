import type { Cmd, Msg } from "./messages.ts";

/**
 * Jobs runs the screen's background work: each job is a command (a promise
 * of its own), and what it resolves to is queued as a message for the model.
 * Only the program's update takes the queue and applies it, so every state
 * write happens in one place, in order.
 *
 * The first refresh starts before the program does, so the jobs run here,
 * not on the program: a job's message waits in the queue for whoever applies
 * next, and notify (set while the program runs) wakes its update.
 *
 * While a command runs in the run panel the jobs are HELD: nothing starts
 * beside it (`brew outdated` next to `brew upgrade`) or writes the state
 * file after it. A job asked for meanwhile is deferred to release, in order.
 */
export class Jobs {
  private queue: Msg[] = [];
  private running = 0;
  private held = false;
  private deferred: Cmd[] = [];
  private notify: (() => void) | undefined;

  /** start runs cmd in the background, or defers it while the jobs are held. */
  start(cmd: Cmd): void {
    if (this.held) {
      this.deferred.push(cmd);
      return;
    }
    this.running++;
    const finish = (msg: Msg) => {
      this.queue.push(msg);
      this.running--;
      this.notify?.();
    };
    let p: Promise<Msg>;
    try {
      p = cmd();
    } catch (e) {
      p = Promise.reject(e);
    }
    // A job words its own failures as its message; one that throws anyway
    // lands as nothing, so the count still comes down.
    p.then(finish, () => finish(null));
  }

  /**
   * post queues msg from inside a running job, before its own answer: a job
   * with several answers (the refresh's parts) lands each as it comes. The
   * job's final message always queues after everything it posted.
   */
  post(msg: Msg): void {
    this.queue.push(msg);
    this.notify?.();
  }

  /** busy says a job is still running (deferred ones don't count). */
  busy(): boolean {
    return this.running > 0;
  }

  /** hold stops new jobs from starting; the running ones finish. */
  hold(): void {
    this.held = true;
  }

  /** release lets jobs start again, the deferred ones first. */
  release(): void {
    this.held = false;
    const deferred = this.deferred;
    this.deferred = [];
    for (const cmd of deferred) this.start(cmd);
  }

  /** isHeld says the jobs are held. */
  isHeld(): boolean {
    return this.held;
  }

  /** take is every message queued so far, in the order the jobs finished. */
  take(): Msg[] {
    const queue = this.queue;
    this.queue = [];
    return queue;
  }

  /** setNotify is what a finished job calls, undefined for nothing. */
  setNotify(notify: (() => void) | undefined): void {
    this.notify = notify;
  }
}

/** newJobs is a runner with nothing running or held. */
export function newJobs(): Jobs {
  return new Jobs();
}
