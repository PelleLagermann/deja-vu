import type { PerformResponse, PlaybackConfig, PrepareRequest, PrepareResponse } from '@shared/messages';
import type { FailureDetail } from '@shared/model/execution';
import type { ElementTarget, SelectorAttempt } from '@shared/model/selector';
import {
  stepNeedsTarget,
  type Assertion,
  type RelativePoint,
  type Step,
  type StepAction,
  type StepCondition,
  type WaitCondition,
} from '@shared/model/step';
import { describeAssertion, describeWait } from '@shared/steps';
import { matchesText, normalizeWhitespace, truncate } from '@shared/util';
import {
  composedContains,
  collectRoots,
  deepActiveElement,
  deepElementFromPoint,
  isContentEditable,
  isDisabled,
  isVisible,
  queryAllDeep,
  resolveTarget,
  type ResolveResult,
} from '../../selector-engine';
import {
  dispatchClick,
  dispatchContextMenu,
  dispatchDoubleClick,
  dispatchDrag,
  dispatchHover,
  dispatchPointerMove,
  dispatchPress,
  dispatchRelease,
  focusElement,
} from './events';
import { fillContentEditable, fillField, pressKey, typeIntoField } from './keyboard';

const POLL_MS = 100;
const KEYSTROKE_DELAY_MS = 15;

interface Prepared {
  step: Step;
  element: Element | null;
  destination: Element | null;
}

export interface ExecutorHooks {
  /** Called just before an element is acted on, so it can be shown to the user. */
  flash?: (element: Element) => void;
}

class Cancelled extends Error {}

class StepFailed extends Error {
  readonly detail: FailureDetail;

  constructor(detail: FailureDetail) {
    super(detail.message);
    this.detail = detail;
  }
}

/** Resolves when `check` returns something other than null, re-checking on DOM changes. */
function waitFor<T>(check: () => T | null, timeoutMs: number, isCancelled: () => boolean): Promise<T | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let observer: MutationObserver | null = null;
    let timer: ReturnType<typeof setTimeout>;
    const deadline = Date.now() + timeoutMs;

    const finish = (value: T | null) => {
      settled = true;
      observer?.disconnect();
      clearTimeout(timer);
      resolve(value);
    };
    const attempt = () => {
      if (settled) return;
      if (isCancelled()) {
        settled = true;
        observer?.disconnect();
        clearTimeout(timer);
        reject(new Cancelled());
        return;
      }
      try {
        const value = check();
        if (value !== null) {
          finish(value);
          return;
        }
      } catch (error) {
        settled = true;
        observer?.disconnect();
        clearTimeout(timer);
        reject(error);
        return;
      }
      if (Date.now() >= deadline) {
        finish(null);
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(attempt, POLL_MS);
    };

    timer = setTimeout(attempt, POLL_MS);
    // Polling alone would catch changes too, this just gets there sooner. It's throttled
    // because pages can mutate thousands of times a second.
    let queued = false;
    observer = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      setTimeout(() => {
        queued = false;
        attempt();
      }, 16);
    });
    observer.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
    attempt();
  });
}

function centerOf(element: Element, offset?: RelativePoint): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width * (offset?.x ?? 0.5), y: rect.top + rect.height * (offset?.y ?? 0.5) };
}

function scrollIntoViewIfNeeded(element: Element): void {
  const rect = element.getBoundingClientRect();
  const inView =
    rect.top >= 0 && rect.left >= 0 && rect.bottom <= innerHeight && rect.right <= innerWidth;
  if (!inView) element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
}

function describeElement(element: Element): string {
  const id = element.id ? `#${element.id}` : '';
  const classes = [...element.classList].slice(0, 2).map((name) => `.${name}`).join('');
  return `<${element.tagName.toLowerCase()}${id}${classes}>`;
}

/** Why the element can't be acted on right now, or null if it can. */
function blockerFor(element: Element, action: StepAction): string | null {
  const needsVisible = !['select', 'check', 'file'].includes(action.type);
  if (needsVisible && !isVisible(element)) return 'it is not visible';
  if (action.type !== 'hover' && isDisabled(element)) return 'it is disabled';
  if (action.type === 'input' && (element as HTMLInputElement).readOnly) return 'it is read-only';
  return null;
}

