import type { FailureDetail, SessionSnapshot } from './model/execution';
import type { Settings } from './model/recording';
import type { AttemptVerdict, ElementTarget, SelectorStrategy, SelectorAttempt } from './model/selector';
import type { NativeDialogKind, Step, StepCondition, StepAction } from './model/step';

/* ---------- Sidebar to background ---------- */

export interface PlaybackRange {
  /** First step to run, as an index into the recording. */
  from?: number;
  /** Last step to run, inclusive. */
  to?: number;
}

export type Command =
  | { type: 'recording/start'; tabId?: number; recordingId?: string; insertAt?: number }
  | { type: 'recording/stop' }
  | {
      type: 'playback/start';
      recordingId: string;
      tabId?: number;
      range?: PlaybackRange;
      /** Pause before the first step instead of running. */
      paused?: boolean;
      variables?: Record<string, string>;
      speed?: number;
    }
  | { type: 'playback/pause' }
  | { type: 'playback/resume' }
  | { type: 'playback/stop' }
  | { type: 'playback/step' }
  | { type: 'playback/restart' }
  | { type: 'playback/retry' }
  | { type: 'playback/skip' }
  | { type: 'playback/speed'; speed: number }
  | { type: 'playback/dismiss' }
  | { type: 'inspect/highlight'; target: ElementTarget }
  | { type: 'inspect/clear' }
  | { type: 'inspect/test'; target: ElementTarget }
  | { type: 'inspect/pick' }
  | { type: 'inspect/cancelPick' }
  | { type: 'recording/addStep'; step: Step }
  | { type: 'session/get' };

export interface StrategyTestResult {
  strategy: SelectorStrategy;
  matchCount: number;
  verdict: AttemptVerdict;
}

export interface TargetTestResult {
  resolvedBy: SelectorStrategy | null;
  attempts: StrategyTestResult[];
  error?: string;
}

export type CommandResult<T = unknown> = { ok: true; value: T } | { ok: false; error: string };

/** Background to sidebar, over the long-lived port. */
export type SidebarEvent = { type: 'session'; snapshot: SessionSnapshot };

export const SIDEBAR_PORT = 'dejavu-sidebar';

/* ---------- Background to content script ---------- */

export interface RecorderConfig {
  captureFormValues: boolean;
  recordScroll: boolean;
  excludedSelectors: string[];
  testIdAttributes: string[];
}

export interface PlaybackConfig {
  highlight: boolean;
  loadingSelectors: string[];
  testIdAttributes: string[];
}

export type ContentMode =
  | { mode: 'idle' }
  | { mode: 'recording'; config: RecorderConfig }
  | { mode: 'playback'; config: PlaybackConfig };

export interface PrepareRequest {
  type: 'prepare';
  token: string;
  step: Step;
  timeoutMs: number;
}

export type ContentRequest =
  | { type: 'mode'; state: ContentMode }
  | PrepareRequest
  | { type: 'perform'; token: string }
  | { type: 'cancel' }
  | { type: 'evalCondition'; condition: StepCondition }
  | { type: 'armDialog'; accept: boolean; promptText?: string; kind: NativeDialogKind }
  | { type: 'highlight'; target: ElementTarget; testIdAttributes: string[] }
  | { type: 'clearHighlight' }
  | { type: 'testTarget'; target: ElementTarget }
  | { type: 'pick'; testIdAttributes: string[] }
  | { type: 'cancelPick' };

export type PrepareResponse =
  /** The element is ready. Send `perform` with the same token to act. */
  | { status: 'ready'; attempts: SelectorAttempt[] }
  /** The step needed no action, such as a wait or assertion, and has finished. */
  | { status: 'done'; attempts?: SelectorAttempt[] }
  | { status: 'failed'; failure: FailureDetail }
  | { status: 'cancelled' };

export type PerformResponse =
  | { status: 'done' }
  | { status: 'failed'; failure: FailureDetail }
  /** The token is unknown because the document changed. Prepare again. */
  | { status: 'stale' };

/* ---------- Content script to background ---------- */

/** A step as produced by the recorder, before the background gives it an ID. */
export interface StepDraft {
  action: StepAction;
  target?: ElementTarget;
  execution?: 'required' | 'optional';
  at: number;
}

export type ContentEvent =
  | { type: 'hello'; url: string }
  | { type: 'recorder/step'; draft: StepDraft }
  /** Replaces the last `count` steps, as when two clicks turn out to be a double-click. */
  | { type: 'recorder/replace'; count: number; draft: StepDraft }
  | { type: 'dialog/handled'; kind: NativeDialogKind }
  | { type: 'heartbeat' };
