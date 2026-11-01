/**
 * Bounded render job lifecycle for the MCP server (Task 15).
 *
 * The queue applies the already-resolved `McpServerConfig.jobs` bounds to
 * `render_song` calls:
 *
 * - at most `maxConcurrentRenders` renders execute at once;
 * - at most `maxPendingJobs` additional renders may wait for a slot, and a
 *   request beyond that is rejected as busy instead of growing an unbounded
 *   queue;
 * - each executing render gets a `renderTimeoutMs` wall-clock deadline;
 * - every job owns one `AbortController`, aborted by its timeout, by client
 *   request cancellation, and by server shutdown, so `renderSongArtifacts`
 *   removes the job directory and stops native children at its next boundary.
 *
 * Success is never reported before files are ready: `submit()` resolves with the
 * operation value only after the operation settles. The one early return is the
 * timeout path, which reports `timeout` while the aborted render keeps its slot
 * until it finishes unwinding, because an in-flight native backend call does
 * finish before boundary cleanup.
 *
 * Slot accounting is synchronous: a promoted waiting job starts in the same tick
 * that released the previous slot, so `maxConcurrentRenders` is a hard bound.
 */

import type { McpJobSettings } from './config.js';

/** Machine-readable lifecycle rejections, mapped to tool error codes by the tool. */
export type RenderJobRejection =
  | {
      readonly status: 'busy' | 'closed';
      readonly running: number;
      readonly queued: number;
      readonly maxConcurrentRenders: number;
      readonly maxPendingJobs: number;
    }
  | { readonly status: 'timeout'; readonly timeoutMs: number; readonly elapsedMs: number }
  | { readonly status: 'cancelled'; readonly elapsedMs: number };

export type RenderJobResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
      readonly elapsedMs: number;
      readonly queuedMs: number;
    }
  | { readonly ok: false; readonly rejection: RenderJobRejection };

const TIMEOUT_MARKER = 'timeout' as const;

type OperationOutcome =
  | { readonly kind: 'value'; readonly value: unknown }
  | { readonly kind: 'error'; readonly error: unknown };

/**
 * One queued render with the value type erased, so the queue can hold
 * heterogeneous jobs. `submit` restores the caller's type on the way out.
 */
interface QueuedJob {
  readonly submittedAt: number;
  readonly operation: (signal: AbortSignal) => Promise<unknown>;
  readonly requestSignal: AbortSignal | undefined;
  readonly resolve: (result: RenderJobResult<unknown>) => void;
  readonly reject: (error: unknown) => void;
  /** Listener registered while this job waits for a slot. */
  readonly abortWhileWaiting: () => void;
}

interface RunningJob {
  readonly controller: AbortController;
  readonly startedAt: number;
  readonly abortFromRequest: () => void;
  timer: NodeJS.Timeout | undefined;
}

/** Read `aborted` through a function so control-flow analysis cannot freeze it. */
function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * One bounded FIFO queue plus a semaphore, shared by every `render_song` call on
 * a server instance. All mutation happens on the Node.js event loop, so no
 * additional locking is required.
 */
export class RenderJobQueue {
  private readonly running: RunningJob[] = [];
  private readonly waiting: QueuedJob[] = [];
  private closing = false;

  constructor(private readonly settings: McpJobSettings) {}

  get maxConcurrentRenders(): number {
    return this.settings.maxConcurrentRenders;
  }

  get maxPendingJobs(): number {
    return this.settings.maxPendingJobs;
  }

  get renderTimeoutMs(): number {
    return this.settings.renderTimeoutMs;
  }

  /** Renders executing now, including aborted renders that are still unwinding. */
  get activeCount(): number {
    return this.running.length;
  }

  /** Renders waiting for an execution slot. */
  get waitingCount(): number {
    return this.waiting.length;
  }

  get isClosing(): boolean {
    return this.closing;
  }