/** Checks that a real click at this point would land on the element. */
function hitBlocker(element: Element, offset?: RelativePoint): string | null {
  const point = centerOf(element, offset);
  const hit = deepElementFromPoint(point.x, point.y, element.ownerDocument);
  if (!hit) return 'it is outside the viewport';
  if (composedContains(element, hit) || composedContains(hit, element)) return null;
  const label = hit.closest('label');
  if (label && (label as HTMLLabelElement).control === element) return null;
  return `it is covered by ${describeElement(hit)}`;
}

function pointerAction(action: StepAction): action is Extract<StepAction, { type: 'click' | 'doubleClick' | 'contextMenu' }> {
  return action.type === 'click' || action.type === 'doubleClick' || action.type === 'contextMenu';
}

/** Runs steps against the current document. One instance lives in each frame during playback. */
export class DomExecutor {
  private config: PlaybackConfig;
  private readonly hooks: ExecutorHooks;
  private prepared = new Map<string, Prepared>();
  private cancelled = false;

  constructor(config: PlaybackConfig, hooks: ExecutorHooks = {}) {
    this.config = config;
    this.hooks = hooks;
  }

  cancel(): void {
    this.cancelled = true;
    this.prepared.clear();
  }

  private readonly isCancelled = () => this.cancelled;

  private resolve(target: ElementTarget): ResolveResult {
    return resolveTarget(target, { testIdAttributes: this.config.testIdAttributes });
  }

  /* ---------- Prepare: wait until ready. Has no side effects. ---------- */

  async prepare(request: PrepareRequest): Promise<PrepareResponse> {
    this.cancelled = false;
    const { step, timeoutMs, token } = request;
    try {
      if (step.action.type === 'wait') return await this.runWait(step, timeoutMs);
      if (step.action.type === 'assert') return await this.runAssert(step, timeoutMs);

      const deadline = Date.now() + timeoutMs;
      await this.waitForLoading(step, timeoutMs);

      if (!step.target) {
        if (stepNeedsTarget(step.action)) {
          return {
            status: 'failed',
            failure: {
              code: 'invalid-step',
              message: 'This step has no target element.',
              hint: 'Open the step and use "Pick element" to choose one.',
            },
          };
        }
        this.prepared.set(token, { step, element: null, destination: null });
        return { status: 'ready', attempts: [] };
      }

      const located = await this.locate(step, step.target, deadline - Date.now());
      if ('failure' in located) return { status: 'failed', failure: located.failure };

      let destination: Element | null = null;
      if (step.action.type === 'dragDrop') {
        const end = await this.locate(step, step.action.destination, deadline - Date.now());
        if ('failure' in end) return { status: 'failed', failure: end.failure };
        destination = end.element;
      }

      this.prepared.set(token, { step, element: located.element, destination });
      return { status: 'ready', attempts: located.attempts };
    } catch (error) {
      if (error instanceof Cancelled) return { status: 'cancelled' };
      if (error instanceof StepFailed) return { status: 'failed', failure: error.detail };
      throw error;
    }
  }

  private async waitForLoading(step: Step, timeoutMs: number): Promise<void> {
    const selectors = [...this.config.loadingSelectors];
    const mustClear = step.wait.waitForGone;
    if (mustClear) selectors.push(mustClear);
    if (selectors.length === 0) return;
    const css = selectors.join(',');
    const clear = () => {
      const roots = collectRoots(document);
      return queryAllDeep(css, roots).some(isVisible) ? null : true;
    };
    const finished = await waitFor(clear, timeoutMs, this.isCancelled);
    if (!finished && mustClear) {
      throw new StepFailed({
        code: 'timeout',
        message: `${mustClear} was still visible after ${timeoutMs} ms.`,
        hint: 'Increase the timeout, or check why the page is stuck loading.',
      });
    }
  }

