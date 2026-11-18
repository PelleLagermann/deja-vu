import { AbortError } from '@shared/util';

interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

/** Follows the load state of one tab's top frame, fed by webNavigation events. */
export class NavigationTracker {
  private loading = false;
  private settledWaiters = new Set<Waiter>();
  private nextLoadWaiters = new Set<Waiter>();
  /** Waiters whose navigation has begun. Load events from earlier navigations don't count for the rest. */
  private startedLoadWaiters = new Set<Waiter>();

  onBeforeNavigate(): void {
    this.loading = true;
    for (const waiter of this.nextLoadWaiters) this.startedLoadWaiters.add(waiter);
  }

  /** The new document is parsed, so a content script can work with it. */
  onLoaded(): void {
    this.loading = false;
    this.release(this.settledWaiters);
    this.release(this.startedLoadWaiters);
  }

  /**
   * Firefox cancels and restarts a load when it moves a page to another process, so this
   * isn't a failure. If nothing follows, whoever is waiting reaches their timeout.
   */
  onAborted(): void {
    this.loading = false;
    this.release(this.settledWaiters);
  }

  /** Same-document navigation. Nothing needs to load, but it does count as arriving. */
  onSameDocument(): void {
    this.release(new Set(this.nextLoadWaiters));
  }

  onError(message: string): void {
    this.loading = false;
    this.release(this.settledWaiters);
    for (const waiter of [...this.nextLoadWaiters]) waiter.reject(new Error(message));
  }

  private release(waiters: Set<Waiter>): void {
    for (const waiter of [...waiters]) waiter.resolve();
    waiters.clear();
  }

  private wait(waiters: Set<Waiter>, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        reject(new AbortError());
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        waiters.delete(waiter);
        this.startedLoadWaiters.delete(waiter);
      };
      const waiter: Waiter = {
        resolve: () => {
          cleanup();
          resolve(true);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);
      signal.addEventListener('abort', onAbort, { once: true });
      waiters.add(waiter);
    });
  }

  /** Resolves once the tab isn't loading. Returns false if it still is at the timeout. */
  async settled(timeoutMs: number, signal: AbortSignal): Promise<boolean> {
    if (!this.loading) return true;
    return this.wait(this.settledWaiters, timeoutMs, signal);
  }

  /** Call before starting a navigation, then await the result once it has been started. */
  nextLoad(timeoutMs: number, signal: AbortSignal): Promise<boolean> {
    return this.wait(this.nextLoadWaiters, timeoutMs, signal);
  }
}
