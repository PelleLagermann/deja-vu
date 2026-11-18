import type { StepDraft } from '@shared/messages';
import type { Settings } from '@shared/model/recording';
import type { Step, StepAction } from '@shared/model/step';
import { newStep } from '@shared/steps';
import { redactUrl, sleep, urlToMatch } from '@shared/util';
import type { Storage } from '../storage-engine';
import { frameChain } from './tabs';

export interface RecordingSessionState {
  recordingId: string;
  tabId: number;
  /** Where the next step goes. Null appends. */
  insertAt: number | null;
  stepCount: number;
  history: string[];
  historyIndex: number;
  lastInteractionAt: number;
}

/** A navigation this long after the last step isn't something that step caused. */
const CAUSED_BY_STEP_WINDOW_MS = 5_000;
/** Navigation events can overtake the message about the click that caused them. */
const NAVIGATION_SETTLE_MS = 40;

export interface CommittedNavigation {
  url: string;
  transitionType: string;
  transitionQualifiers: string[];
}

/**
 * Decides what a top-level navigation means for the recording. Exported for testing.
 * Null means it needs no step of its own.
 */
export function classifyNavigation(
  navigation: CommittedNavigation,
  state: Pick<RecordingSessionState, 'history' | 'historyIndex' | 'lastInteractionAt'>,
  now: number,
): StepAction | null {
  const { url, transitionType, transitionQualifiers } = navigation;
  const current = state.history[state.historyIndex];

  if (transitionQualifiers.includes('forward_back')) {
    if (state.history[state.historyIndex - 1] === url) return { type: 'history', direction: 'back' };
    if (state.history[state.historyIndex + 1] === url) return { type: 'history', direction: 'forward' };
    return { type: 'navigate', url };
  }
  if (transitionType === 'reload') return { type: 'reload' };

  const typed =
    transitionQualifiers.includes('from_address_bar') ||
    ['typed', 'auto_bookmark', 'generated', 'keyword', 'keyword_generated', 'start_page'].includes(transitionType);
  if (typed) return { type: 'navigate', url };

  if (url === current) return null;

  const redirected = transitionQualifiers.includes('client_redirect') || transitionQualifiers.includes('server_redirect');
  const causedByStep = now - state.lastInteractionAt <= CAUSED_BY_STEP_WINDOW_MS;
  if (redirected || causedByStep) return { type: 'urlChange', match: urlToMatch(url) };
  return { type: 'navigate', url };
}

/** Writes recorded steps to storage as they arrive, in the order they arrived. */
export class RecordingSession {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly state: RecordingSessionState,
    private readonly storage: Storage,
    private readonly settings: () => Settings,
    private readonly onChange: () => void,
    private readonly persist: () => void,
  ) {}

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task, task);
    this.queue = run.catch((error: unknown) => console.error('Déjà Vu: failed to save a recorded step', error));
    return run;
  }

  /** Resolves once everything received so far has been stored. */
  drain(): Promise<unknown> {
    return this.queue;
  }

  private async toStep(draft: StepDraft, frameId: number): Promise<Step> {
    const step = newStep(draft.action, {
      execution: draft.execution ?? 'required',
      ...(draft.target ? { target: draft.target } : {}),
    });
    if (frameId !== 0) {
      const chain = await frameChain(this.state.tabId, frameId);
      if (step.target) step.target = { ...step.target, frames: chain };
      if (step.action.type === 'dragDrop') {
        step.action = { ...step.action, destination: { ...step.action.destination, frames: chain } };
      }
    }
    return step;
  }

  private async write(step: Step, replaceCount: number): Promise<void> {
    const { state } = this;
    const recording = await this.storage.updateRecording(state.recordingId, (draft) => {
      const end = state.insertAt ?? draft.steps.length;
      const start = Math.max(end - replaceCount, 0);
      const before = draft.steps[start - 1];
      if (state.lastInteractionAt && before) step.recordedDelayMs = Date.now() - state.lastInteractionAt;
      draft.steps.splice(start, end - start, step);
      if (state.insertAt !== null) state.insertAt = start + 1;
    });
    state.stepCount = recording.steps.length;
    this.persist();
    this.onChange();
  }

  addDraft(draft: StepDraft, frameId: number): Promise<void> {
    return this.enqueue(async () => {
      const step = await this.toStep(draft, frameId);
      await this.write(step, 0);
      this.state.lastInteractionAt = draft.at;
    });
  }

  replaceLast(count: number, draft: StepDraft, frameId: number): Promise<void> {
    return this.enqueue(async () => {
      const step = await this.toStep(draft, frameId);
      await this.write(step, count);
      this.state.lastInteractionAt = draft.at;
    });
  }

  addStep(step: Step): Promise<void> {
    return this.enqueue(() => this.write(step, 0));
  }

  onCommitted(navigation: CommittedNavigation): Promise<void> {
    return this.enqueue(async () => {
      await sleep(NAVIGATION_SETTLE_MS);
      const url = this.settings().redactUrlParams ? redactUrl(navigation.url) : navigation.url;
      const action = classifyNavigation({ ...navigation, url }, this.state, Date.now());
      this.trackHistory(url, navigation.transitionQualifiers.includes('forward_back'));
      if (action) await this.write(newStep(action), 0);
    });
  }

  /** pushState, replaceState and hash changes. These never involve a page load. */
  onSameDocumentNavigation(rawUrl: string, qualifiers: string[]): Promise<void> {
    return this.enqueue(async () => {
      await sleep(NAVIGATION_SETTLE_MS);
      const url = this.settings().redactUrlParams ? redactUrl(rawUrl) : rawUrl;
      const { state } = this;
      if (url === state.history[state.historyIndex]) return;
      const action = qualifiers.includes('forward_back')
        ? classifyNavigation({ url, transitionType: 'link', transitionQualifiers: qualifiers }, state, Date.now())
        : ({ type: 'urlChange', match: urlToMatch(url) } as const);
      this.trackHistory(url, qualifiers.includes('forward_back'));
      if (action) await this.write(newStep(action, { ...(action.type === 'urlChange' ? { execution: 'required' } : {}) }), 0);
    });
  }

  private trackHistory(url: string, isHistoryMove: boolean): void {
    const { state } = this;
    if (isHistoryMove) {
      const index = state.history.lastIndexOf(url);
      if (index >= 0) {
        state.historyIndex = index;
        return;
      }
    }
    state.history = [...state.history.slice(0, state.historyIndex + 1), url];
    state.historyIndex = state.history.length - 1;
  }
}