  private async locate(
    step: Step,
    target: ElementTarget,
    timeoutMs: number,
  ): Promise<{ element: Element; attempts: SelectorAttempt[] } | { failure: FailureDetail }> {
    let last: ResolveResult = { element: null, attempts: [], resolvedBy: null };
    let blocker: string | null = null;
    let lastRect: DOMRect | null = null;

    const ready = await waitFor(
      () => {
        last = this.resolve(target);
        const element = last.element;
        if (!element) {
          blocker = null;
          return null;
        }
        if (step.wait.force) return element;
        blocker = blockerFor(element, step.action);
        if (blocker) return null;

        if (pointerAction(step.action) || step.action.type === 'dragDrop' || step.action.type === 'hover') {
          scrollIntoViewIfNeeded(element);
          // An element that's still animating would be missed by the click that follows.
          const rect = element.getBoundingClientRect();
          const moved = !lastRect || rect.x !== lastRect.x || rect.y !== lastRect.y;
          lastRect = rect;
          if (moved) {
            blocker = 'it is still moving';
            return null;
          }
          const offset = pointerAction(step.action) ? step.action.offset : undefined;
          blocker = hitBlocker(element, offset);
          if (blocker) return null;
        }
        return element;
      },
      Math.max(timeoutMs, 0),
      this.isCancelled,
    );

    if (ready) return { element: ready, attempts: last.attempts };
    return { failure: this.locateFailure(target, last, blocker, timeoutMs) };
  }

  private locateFailure(
    target: ElementTarget,
    result: ResolveResult,
    blocker: string | null,
    timeoutMs: number,
  ): FailureDetail {
    if (blocker) {
      return {
        code: 'not-actionable',
        message: `Found ${target.summary}, but ${blocker} (waited ${timeoutMs} ms).`,
        attempts: result.attempts,
        hint: 'Add a wait for whatever is in the way, or enable "Force" to skip these checks.',
      };
    }
    const ambiguous = result.attempts.find((attempt) => attempt.verdict === 'ambiguous');
    if (ambiguous) {
      return {
        code: 'element-ambiguous',
        message: `Several elements could be ${target.summary}, and none could be picked with confidence.`,
        attempts: result.attempts,
        hint: 'Edit the selectors to make one of them unique, or add a test ID to the element.',
      };
    }
    return {
      code: 'element-not-found',
      message: `Couldn't find ${target.summary} within ${timeoutMs} ms.`,
      attempts: result.attempts,
      hint: 'Check that the page is in the expected state. If the element changed, update its selectors.',
    };
  }

  /* ---------- Waits and assertions ---------- */

  private async runWait(step: Step, timeoutMs: number): Promise<PrepareResponse> {
    const condition = (step.action as Extract<StepAction, { type: 'wait' }>).condition;
    const met = await waitFor(() => (this.waitConditionMet(step, condition) ? true : null), timeoutMs, this.isCancelled);
    if (met) return { status: 'done' };
    return {
      status: 'failed',
      failure: {
        code: 'timeout',
        message: `Timed out after ${timeoutMs} ms waiting until ${describeWait(condition)}.`,
        hint: 'Increase the timeout on this step, or check the condition.',
      },
    };
  }

  private waitConditionMet(step: Step, condition: WaitCondition): boolean {
    const element = () => (step.target ? this.resolve(step.target).element : null);
    switch (condition.kind) {
      case 'exists':
        return element() !== null;
      case 'visible': {
        const found = element();
        return found !== null && isVisible(found);
      }
      case 'enabled': {
        const found = element();
        return found !== null && !isDisabled(found);
      }
      case 'hidden': {
        const found = element();
        return found === null || !isVisible(found);
      }
      case 'gone':
        return element() === null;
      case 'text':
        return matchesText(document.body?.innerText ?? '', condition.match);
      case 'loadingGone':
        return !queryAllDeep(condition.selector, collectRoots(document)).some(isVisible);
      default:
        // URL conditions and delays are handled by the background page.
        return true;
    }
  }

  private async runAssert(step: Step, timeoutMs: number): Promise<PrepareResponse> {
    const { assertion } = step.action as Extract<StepAction, { type: 'assert' }>;
    let actual = '';
    let attempts: SelectorAttempt[] = [];
    const passed = await waitFor(
      () => {
        const outcome = this.evaluateAssertion(step, assertion);
        actual = outcome.actual;
        attempts = outcome.attempts;
        return outcome.passed ? true : null;
      },
      timeoutMs,
      this.isCancelled,
    );
    if (passed) return { status: 'done', attempts };
    return {
      status: 'failed',
      failure: {
        code: 'assertion-failed',
        message: `Assertion failed: expected ${describeAssertion(assertion)}, but ${actual}.`,
        expected: describeAssertion(assertion),
        actual,
        attempts,
      },
    };
  }

