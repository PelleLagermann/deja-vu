import type { SelectorAttempt } from './selector';
import type { SetupActionType } from './setup';
import type { ActionType } from './step';

export type SessionMode = 'idle' | 'recording' | 'playing' | 'paused' | 'completed' | 'failed';

export type PauseReason = 'user' | 'breakpoint' | 'step' | 'manual';

export type StepStatus =
  | 'pending'
  | 'running'
  | 'passed'
  /** Optional step that didn't run or didn't succeed. Playback continued. */
  | 'skipped'
  | 'failed';

export type FailureCode =
  | 'element-not-found'
  | 'element-ambiguous'
  | 'not-actionable'
  | 'timeout'
  | 'assertion-failed'
  | 'action-failed'
  | 'navigation-failed'
  | 'no-page-access'
  | 'page-unresponsive'
  | 'invalid-step';

/** A failure as reported by the code that ran the step. */
export interface FailureDetail {
  code: FailureCode;
  message: string;
  attempts?: SelectorAttempt[];
  /** Concrete next thing to try. */
  hint?: string;
  expected?: string;
  actual?: string;
}

/** A failure with its context in the run, as shown to the user. */
export interface StepFailure extends FailureDetail {
  /** Set when a setup step failed. `stepId` and `stepIndex` then refer to the setup list. */
  phase?: 'setup';
  stepId: string;
  stepIndex: number;
  stepName: string;
  action: ActionType | SetupActionType;
  targetSummary?: string;
  url?: string;
}

export type LogEvent = 'started' | 'completed' | 'skipped' | 'failed' | 'paused' | 'note';

export interface LogEntry {
  seq: number;
  at: number;
  event: LogEvent;
  stepId?: string;
  stepIndex?: number;
  stepName?: string;
  durationMs?: number;
  message?: string;
  failure?: StepFailure;
}

export interface PlaybackProgress {
  runId: string;
  recordingId: string;
  /** Step currently running, or the one that will run next when paused. */
  cursorStepId: string | null;
  cursorIndex: number;
  total: number;
  pauseReason: PauseReason | null;
  /** Shown for breakpoint and manual pauses. */
  pauseMessage: string | null;
  speed: number;
  statuses: Record<string, StepStatus>;
  failure: StepFailure | null;
  log: LogEntry[];
  startedAt: number;
  finishedAt: number | null;
}

export interface RecordingProgress {
  recordingId: string;
  stepCount: number;
  /** Origin the user navigated to that the extension can't access yet. */
  blockedOrigin: string | null;
  capturesValues: boolean;
}

/** Everything the UI needs to show the current session. */
export interface SessionSnapshot {
  mode: SessionMode;
  tabId: number | null;
  recording: RecordingProgress | null;
  playback: PlaybackProgress | null;
  /** Last session-level problem, such as a tab that closed mid-run. */
  notice: string | null;
}

export const IDLE_SNAPSHOT: SessionSnapshot = {
  mode: 'idle',
  tabId: null,
  recording: null,
  playback: null,
  notice: null,
};

/** A finished playback, kept so its log can be read later. */
export interface RunRecord {
  id: string;
  recordingId: string;
  startedAt: number;
  finishedAt: number;
  outcome: 'completed' | 'failed' | 'stopped';
  log: LogEntry[];
}
