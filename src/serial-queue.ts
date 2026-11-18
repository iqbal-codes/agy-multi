/**
 * Runs blocking probes one at a time.
 *
 * Every probe in this project boots the official CLI, which talks to Google on
 * the account's behalf. Issuing them concurrently turns a status read into a
 * burst of requests across accounts, so all of them funnel through one queue:
 * at most one child process is alive at any moment, and repeated requests for
 * the same key join the probe that is already running.
 */
export interface SerialQueueOptions {
	/** Pause after every task so consecutive probes never land back to back. */
	spacingMs?: number;
}

export class SerialQueue {
	private tail: Promise<unknown> = Promise.resolve();
	private readonly pending = new Map<string, Promise<unknown>>();
	private readonly spacingMs: number;

	constructor(options: SerialQueueOptions = {}) {
		this.spacingMs = Math.max(0, options.spacingMs ?? 0);
	}

	/** Enqueue `task` behind everything already queued; the same key joins the running task. */
	run<T>(key: string, task: () => Promise<T>): Promise<T> {
		const existing = this.pending.get(key);
		if (existing) return existing as Promise<T>;
		const start = async (): Promise<T> => {
			try {
				return await task();
			} finally {
				this.pending.delete(key);
				if (this.spacingMs > 0) await new Promise(resolve => setTimeout(resolve, this.spacingMs));
			}
		};
		const promise = this.tail.then(start, start);
		this.pending.set(key, promise);
		this.tail = promise.then(
			() => undefined,
			() => undefined,
		);
		return promise;
	}

	/** Resolves once every task queued so far has settled. */
	async drain(): Promise<void> {
		await this.tail;
	}

	get size(): number {
		return this.pending.size;
	}
}
