import type { PerformResponse, PrepareResponse } from '@shared/messages';
import type { FailureDetail } from '@shared/model/execution';
import type { Settings } from '@shared/model/recording';
import type { SetupAction } from '@shared/model/setup';
import type { Step, StepAction, StepCondition, TextMatch } from '@shared/model/step';
import { describeAssertion } from '@shared/steps';
import { AbortError, createId, describeMatch, errorMessage, matchesText, sleep } from '@shared/util';
import { StepError, type PlaybackDriver, type StepRunContext } from '../playback-engine/engine';
import { runCookieSetup } from './cookies';
import type { NavigationTracker } from './navigation-tracker';
import { findFrame, injectContentScript, sendToFrame } from './tabs';

/** How long to give a click to start a navigation before assuming it won't. */
const NAVIGATION_GRACE_MS = 60;
const MIN_NAVIGATION_TIMEOUT_MS = 30_000;
const URL_POLL_MS = 100;
const RETRY_DELAY_MS = 100;
/** Extra time beyond the step timeout before a silent page counts as frozen. */
const WATCHDOG_MARGIN_MS = 3_000;

const FROZEN_HINT =
  'A native alert or confirm dialog may be open. Answer it in the page, then retry. Recording the dialog lets playback answer it for you.';

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), timeoutMs);
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new AbortError());
    if (signal.aborted) onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Carries out steps in a real tab, on behalf of the playback engine. */
export class BrowserDriver implements PlaybackDriver {
  private dialogsHandled = 0;
  private dialogsAwaited = 0;
  private urlBeforeLastStep: string | undefined;

  constructor(
    private readonly tabId: number,
    private readonly navigation: NavigationTracker,
    private readonly settings: () => Settings,
  ) {}

  onDialogHandled(): void {
    this.dialogsHandled++;
  }

  async currentUrl(): Promise<string | undefined> {
    return (await browser.tabs.get(this.tabId)).url;
  }

  async showTarget(step: Step): Promise<void> {
    if (!step.target) return;
    const frameId = step.target.frames?.length ? await findFrame(this.tabId, step.target.frames) : 0;
    if (frameId === undefined) return;
    await sendToFrame(this.tabId, frameId, {
      type: 'highlight',
      target: step.target,
      testIdAttributes: this.settings().testIdAttributes,
    });
  }

  async runSetup(action: SetupAction, signal: AbortSignal): Promise<void> {
    const { cookieStoreId } = await browser.tabs.get(this.tabId);
    if (signal.aborted) throw new AbortError();
    await runCookieSetup(action, cookieStoreId);
  }

  async checkCondition(condition: StepCondition, signal: AbortSignal): Promise<boolean> {
    if (condition.kind === 'urlMatches') {
      return matchesText((await this.currentUrl()) ?? '', condition.match);
    }
    await this.navigation.settled(MIN_NAVIGATION_TIMEOUT_MS, signal);
    return sendToFrame<boolean>(this.tabId, 0, { type: 'evalCondition', condition });
  }

  async runStep(step: Step, context: StepRunContext): Promise<void> {
    const urlAtStart = await this.currentUrl().catch(() => undefined);
    try {
      await this.dispatch(step, context);
    } finally {
      this.urlBeforeLastStep = urlAtStart;
    }
  }

  private async dispatch(step: Step, context: StepRunContext): Promise<void> {
    const { action } = step;
    switch (action.type) {
      case 'navigate':
        await this.navigateTo(action.url, context);
        return;
      case 'reload':
        await this.navigateWith(() => browser.tabs.reload(this.tabId), 'Reload', context);
        return;
      case 'history':
        await this.navigateWith(
          () => (action.direction === 'back' ? browser.tabs.goBack(this.tabId) : browser.tabs.goForward(this.tabId)),
          `Going ${action.direction}`,
          context,
        );
        return;
      case 'urlChange':
        await this.waitForUrl(action.match, context);
        return;
      case 'runRecording':
        // Its steps follow in the plan. It only gets here if the recording is missing.
        throw new StepError({
          code: 'invalid-step',
          message: "The recording this step runs doesn't exist any more.",
          hint: 'Delete this step, or point it at another recording.',
        });
      case 'dialog':
        await this.waitForDialog(action, context);
        return;
      case 'wait':
        if (action.condition.kind === 'delay') {
          await sleep(action.condition.ms, context.signal);
          return;
        }
        if (action.condition.kind === 'url') {
          await this.waitForUrl(action.condition.match, context);
          return;
        }
        if (action.condition.kind === 'urlChanged') {
          await this.waitForUrlChange(context);
          return;
        }
        break;
      case 'assert':
        if (action.assertion.kind === 'url' || action.assertion.kind === 'title') {
          await this.assertTab(action, context);
          return;
        }
        break;
      default:
        break;
    }
    await this.runInPage(step, context);
  }

