import type {
  FailureDetail,
  LogEntry,
  LogEvent,
  PauseReason,
  PlaybackProgress,
  SessionMode,
  StepFailure,
  StepStatus,
} from '@shared/model/execution';
import type { SetupAction, SetupStep } from '@shared/model/setup';
import type { Step, StepCondition } from '@shared/model/step';
import { setupTitle } from '@shared/setup';
import { stepTitle } from '@shared/steps';
import { AbortError, createId, errorMessage, sleep } from '@shared/util';
import { resolveSetupVariables, resolveStepVariables } from '@shared/variables';
import type { PlanItem } from './plan';

/** A step that couldn't be completed, with everything needed to explain why. */
export class StepError extends Error {
  readonly detail: FailureDetail;

  constructor(detail: FailureDetail) {
    super(detail.message);
    this.name = 'StepError';
    this.detail = detail;
  }
}

export interface StepRunContext {
  timeoutMs: number;
  signal: AbortSignal;
  /** The step after this one, if any. A native dialog has to be armed ahead of time. */
  nextStep: Step | undefined;
}

/** What the engine needs from the outside world. The real one lives in the background. */
export interface PlaybackDriver {
  runStep(step: Step, context: StepRunContext): Promise<void>;
  checkCondition(condition: StepCondition, signal: AbortSignal): Promise<boolean>;
  currentUrl(): Promise<string | undefined>;
  /** Shows the user which element a manual step is about. Optional and best effort. */
  showTarget(step: Step): Promise<void>;
  /** Carries out a setup action. Its `url` has already been filled in. */
  runSetup(action: SetupAction, signal: AbortSignal): Promise<void>;
}

export interface EngineTimings {
  defaultTimeoutMs: number;
  optionalTimeoutMs: number;
  stepDelayMs: number;
}

export interface EngineOptions {
  recordingId: string;
  driver: PlaybackDriver;
  plan: PlanItem[];
  /** Enabled setup steps, run before the first step. Their URLs are already filled in. */
  setup?: SetupStep[];
  timings: EngineTimings;
  variables: Record<string, string>;
  speed: number;
  onChange: () => void;
  /** Called once when a run ends, however it ended. */
  onFinish?: (outcome: 'completed' | 'failed' | 'stopped') => void;
}

/** Steps that a script can't do. The run pauses so the user can do them in the page. */
export function isManualStep(step: Step): boolean {
  const { action } = step;
  if (action.type === 'file') return true;
  return action.type === 'input' && action.redacted === true && action.value === '';
}

function manualMessage(step: Step): string {
  const target = step.target?.summary ?? 'the field';
  return step.action.type === 'file'
    ? `Choose the file for ${target} in the page, then resume. Browsers don't let extensions fill file inputs.`
    : `The value for ${target} wasn't recorded. Enter it in the page, then resume.`;
}

/**
 * The playback state machine. It owns ordering, pausing, breakpoints and failure
 * policy, and leaves all contact with the page to the driver.
 */
export class PlaybackEngine {
  private readonly options: EngineOptions;
  private readonly runId = createId('run');
  private plan: PlanItem[];
  private cursor = 0;
  private setup: SetupStep[];
  /** Next setup step to run. Steps start once it reaches the end. */
  private setupCursor = 0;
  private modeValue: SessionMode = 'idle';
  private pauseReason: PauseReason | null = null;
  private pauseMessage: string | null = null;
  private pauseRequested = false;
  private singleStep = false;
  private statuses: Record<string, StepStatus> = {};
  private failure: StepFailure | null = null;
  private log: LogEntry[] = [];
  private seq = 0;
  private speed: number;
  private startedAt = 0;
  private finishedAt: number | null = null;
  private controller = new AbortController();
  /** Item whose breakpoint has already been honoured, so that resuming moves past it. */
  private breakpointPassed: string | null = null;
  /** Manual item the user has been asked to do. Resuming counts it as done. */
  private manualPending: string | null = null;
  /** Signal of the loop that's running. A restarted run has a new signal and a loop of its own. */
  private activeLoop: AbortSignal | null = null;
  private finished = false;