  /**
   * Run one render under the configured bounds.
   *
   * `operation` receives the job signal and must honour it: the engine checks it
   * between tracks, stem captures, artifact writes, and publishes.
   * `requestSignal` is the MCP request cancellation signal, when the transport
   * provides one.
   */
  async submit<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    requestSignal?: AbortSignal,
  ): Promise<RenderJobResult<T>> {
    const submittedAt = Date.now();
    if (this.closing) {
      return { ok: false, rejection: this.capacityRejection('closed') };
    }
    if (aborted(requestSignal)) {
      return { ok: false, rejection: { status: 'cancelled', elapsedMs: 0 } };
    }

    const result = await new Promise<RenderJobResult<unknown>>((resolve, reject) => {
      const job: QueuedJob = {
        submittedAt,
        operation: (signal) => operation(signal),
        requestSignal,
        resolve,
        reject,
        abortWhileWaiting: () => {
          this.forget(job);
          resolve({
            ok: false,
            rejection: { status: 'cancelled', elapsedMs: Date.now() - submittedAt },
          });
        },
      };
      if (this.running.length < this.settings.maxConcurrentRenders) {
        this.start(job);
        return;
      }
      if (this.waiting.length >= this.settings.maxPendingJobs) {
        resolve({ ok: false, rejection: this.capacityRejection('busy') });
        return;
      }
      requestSignal?.addEventListener('abort', job.abortWhileWaiting, { once: true });
      this.waiting.push(job);
    });

    return result as RenderJobResult<T>;
  }

  /**
   * Abort every waiting and running render (the server shutdown path) so native
   * children and job output directories are cleaned up at the engine's next
   * boundary instead of being orphaned by process exit. Waiting renders are
   * rejected so their callers get an actionable result instead of hanging.
   */
  abortAll(): void {
    this.closing = true;
    for (const job of this.waiting.splice(0, this.waiting.length)) {
      job.requestSignal?.removeEventListener('abort', job.abortWhileWaiting);
      job.resolve({ ok: false, rejection: this.capacityRejection('closed') });
    }
    for (const job of [...this.running]) {
      if (job.timer !== undefined) {
        clearTimeout(job.timer);
        job.timer = undefined;
      }
      job.controller.abort();
    }
  }

  /**
   * Wait up to `deadlineMs` for unwinding renders so shutdown can complete their
   * cleanup before the process exits. An in-flight native backend call finishes
   * first; when the deadline passes the caller stops waiting and the process
   * force timer remains the last backstop.
   */
  async settleActive(deadlineMs: number): Promise<void> {
    const startedAt = Date.now();
    while (this.running.length > 0 && Date.now() - startedAt < deadlineMs) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  private capacityRejection(status: 'busy' | 'closed'): RenderJobRejection {
    return {
      status,
      running: this.running.length,
      queued: this.waiting.length,
      maxConcurrentRenders: this.settings.maxConcurrentRenders,
      maxPendingJobs: this.settings.maxPendingJobs,
    };
  }

  private forget(job: QueuedJob): void {
    const index = this.waiting.indexOf(job);
    if (index >= 0) {
      this.waiting.splice(index, 1);
    }
  }

  /** Occupy a slot synchronously and begin the render. */
  private start(job: QueuedJob): void {
    const running: RunningJob = {
      controller: new AbortController(),
      startedAt: Date.now(),
      abortFromRequest: () => running.controller.abort(),
      timer: undefined,
    };
    this.running.push(running);
    job.requestSignal?.addEventListener('abort', running.abortFromRequest, { once: true });

    const operation = job.operation(running.controller.signal).then(
      (value): OperationOutcome => ({ kind: 'value', value }),
      (error: unknown): OperationOutcome => ({ kind: 'error', error }),
    );
    const deadline = new Promise<typeof TIMEOUT_MARKER>((resolve) => {
      running.timer = setTimeout(() => {
        running.controller.abort();
        resolve(TIMEOUT_MARKER);
      }, this.settings.renderTimeoutMs);
    });

    void Promise.race([operation, deadline]).then((outcome) => {
      this.finish(job, running, outcome, operation);
    });
  }

  private finish(
    job: QueuedJob,
    running: RunningJob,
    outcome: OperationOutcome | typeof TIMEOUT_MARKER,
    operation: Promise<OperationOutcome>,
  ): void {
    if (running.timer !== undefined) {
      clearTimeout(running.timer);
      running.timer = undefined;
    }
    job.requestSignal?.removeEventListener('abort', running.abortFromRequest);
    const elapsedMs = Date.now() - job.submittedAt;

    if (outcome === TIMEOUT_MARKER) {
      // The deadline is reported now, but the aborted render keeps its slot
      // until it unwinds, because the concurrency bound is still real.
      void operation.then(() => {
        this.release(running);
      });
      job.resolve({
        ok: false,
        rejection: {
          status: 'timeout',
          timeoutMs: this.settings.renderTimeoutMs,
          elapsedMs,
        },
      });
      return;
    }

    this.release(running);

    if (aborted(job.requestSignal)) {
      job.resolve({ ok: false, rejection: { status: 'cancelled', elapsedMs } });
      return;
    }
    if (this.closing && aborted(running.controller.signal)) {
      job.resolve({ ok: false, rejection: { status: 'cancelled', elapsedMs } });
      return;
    }
    if (outcome.kind === 'error') {
      job.reject(outcome.error);
      return;
    }
    job.resolve({
      ok: true,
      value: outcome.value,
      elapsedMs,
      queuedMs: running.startedAt - job.submittedAt,
    });
  }

  private release(running: RunningJob): void {
    const index = this.running.indexOf(running);
    if (index >= 0) {
      this.running.splice(index, 1);
    }
    this.drain();
  }

  private drain(): void {
    while (this.running.length < this.settings.maxConcurrentRenders && this.waiting.length > 0) {
      const next = this.waiting.shift();
      if (next === undefined) {
        return;
      }
      next.requestSignal?.removeEventListener('abort', next.abortWhileWaiting);
      if (this.closing) {
        next.resolve({ ok: false, rejection: this.capacityRejection('closed') });
        continue;
      }
      // `start` occupies the slot in the same tick, so the bound holds.
      this.start(next);
    }
  }
}