  /* ---------- Navigation ---------- */

  private async navigateTo(url: string, context: StepRunContext): Promise<void> {
    if (!/^(https?|file):/i.test(url) && !/^about:blank$/i.test(url)) {
      throw new StepError({
        code: 'navigation-failed',
        message: `Can't navigate to "${url}".`,
        hint: 'Use a full http or https address. If it contains a variable, check that it has a value.',
      });
    }
    await this.navigateWith(() => browser.tabs.update(this.tabId, { url }), `Loading ${url}`, context);
  }

  private async navigateWith(start: () => Promise<unknown>, label: string, context: StepRunContext): Promise<void> {
    const timeoutMs = Math.max(context.timeoutMs, MIN_NAVIGATION_TIMEOUT_MS);
    const load = this.navigation.nextLoad(timeoutMs, context.signal);
    try {
      await start();
      const finished = await load;
      if (!finished) {
        throw new StepError({ code: 'timeout', message: `${label} didn't finish within ${timeoutMs} ms.` });
      }
    } catch (error) {
      if (error instanceof StepError || error instanceof AbortError) throw error;
      throw new StepError({
        code: 'navigation-failed',
        message: `${label} failed: ${errorMessage(error)}`,
        hint: 'Check that the server is running and the address is right.',
      });
    }
  }

  private async pollUrl(check: (url: string) => boolean, context: StepRunContext): Promise<string | null> {
    const deadline = Date.now() + context.timeoutMs;
    let url = '';
    do {
      url = (await this.currentUrl()) ?? '';
      if (check(url)) return null;
      await sleep(URL_POLL_MS, context.signal);
    } while (Date.now() < deadline);
    return url;
  }

  private async waitForUrl(match: TextMatch, context: StepRunContext): Promise<void> {
    const actual = await this.pollUrl((url) => matchesText(url, match), context);
    if (actual === null) return;
    throw new StepError({
      code: 'timeout',
      message: `The URL didn't become ${describeMatch(match)} within ${context.timeoutMs} ms.`,
      expected: describeMatch(match),
      actual,
      hint: 'The previous step may not have led here. URLs with changing parts can use a regex match.',
    });
  }

  private async waitForUrlChange(context: StepRunContext): Promise<void> {
    const before = this.urlBeforeLastStep ?? (await this.currentUrl());
    const actual = await this.pollUrl((url) => url !== before, context);
    if (actual === null) return;
    throw new StepError({ code: 'timeout', message: `The URL stayed at ${actual} for ${context.timeoutMs} ms.` });
  }

  private async assertTab(action: Extract<StepAction, { type: 'assert' }>, context: StepRunContext): Promise<void> {
    const { assertion } = action;
    if (assertion.kind !== 'url' && assertion.kind !== 'title') return;
    const read = async () => {
      const tab = await browser.tabs.get(this.tabId);
      return (assertion.kind === 'url' ? tab.url : tab.title) ?? '';
    };
    const deadline = Date.now() + context.timeoutMs;
    let actual = await read();
    while (!matchesText(actual, assertion.match)) {
      if (Date.now() >= deadline) {
        throw new StepError({
          code: 'assertion-failed',
          message: `Assertion failed: expected ${describeAssertion(assertion)}, but it is "${actual}".`,
          expected: describeAssertion(assertion),
          actual,
        });
      }
      await sleep(URL_POLL_MS, context.signal);
      actual = await read();
    }
  }

  private async waitForDialog(action: Extract<StepAction, { type: 'dialog' }>, context: StepRunContext): Promise<void> {
    const deadline = Date.now() + context.timeoutMs;
    this.dialogsAwaited++;
    while (this.dialogsHandled < this.dialogsAwaited) {
      if (Date.now() >= deadline) {
        this.dialogsAwaited--;
        throw new StepError({
          code: 'timeout',
          message: `The page didn't open the expected ${action.kind} dialog within ${context.timeoutMs} ms.`,
          hint: 'Make this step optional if the dialog only appears sometimes.',
        });
      }
      await sleep(URL_POLL_MS, context.signal);
    }
  }

  /* ---------- Steps that run in the page ---------- */