  constructor(options: EngineOptions) {
    this.options = options;
    this.plan = options.plan;
    this.setup = options.setup ?? [];
    this.speed = options.speed;
  }

  get mode(): SessionMode {
    return this.modeValue;
  }

  get id(): string {
    return this.runId;
  }

  /* ---------- Commands ---------- */

  start({ paused = false }: { paused?: boolean } = {}): void {
    this.reset();
    const setupNote = this.setup.length ? ` after ${this.setup.length} setup step${this.setup.length === 1 ? '' : 's'}` : '';
    this.note(`Run started with ${this.plan.length} step${this.plan.length === 1 ? '' : 's'}${setupNote}`);
    // A breakpoint on the very first step would stop a run the user has only just asked for.
    this.breakpointPassed = this.plan[0]?.key ?? null;
    if (paused) {
      this.enterPause('step', null);
      return;
    }
    this.modeValue = 'playing';
    this.changed();
    void this.loop();
  }

  pause(): void {
    if (this.modeValue === 'playing') this.pauseRequested = true;
  }

  resume(): void {
    if (this.modeValue !== 'paused') return;
    this.pauseRequested = false;
    this.singleStep = false;
    this.leavePause();
  }

  /** Runs the next step, then pauses. */
  step(): void {
    if (this.modeValue === 'failed') {
      this.retry({ singleStep: true });
      return;
    }
    if (this.modeValue !== 'paused') return;
    this.singleStep = true;
    this.leavePause();
  }

  retry({ singleStep = false }: { singleStep?: boolean } = {}): void {
    if (this.modeValue !== 'failed') return;
    this.failure = null;
    this.singleStep = singleStep;
    this.modeValue = 'playing';
    this.note('Retrying step');
    void this.loop();
  }

  /** Abandons the failed step and carries on with the next one. */
  skipFailed(): void {
    if (this.modeValue !== 'failed') return;
    const setupStep = this.failure?.phase === 'setup' ? this.setup[this.setupCursor] : undefined;
    if (setupStep) {
      this.statuses[setupStep.id] = 'skipped';
      this.log.push(this.setupEntry('skipped', setupStep, { message: 'Skipped after failure' }));
      this.setupCursor++;
    } else {
      const item = this.plan[this.cursor];
      if (item) {
        this.setStatus(item, 'skipped');
        this.record('skipped', item, { message: 'Skipped after failure' });
      }
      this.cursor++;
    }
    this.failure = null;
    this.modeValue = 'playing';
    void this.loop();
  }

  stop(): void {
    if (this.modeValue === 'idle') return;
    const wasActive = !this.finished;
    this.controller.abort();
    this.modeValue = 'idle';
    this.pauseReason = null;
    this.pauseMessage = null;
    for (const [key, status] of Object.entries(this.statuses)) {
      if (status === 'running') this.statuses[key] = 'pending';
    }
    if (wasActive) {
      this.note('Run stopped');
      this.finish('stopped');
    }
    this.changed();
  }

  restart(): void {
    this.controller.abort();
    this.controller = new AbortController();
    this.start();
  }

  setSpeed(speed: number): void {
    this.speed = speed;
    this.changed();
  }

  /** Swaps in a rebuilt plan, so edits made while paused apply to the rest of the run. */
  updatePlan(plan: PlanItem[]): void {
    const currentKey = this.plan[this.cursor]?.key;
    this.plan = plan;
    const index = plan.findIndex((item) => item.key === currentKey);
    if (index >= 0) this.cursor = index;
    else this.cursor = Math.min(this.cursor, plan.length);
    this.changed();
  }

  /** Swaps in edited setup steps. Ones that already ran stay done. */
  updateSetup(setup: SetupStep[]): void {
    const currentId = this.setup[this.setupCursor]?.id;
    const done = new Set(this.setup.slice(0, this.setupCursor).map((item) => item.id));
    this.setup = setup;
    const index = setup.findIndex((item) => item.id === currentId);
    this.setupCursor = index >= 0 ? index : setup.filter((item) => done.has(item.id)).length;
    for (const item of setup) this.statuses[item.id] ??= 'pending';
    this.changed();
  }

