import type { BuildRequest, BuildResult } from '../workers/meshWorker';

/** Round-robin pool of geometry workers with promise-based requests. */
export class WorkerPool {
  private workers: Worker[] = [];
  private pending = new Map<number, (r: BuildResult) => void>();
  private next = 0;
  private seq = 1;

  constructor(size = Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 4) - 1))) {
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL('../workers/meshWorker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<BuildResult>) => {
        const cb = this.pending.get(e.data.id);
        this.pending.delete(e.data.id);
        cb?.(e.data);
      };
      this.workers.push(w);
    }
  }

  build(req: Omit<BuildRequest, 'id'>): Promise<BuildResult> {
    const id = this.seq++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.workers[this.next++ % this.workers.length].postMessage({ ...req, id });
    });
  }
}