  private async frameFor(step: Step, deadline: number, signal: AbortSignal): Promise<number> {
    const chain = step.target?.frames;
    if (!chain?.length) return 0;
    for (;;) {
      const frameId = await findFrame(this.tabId, chain);
      if (frameId !== undefined) return frameId;
      if (Date.now() >= deadline) {
        throw new StepError({
          code: 'element-not-found',
          message: `The frame ${chain.at(-1)!.url} isn't in the page.`,
          hint: 'The page may have changed. Check that the frame still loads from this address.',
        });
      }
      await sleep(RETRY_DELAY_MS, signal);
    }
  }

  private async armDialog(frameId: number, next: Step | undefined): Promise<void> {
    if (next?.action.type !== 'dialog' || next.execution === 'skip') return;
    const { accept, kind, promptText } = next.action;
    await sendToFrame(this.tabId, frameId, {
      type: 'armDialog',
      accept,
      kind,
      ...(promptText === undefined ? {} : { promptText }),
    });
  }

  private async reconnect(frameId: number): Promise<void> {
    try {
      await injectContentScript(this.tabId, frameId);
    } catch (error) {
      const message = errorMessage(error);
      if (/permission/i.test(message)) {
        throw new StepError({
          code: 'no-page-access',
          message: `The extension doesn't have access to this page. (${message})`,
        });
      }
      // Otherwise the document is probably mid-navigation, and the next attempt will tell.
    }
  }

  /**
   * Two-phase execution. `prepare` waits for the element and changes nothing, so it can
   * be retried freely when a navigation kills the content script. `perform` acts, and is
   * never retried: if the channel dies then, the action worked and the page moved on.
   */
  private async runInPage(step: Step, context: StepRunContext): Promise<void> {
    const { signal, timeoutMs } = context;
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;

    while (Date.now() <= deadline) {
      if (signal.aborted) throw new AbortError();
      await this.navigation.settled(Math.max(deadline - Date.now(), 0), signal);
      const frameId = await this.frameFor(step, deadline, signal);
      const token = createId();
      const remaining = Math.max(deadline - Date.now(), 0);

      let prepared: PrepareResponse;
      try {
        prepared = await abortable(
          withTimeout(
            sendToFrame<PrepareResponse>(this.tabId, frameId, { type: 'prepare', token, step, timeoutMs: remaining }),
            remaining + WATCHDOG_MARGIN_MS,
            () => new StepError({ code: 'page-unresponsive', message: "The page isn't responding.", hint: FROZEN_HINT }),
          ),
          signal,
        );
      } catch (error) {
        if (error instanceof StepError || error instanceof AbortError) throw error;
        lastError = error;
        await this.reconnect(frameId);
        await sleep(RETRY_DELAY_MS, signal);
        continue;
      }

      if (prepared.status === 'cancelled') throw new AbortError();
      if (prepared.status === 'failed') throw new StepError(prepared.failure);
      if (prepared.status === 'done') return;

      await this.armDialog(frameId, context.nextStep);

      const allowance = timeoutMs + WATCHDOG_MARGIN_MS + this.typingAllowance(step);
      let performed: PerformResponse;
      try {
        performed = await abortable(
          withTimeout(
            sendToFrame<PerformResponse>(this.tabId, frameId, { type: 'perform', token }),
            allowance,
            () => new StepError({ code: 'page-unresponsive', message: 'The page stopped responding during this step.', hint: FROZEN_HINT }),
          ),
          signal,
        );
      } catch (error) {
        if (error instanceof StepError || error instanceof AbortError) throw error;
        // The page went away while acting, which means the action caused a navigation.
        performed = { status: 'done' };
      }

      if (performed.status === 'failed') throw new StepError(performed.failure);
      if (performed.status === 'done') {
        await this.afterAction(signal);
        return;
      }
      await sleep(RETRY_DELAY_MS, signal);
    }

    throw new StepError(this.timeoutDetail(step, timeoutMs, lastError));
  }

  private typingAllowance(step: Step): number {
    return step.action.type === 'input' && step.action.typing === 'keystrokes' ? step.action.value.length * 50 : 0;
  }

  private timeoutDetail(step: Step, timeoutMs: number, lastError: unknown): FailureDetail {
    return {
      code: 'timeout',
      message: `Couldn't reach the page to run this step within ${timeoutMs} ms.`,
      ...(lastError ? { actual: errorMessage(lastError) } : {}),
      hint: step.target ? 'The page may still be loading, or it may have crashed.' : 'Try reloading the tab.',
    };
  }

  private async afterAction(signal: AbortSignal): Promise<void> {
    await sleep(NAVIGATION_GRACE_MS, signal);
    await this.navigation.settled(MIN_NAVIGATION_TIMEOUT_MS, signal);
  }
}