  snapshot(): PlaybackProgress {
    const current = this.plan[this.cursor];
    return {
      runId: this.runId,
      recordingId: this.options.recordingId,
      cursorStepId: current?.rootStepId ?? null,
      cursorIndex: current?.rootIndex ?? this.cursor,
      total: this.plan.length,
      pauseReason: this.pauseReason,
      pauseMessage: this.pauseMessage,
      speed: this.speed,
      statuses: { ...this.statuses },
      failure: this.failure,
      log: [...this.log],
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
    };
  }

  /* ---------- The run loop ---------- */

  private async loop(): Promise<void> {
    const { signal } = this.controller;
    if (this.activeLoop === signal) return;
    this.activeLoop = signal;
    try {
      if (!(await this.runSetup(signal))) return;
      while (this.modeValue === 'playing' && !signal.aborted) {
        const item = this.plan[this.cursor];
        if (!item) {
          this.complete();
          break;
        }
        if (this.pauseRequested) {
          this.pauseRequested = false;
          this.enterPause('user', null);
          break;
        }
        if (item.step.breakpoint?.enabled && this.breakpointPassed !== item.key && this.manualPending !== item.key) {
          this.breakpointPassed = item.key;
          const label = item.step.breakpoint.label;
          this.enterPause('breakpoint', label ? `Breakpoint: ${label}` : `Breakpoint before step ${item.rootIndex + 1}`);
          break;
        }

        const ran = await this.runItem(item, signal);
        if (signal.aborted || this.modeValue !== 'playing') break;
        if (ran === 'paused') break;

        const hasMore = this.cursor < this.plan.length;
        if (this.singleStep && ran === 'executed' && hasMore) {
          this.singleStep = false;
          this.enterPause('step', null);
          break;
        }
        if (ran === 'executed' && hasMore) await this.betweenSteps(signal);
      }
    } catch (error) {
      if (!(error instanceof AbortError)) {
        this.note(`Internal error: ${errorMessage(error)}`);
        await this.fail(this.plan[this.cursor], { code: 'action-failed', message: errorMessage(error) });
      }
    } finally {
      if (this.activeLoop === signal) this.activeLoop = null;
    }
  }

  /** Runs whatever setup is left. Returns false if one failed, and the run with it. */
  private async runSetup(signal: AbortSignal): Promise<boolean> {
    while (this.setupCursor < this.setup.length) {
      const setupStep = this.setup[this.setupCursor]!;
      const started = Date.now();
      const action = resolveSetupVariables(setupStep.action, this.options.variables);
      this.statuses[setupStep.id] = 'running';
      this.changed();
      try {
        await this.options.driver.runSetup(action, signal);
        if (signal.aborted) throw new AbortError();
      } catch (error) {
        if (error instanceof AbortError || signal.aborted) throw new AbortError();
        const detail: FailureDetail =
          error instanceof StepError ? error.detail : { code: 'action-failed', message: errorMessage(error) };
        this.failSetup(setupStep, action.url, detail, started);
        return false;
      }
      this.statuses[setupStep.id] = 'passed';
      this.log.push(this.setupEntry('completed', setupStep, { durationMs: Date.now() - started }));
      this.setupCursor++;
      this.changed();
    }
    return true;
  }

  private failSetup(setupStep: SetupStep, url: string | undefined, detail: FailureDetail, started: number): void {
    const failure: StepFailure = {
      ...detail,
      phase: 'setup',
      stepId: setupStep.id,
      stepIndex: this.setupCursor,
      stepName: setupTitle(setupStep.action),
      action: setupStep.action.type,
      ...(url ? { url } : {}),
    };
    this.failure = failure;
    this.statuses[setupStep.id] = 'failed';
    this.log.push(this.setupEntry('failed', setupStep, { durationMs: Date.now() - started, message: detail.message, failure }));
    this.modeValue = 'failed';
    this.finish('failed');
    this.changed();
  }