  private evaluateAssertion(
    step: Step,
    assertion: Assertion,
  ): { passed: boolean; actual: string; attempts: SelectorAttempt[] } {
    if (assertion.kind === 'count') {
      const count = queryAllDeep(assertion.selector, collectRoots(document)).length;
      return { passed: count === assertion.expected, actual: `found ${count}`, attempts: [] };
    }

    if (!step.target) {
      if (assertion.kind === 'text') {
        const text = document.body?.innerText ?? '';
        return {
          passed: matchesText(text, assertion.match),
          actual: 'the page has no such text',
          attempts: [],
        };
      }
      return { passed: false, actual: 'the step has no target element', attempts: [] };
    }

    const { element, attempts } = this.resolve(step.target);
    const verdict = (passed: boolean, actual: string) => ({ passed, actual, attempts });

    if (assertion.kind === 'notExists') {
      return verdict(element === null, 'the element exists');
    }
    if (assertion.kind === 'hidden') {
      return verdict(element === null || !isVisible(element), 'the element is visible');
    }
    if (!element) return verdict(false, 'the element was not found');

    switch (assertion.kind) {
      case 'exists':
        return verdict(true, '');
      case 'visible':
        return verdict(isVisible(element), 'the element is not visible');
      case 'text': {
        const text = normalizeWhitespace((element as HTMLElement).innerText ?? element.textContent ?? '');
        return verdict(matchesText(text, assertion.match), `the text is "${truncate(text, 80)}"`);
      }
      case 'value': {
        const value = (element as HTMLInputElement).value ?? '';
        return verdict(matchesText(value, assertion.match), `the value is "${truncate(value, 80)}"`);
      }
      case 'checked':
        return verdict((element as HTMLInputElement).checked === true, 'it is not checked');
      case 'unchecked':
        return verdict((element as HTMLInputElement).checked !== true, 'it is checked');
      default:
        return verdict(false, `"${assertion.kind}" can't be checked in the page`);
    }
  }

  evaluateCondition(condition: StepCondition): boolean {
    switch (condition.kind) {
      case 'elementExists':
        return queryAllDeep(condition.selector, collectRoots(document)).length > 0;
      case 'elementMissing':
        return queryAllDeep(condition.selector, collectRoots(document)).length === 0;
      case 'urlMatches':
        return matchesText(location.href, condition.match);
      case 'variableEquals':
        return true;
    }
  }

  /* ---------- Perform: act. Never retried. ---------- */

