import type { ElementTarget } from './selector';

export type ExecutionType = 'required' | 'optional' | 'skip';

export type TextMatchMode = 'exact' | 'contains' | 'regex';

export interface TextMatch {
  mode: TextMatchMode;
  value: string;
}

export interface Modifiers {
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}

/** Position inside the element as a 0-1 ratio of its width and height. */
export interface RelativePoint {
  x: number;
  y: number;
}

export type WaitCondition =
  | { kind: 'exists' }
  | { kind: 'visible' }
  | { kind: 'enabled' }
  | { kind: 'hidden' }
  | { kind: 'gone' }
  | { kind: 'text'; match: TextMatch }
  | { kind: 'url'; match: TextMatch }
  | { kind: 'urlChanged' }
  | { kind: 'loadingGone'; selector: string }
  | { kind: 'delay'; ms: number };

export type Assertion =
  | { kind: 'exists' }
  | { kind: 'notExists' }
  | { kind: 'visible' }
  | { kind: 'hidden' }
  | { kind: 'text'; match: TextMatch }
  | { kind: 'value'; match: TextMatch }
  | { kind: 'checked' }
  | { kind: 'unchecked' }
  | { kind: 'url'; match: TextMatch }
  | { kind: 'title'; match: TextMatch }
  | { kind: 'count'; expected: number; selector: string };

export type NativeDialogKind = 'alert' | 'confirm' | 'prompt';

export type StepAction =
  | { type: 'navigate'; url: string }
  | { type: 'reload' }
  | { type: 'history'; direction: 'back' | 'forward' }
  /** A URL change caused by an earlier step. Playback waits for it instead of navigating. */
  | { type: 'urlChange'; match: TextMatch }
  | { type: 'click'; modifiers?: Modifiers; offset?: RelativePoint }
  | { type: 'doubleClick'; modifiers?: Modifiers; offset?: RelativePoint }
  | { type: 'contextMenu'; modifiers?: Modifiers; offset?: RelativePoint }
  | { type: 'hover' }
  | {
      type: 'dragDrop';
      mode: 'html5' | 'pointer';
      destination: ElementTarget;
      fromOffset?: RelativePoint;
      toOffset?: RelativePoint;
    }
  | {
      type: 'input';
      value: string;
      /** True when the value was withheld. Playback pauses for the user unless a value is added. */
      redacted?: boolean;
      /** `fill` sets the value at once. `keystrokes` sends key events for each character. */
      typing?: 'fill' | 'keystrokes';
    }
  | { type: 'select'; values: string[]; labels: string[] }
  | { type: 'check'; checked: boolean }
  | { type: 'keyPress'; key: string; code: string; modifiers?: Modifiers }
  | { type: 'scroll'; x: number; y: number }
  /** Browsers forbid scripts from filling file inputs, so playback pauses for the user. */
  | { type: 'file'; fileNames: string[] }
  | {
      type: 'dialog';
      kind: NativeDialogKind;
      accept: boolean;
      message: string;
      promptText?: string;
    }
  | { type: 'wait'; condition: WaitCondition }
  | { type: 'assert'; assertion: Assertion }
  /** Runs every step of another recording in place. */
  | { type: 'runRecording'; recordingId: string };

export type ActionType = StepAction['type'];

export interface WaitConfig {
  /** Overrides the default timeout from settings. */
  timeoutMs?: number;
  preDelayMs?: number;
  postDelayMs?: number;
  /** Skips visible/enabled/covered checks and acts as soon as the element exists. */
  force?: boolean;
  /** CSS selector that must not be visible before this step acts, such as a spinner. */
  waitForGone?: string;
}

export interface BreakpointConfig {
  enabled: boolean;
  label?: string;
}

export type StepCondition =
  | { kind: 'elementExists'; selector: string }
  | { kind: 'elementMissing'; selector: string }
  | { kind: 'urlMatches'; match: TextMatch }
  | { kind: 'variableEquals'; variable: string; value: string };

export interface Step {
  id: string;
  /** User-given name. When absent the UI derives one from the action. */
  name?: string;
  description?: string;
  action: StepAction;
  execution: ExecutionType;
  target?: ElementTarget;
  wait: WaitConfig;
  breakpoint?: BreakpointConfig;
  groupId?: string;
  /** The step only runs when this holds. */
  condition?: StepCondition;
  /** Milliseconds after the previous step, as recorded. Informational. */
  recordedDelayMs?: number;
}

/** Actions that need `target` to be set. */
export const TARGETED_ACTIONS: ReadonlySet<ActionType> = new Set<ActionType>([
  'click',
  'doubleClick',
  'contextMenu',
  'hover',
  'dragDrop',
  'input',
  'select',
  'check',
  'file',
]);

export function assertionNeedsTarget(assertion: Assertion): boolean {
  return !['url', 'title', 'count'].includes(assertion.kind);
}

export function waitNeedsTarget(condition: WaitCondition): boolean {
  return ['exists', 'visible', 'enabled', 'hidden', 'gone'].includes(condition.kind);
}

export function stepNeedsTarget(action: StepAction): boolean {
  if (action.type === 'assert') return assertionNeedsTarget(action.assertion);
  if (action.type === 'wait') return waitNeedsTarget(action.condition);
  return TARGETED_ACTIONS.has(action.type);
}