  private async betweenSteps(signal: AbortSignal): Promise<void> {
    const delay = this.options.timings.stepDelayMs / this.speed;
    if (delay >= 1) await sleep(delay, signal);
  }

  /** Runs one item. Returns `passed-over` for items that did nothing and take no time. */
  private async runItem(item: PlanItem, signal: AbortSignal): Promise<'executed' | 'passed-over' | 'failed' | 'paused'> {
    const { step } = item;

    if (step.execution === 'skip') {
      this.passOver(item, 'Marked as skip');
      return 'passed-over';
    }

    if (step.condition) {
      const holds = await this.conditionHolds(step.condition, signal);
      if (!holds) {
        this.passOver(item, 'Condition not met');
        return 'passed-over';
      }
    }

    if (item.isContainer) {
      this.setStatus(item, item.childCount > 0 ? 'running' : 'passed');
      this.record('note', item, { message: `Running ${item.childCount} nested step${item.childCount === 1 ? '' : 's'}` });
      this.cursor++;
      this.changed();
      return 'passed-over';
    }

    if (isManualStep(step)) {
      if (step.execution === 'optional') {
        this.passOver(item, 'No value recorded for this optional step');
        return 'passed-over';
      }
      if (this.manualPending !== item.key) {
        this.manualPending = item.key;
        this.setStatus(item, 'running');
        await this.options.driver.showTarget(step).catch(() => undefined);
        this.enterPause('manual', manualMessage(step));
        return 'paused';
      }
      this.manualPending = null;
      this.setStatus(item, 'passed');
      this.record('completed', item, { message: 'Completed by hand' });
      this.cursor++;
      return 'executed';
    }

    const started = Date.now();
    this.setStatus(item, 'running');
    this.record('started', item);
    this.changed();

    try {
      if (step.wait.preDelayMs) await sleep(step.wait.preDelayMs, signal);
      const resolved = resolveStepVariables(step, this.options.variables);
      await this.options.driver.runStep(resolved, {
        timeoutMs: this.timeoutFor(step),
        signal,
        nextStep: this.plan[this.cursor + 1]?.step,
      });
      if (step.wait.postDelayMs) await sleep(step.wait.postDelayMs, signal);
      // The run may have been stopped while this was in flight. Its result no longer counts.
      if (signal.aborted) throw new AbortError();
    } catch (error) {
      if (error instanceof AbortError || signal.aborted) throw new AbortError();
      const detail: FailureDetail =
        error instanceof StepError ? error.detail : { code: 'action-failed', message: errorMessage(error) };
      if (step.execution === 'optional') {
        this.setStatus(item, 'skipped');
        this.record('skipped', item, { durationMs: Date.now() - started, message: detail.message });
        this.cursor += 1;
        this.changed();
        return 'executed';
      }
      await this.fail(item, detail, started);
      return 'failed';
    }

    this.setStatus(item, 'passed');
    this.record('completed', item, { durationMs: Date.now() - started });
    this.cursor += 1;
    this.changed();
    return 'executed';
  }

  /** Marks an item as not run. A `runRecording` step takes its nested items with it. */
  private passOver(item: PlanItem, message: string): void {
    this.setStatus(item, 'skipped');
    this.record('skipped', item, { message });
    this.cursor += 1 + item.childCount;
    this.changed();
  }

  private async conditionHolds(condition: StepCondition, signal: AbortSignal): Promise<boolean> {
    if (condition.kind === 'variableEquals') {
      return this.options.variables[condition.variable] === condition.value;
    }
    return this.options.driver.checkCondition(condition, signal);
  }

  private timeoutFor(step: Step): number {
    const { defaultTimeoutMs, optionalTimeoutMs } = this.options.timings;
    return step.wait.timeoutMs ?? (step.execution === 'optional' ? optionalTimeoutMs : defaultTimeoutMs);
  }