  async perform(token: string): Promise<PerformResponse> {
    const prepared = this.prepared.get(token);
    if (!prepared) return { status: 'stale' };
    this.prepared.delete(token);
    const { element, step } = prepared;
    if (element && !element.isConnected) return { status: 'stale' };
    try {
      if (element && this.config.highlight) this.hooks.flash?.(element);
      await this.act(prepared);
      return { status: 'done' };
    } catch (error) {
      if (error instanceof StepFailed) return { status: 'failed', failure: error.detail };
      return {
        status: 'failed',
        failure: {
          code: 'action-failed',
          message: `The ${step.action.type} action threw an error: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
  }

  private async act({ step, element, destination }: Prepared): Promise<void> {
    const { action } = step;
    switch (action.type) {
      case 'click':
      case 'doubleClick':
      case 'contextMenu':
        this.pointer(element!, action);
        return;
      case 'hover':
        scrollIntoViewIfNeeded(element!);
        dispatchHover(element!, centerOf(element!));
        return;
      case 'input':
        await this.input(element as HTMLElement, action);
        return;
      case 'select':
        this.select(element as HTMLSelectElement, action);
        return;
      case 'check':
        this.check(element as HTMLInputElement, action.checked);
        return;
      case 'keyPress': {
        const receiver = element ?? deepActiveElement() ?? document.body;
        if (element) focusElement(element as HTMLElement);
        pressKey(receiver, action.key, action.code, action.modifiers);
        return;
      }
      case 'scroll':
        if (element) element.scrollTo({ left: action.x, top: action.y, behavior: 'instant' });
        else window.scrollTo({ left: action.x, top: action.y, behavior: 'instant' });
        return;
      case 'dragDrop':
        if (action.mode === 'html5') this.dragHtml5(element!, destination!, action);
        else await this.dragPointer(element!, destination!, action);
        return;
      default:
        throw new StepFailed({ code: 'invalid-step', message: `"${action.type}" can't run in the page.` });
    }
  }

  private pointer(element: Element, action: Extract<StepAction, { type: 'click' | 'doubleClick' | 'contextMenu' }>): void {
    const point = centerOf(element, action.offset);
    const { modifiers } = action;
    dispatchHover(element, point);
    if (action.type === 'contextMenu') {
      dispatchContextMenu(element, point, modifiers);
      return;
    }
    const pressOnce = (detail: number) => {
      dispatchPress(element, point, modifiers, detail);
      if (detail === 1 && element instanceof HTMLElement) focusElement(element);
      dispatchRelease(element, point, modifiers, detail);
      dispatchClick(element, point, modifiers, detail);
    };
    pressOnce(1);
    if (action.type === 'doubleClick') {
      pressOnce(2);
      dispatchDoubleClick(element, point, modifiers);
    }
  }

  private async input(element: HTMLElement, action: Extract<StepAction, { type: 'input' }>): Promise<void> {
    focusElement(element);
    if (isContentEditable(element) && !('value' in element)) {
      fillContentEditable(element, action.value);
      return;
    }
    const field = element as HTMLInputElement | HTMLTextAreaElement;
    if (!('value' in field)) {
      throw new StepFailed({
        code: 'action-failed',
        message: `${describeElement(element)} doesn't accept text input.`,
      });
    }
    if (action.typing === 'keystrokes') await typeIntoField(field, action.value, KEYSTROKE_DELAY_MS);
    else fillField(field, action.value);
  }

  private select(select: HTMLSelectElement, action: Extract<StepAction, { type: 'select' }>): void {
    if (select.tagName !== 'SELECT') {
      throw new StepFailed({ code: 'action-failed', message: `${describeElement(select)} is not a select element.` });
    }
    const options = [...select.options];
    const matching = options.filter(
      (option) => action.values.includes(option.value) || action.labels.includes(option.label || option.text),
    );
    if (matching.length === 0 && action.values.length > 0) {
      const available = options.slice(0, 10).map((option) => option.label || option.text).join(', ');
      throw new StepFailed({
        code: 'action-failed',
        message: `No option matches "${action.labels.join(', ') || action.values.join(', ')}".`,
        actual: `Available: ${available}`,
        hint: 'The options may load later. Add a wait step before this one, or update the value.',
      });
    }
    focusElement(select);
    for (const option of options) option.selected = matching.includes(option);
    select.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  private check(input: HTMLInputElement, checked: boolean): void {
    if (input.checked === checked) return;
    // A real click runs the browser's toggle and the page's handlers in the right order.
    input.click();
    if (input.checked !== checked) {
      throw new StepFailed({
        code: 'action-failed',
        message: `${describeElement(input)} stayed ${input.checked ? 'checked' : 'unchecked'} after clicking it.`,
        hint: 'The page may be preventing the change. Check for validation or a disabled state.',
      });
    }
  }

  private dragHtml5(source: Element, destination: Element, action: Extract<StepAction, { type: 'dragDrop' }>): void {
    const from = centerOf(source, action.fromOffset);
    const to = centerOf(destination, action.toOffset);
    const data = new DataTransfer();
    dispatchPress(source, from);
    dispatchDrag(source, 'dragstart', from, data);
    dispatchDrag(source, 'drag', from, data);
    dispatchDrag(destination, 'dragenter', to, data);
    dispatchDrag(destination, 'dragover', to, data);
    dispatchDrag(destination, 'drop', to, data);
    dispatchDrag(source, 'dragend', to, data);
  }

  private async dragPointer(source: Element, destination: Element, action: Extract<StepAction, { type: 'dragDrop' }>): Promise<void> {
    const from = centerOf(source, action.fromOffset);
    const to = centerOf(destination, action.toOffset);
    dispatchHover(source, from);
    dispatchPress(source, from);
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      const point = { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps };
      const under = deepElementFromPoint(point.x, point.y) ?? destination;
      dispatchPointerMove(under, point);
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
    dispatchRelease(destination, to);
    if (destination === source) dispatchClick(source, to);
  }
}
