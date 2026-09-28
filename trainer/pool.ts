// Fixed pool of worker_threads (one per core). Each worker loads the engine
// once and handles tasks sequentially; results come back in submit order.
import {Worker} from 'node:worker_threads';
import {availableParallelism} from 'node:os';

export interface Task {
  kind: string;
  [k: string]: unknown;
}

export class Pool {
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly queue: Array<{task: Task; resolve: (v: any) => void; reject: (e: Error) => void}> = [];
  private readonly busy = new Map<Worker, {resolve: (v: any) => void; reject: (e: Error) => void}>();

  constructor(size = availableParallelism()) {
    const url = new URL('./worker.ts', import.meta.url);
    for (let i = 0; i < size; i++) {
      const w = new Worker(url);
      w.on('message', (msg: {ok: boolean; value?: unknown; error?: string}) => {
        const job = this.busy.get(w)!;
        this.busy.delete(w);
        if (msg.ok) {
          job.resolve(msg.value);
        } else {
          job.reject(new Error(msg.error));
        }
        this.idle.push(w);
        this.pump();
      });
      w.on('error', (e: unknown) => {
        const job = this.busy.get(w);
        this.busy.delete(w);
        job?.reject(e instanceof Error ? e : new Error(String(e)));
      });
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  get size(): number {
    return this.workers.length;
  }

  run<T>(task: Task): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({task, resolve, reject});
      this.pump();
    });
  }

  private pump(): void {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop()!;
      const job = this.queue.shift()!;
      this.busy.set(w, job);
      w.postMessage(job.task);
    }
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}