  /* ---------- State changes ---------- */

  private reset(): void {
    this.cursor = 0;
    this.setupCursor = 0;
    this.statuses = {};
    for (const item of this.setup) this.statuses[item.id] = 'pending';
    this.failure = null;
    this.log = [];
    this.seq = 0;
    this.pauseRequested = false;
    this.singleStep = false;
    this.pauseReason = null;
    this.pauseMessage = null;
    this.manualPending = null;
    this.finished = false;
    this.finishedAt = null;
    this.startedAt = Date.now();
    for (const item of this.plan) this.statuses[item.rootStepId] = 'pending';
  }

  private enterPause(reason: PauseReason, message: string | null): void {
    this.modeValue = 'paused';
    this.pauseReason = reason;
    this.pauseMessage = message;
    const item = this.plan[this.cursor];
    if (reason !== 'step') {
      this.log.push(this.entry('paused', item, { message: message ?? 'Paused' }));
    }
    this.changed();
  }

  private leavePause(): void {
    // Whatever stopped us at this item has been dealt with now.
    this.breakpointPassed = this.plan[this.cursor]?.key ?? null;
    this.pauseReason = null;
    this.pauseMessage = null;
    this.modeValue = 'playing';
    this.changed();
    void this.loop();
  }

  private complete(): void {
    this.modeValue = 'completed';
    this.note('Run completed');
    this.finish('completed');
    this.changed();
  }

  private async fail(item: PlanItem | undefined, detail: FailureDetail, started = Date.now()): Promise<void> {
    const url = await this.options.driver.currentUrl().catch(() => undefined);
    const failure: StepFailure = {
      ...detail,
      stepId: item?.rootStepId ?? '',
      stepIndex: item?.rootIndex ?? this.cursor,
      stepName: item ? stepTitle(item.step) : 'Unknown step',
      action: item?.step.action.type ?? 'click',
      ...(item?.step.target ? { targetSummary: item.step.target.summary } : {}),
      ...(url ? { url } : {}),
    };
    this.failure = failure;
    if (item) this.setStatus(item, 'failed');
    this.record('failed', item, { durationMs: Date.now() - started, message: detail.message, failure });
    this.modeValue = 'failed';
    this.finish('failed');
    this.changed();
  }

  private finish(outcome: 'completed' | 'failed' | 'stopped'): void {
    this.finishedAt = Date.now();
    // A failed run can continue through Retry and fail again; it is reported each time.
    this.finished = outcome !== 'failed';
    this.options.onFinish?.(outcome);
  }

  private setStatus(item: PlanItem, status: StepStatus): void {
    this.statuses[item.step.id] = status;
    if (item.rootStepId === item.step.id) return;
    if (status === 'failed') this.statuses[item.rootStepId] = 'failed';
    else if (status === 'running' || !item.lastOfRoot) this.statuses[item.rootStepId] = 'running';
    else this.statuses[item.rootStepId] = 'passed';
  }

  private entry(event: LogEvent, item: PlanItem | undefined, extra: Partial<LogEntry>): LogEntry {
    return {
      seq: ++this.seq,
      at: Date.now(),
      event,
      ...(item
        ? { stepId: item.rootStepId, stepIndex: item.rootIndex, stepName: stepTitle(item.step) }
        : {}),
      ...extra,
    };
  }

  /** Setup entries have a name but no step number, which is how the log tells them apart. */
  private setupEntry(event: LogEvent, setupStep: SetupStep, extra: Partial<LogEntry>): LogEntry {
    return this.entry(event, undefined, { stepId: setupStep.id, stepName: `Setup: ${setupTitle(setupStep.action)}`, ...extra });
  }

  private record(event: LogEvent, item: PlanItem | undefined, extra: Partial<LogEntry> = {}): void {
    this.log.push(this.entry(event, item, extra));
  }

  private note(message: string): void {
    this.log.push(this.entry('note', undefined, { message }));
  }

  private changed(): void {
    this.options.onChange();
  }
}
