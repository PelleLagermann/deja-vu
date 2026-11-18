import { describe, expect, it, vi } from 'vitest';
import type { FailureDetail } from '@shared/model/execution';
import type { Recording } from '@shared/model/recording';
import type { SetupAction, SetupStep } from '@shared/model/setup';
import type { Step, StepAction } from '@shared/model/step';
import { newSetupStep } from '@shared/setup';
import { newRecording, newStep } from '@shared/steps';
import { PlaybackEngine, StepError, type PlaybackDriver } from '../../src/playback-engine/engine';
import { buildPlan, type PlanItem } from '../../src/playback-engine/plan';

const notFound: FailureDetail = { code: 'element-not-found', message: 'Not found' };

function click(name: string, partial: Partial<Step> = {}): Step {
  return newStep({ type: 'click' }, { name, ...partial });
}

/** A driver that records what ran. Steps can be made to fail or to block until released. */
class FakeDriver implements PlaybackDriver {
  ran: string[] = [];
  received: Step[] = [];
  failing = new Set<string>();
  conditions = new Map<string, boolean>();
  private blocked = new Map<string, () => void>();

  block(name: string): void {
    this.blocked.set(name, () => undefined);
  }

  release(name: string): void {
    this.blocked.get(name)?.();
    this.blocked.delete(name);
  }

  async runStep(step: Step): Promise<void> {
    const name = step.name ?? step.id;
    this.received.push(step);
    if (this.blocked.has(name)) {
      await new Promise<void>((resolve) => this.blocked.set(name, resolve));
    }
    if (this.failing.has(name)) throw new StepError(notFound);
    this.ran.push(name);
  }

  async checkCondition(condition: { kind: string; selector?: string }): Promise<boolean> {
    return this.conditions.get(condition.selector ?? '') ?? false;
  }

  async currentUrl(): Promise<string> {
    return 'http://example.test/page';
  }

  async showTarget(): Promise<void> {}

  /** Setup actions appear in `ran` as `setup:<cookie name>`, or `setup:*` for clearing them all. */
  setupReceived: SetupAction[] = [];

  async runSetup(action: SetupAction): Promise<void> {
    this.setupReceived.push(action);
    const name = `setup:${'name' in action ? action.name : '*'}`;
    if (this.failing.has(name)) throw new StepError({ code: 'action-failed', message: 'Cookie refused' });
    this.ran.push(name);
  }
}

function planOf(steps: Step[]): PlanItem[] {
  return steps.map((step, index) => ({
    key: step.id,
    step,
    rootStepId: step.id,
    rootIndex: index,
    childCount: 0,
    lastOfRoot: false,
    depth: 0,
  }));
}

function setup(steps: Step[], variables: Record<string, string> = {}, setupSteps: SetupStep[] = []) {
  const driver = new FakeDriver();
  const finished: string[] = [];
  const engine = new PlaybackEngine({
    recordingId: 'rec',
    driver,
    plan: planOf(steps),
    setup: setupSteps,
    timings: { defaultTimeoutMs: 1000, optionalTimeoutMs: 100, stepDelayMs: 0 },
    variables,
    speed: 1,
    onChange: () => undefined,
    onFinish: (outcome) => finished.push(outcome),
  });
  const settled = (mode: string) => vi.waitFor(() => expect(engine.mode).toBe(mode));
  return { engine, driver, finished, settled };
}

describe('sequential playback', () => {
  it('runs steps in order and completes', async () => {
    const { engine, driver, finished, settled } = setup([click('a'), click('b'), click('c')]);
    engine.start();
    await settled('completed');
    expect(driver.ran).toEqual(['a', 'b', 'c']);
    expect(finished).toEqual(['completed']);
  });

  it('reports status per step', async () => {
    const steps = [click('a'), click('b')];
    const { engine, settled } = setup(steps);
    engine.start();
    await settled('completed');
    expect(engine.snapshot().statuses).toEqual({ [steps[0]!.id]: 'passed', [steps[1]!.id]: 'passed' });
  });

  it('logs start and completion with a duration', async () => {
    const { engine, settled } = setup([click('a')]);
    engine.start();
    await settled('completed');
    const log = engine.snapshot().log;
    expect(log.map((entry) => entry.event)).toEqual(['note', 'started', 'completed', 'note']);
    expect(log[2]!.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('pause, resume, stop', () => {
  it('pauses at the next step boundary and resumes where it left off', async () => {
    const { engine, driver, settled } = setup([click('a'), click('b'), click('c')]);
    driver.block('a');
    engine.start();
    await vi.waitFor(() => expect(driver.received).toHaveLength(1));
    engine.pause();
    expect(engine.mode).toBe('playing');
    driver.release('a');
    await settled('paused');
    expect(driver.ran).toEqual(['a']);
    expect(engine.snapshot().pauseReason).toBe('user');

    engine.resume();
    await settled('completed');
    expect(driver.ran).toEqual(['a', 'b', 'c']);
  });

  it('stops without running anything further', async () => {
    const { engine, driver, finished } = setup([click('a'), click('b')]);
    driver.block('a');
    engine.start();
    await vi.waitFor(() => expect(driver.received).toHaveLength(1));
    engine.stop();
    expect(engine.mode).toBe('idle');
    driver.release('a');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(driver.ran).not.toContain('b');
    expect(finished).toEqual(['stopped']);
  });

  it('restarts while a step is still running', async () => {
    const { engine, driver, settled } = setup([click('a'), click('b')]);
    driver.block('a');
    engine.start();
    await vi.waitFor(() => expect(driver.received).toHaveLength(1));
    engine.restart();
    await vi.waitFor(() => expect(driver.received).toHaveLength(2));
    driver.release('a');
    await settled('completed');
    expect(engine.snapshot().log.filter((entry) => entry.event === 'completed')).toHaveLength(2);
  });

  it('ignores the result of a step that finishes after a stop', async () => {
    const steps = [click('a')];
    const { engine, driver } = setup(steps);
    driver.block('a');
    engine.start();
    await vi.waitFor(() => expect(driver.received).toHaveLength(1));
    engine.stop();
    driver.release('a');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(engine.snapshot().statuses[steps[0]!.id]).toBe('pending');
  });

  it('restarts from the beginning', async () => {
    const { engine, driver, settled } = setup([click('a'), click('b')]);
    engine.start();
    await settled('completed');
    engine.restart();
    await vi.waitFor(() => expect(driver.ran).toEqual(['a', 'b', 'a', 'b']));
    await settled('completed');
  });
});

describe('single stepping', () => {
  it('runs one step at a time', async () => {
    const { engine, driver, settled } = setup([click('a'), click('b'), click('c')]);
    engine.start({ paused: true });
    expect(engine.mode).toBe('paused');
    expect(driver.ran).toEqual([]);

    engine.step();
    await vi.waitFor(() => expect(driver.ran).toEqual(['a']));
    await settled('paused');

    engine.step();
    await vi.waitFor(() => expect(driver.ran).toEqual(['a', 'b']));
    await settled('paused');
    expect(engine.snapshot().pauseReason).toBe('step');
  });

  it('completes after stepping through the last step', async () => {
    const { engine, settled } = setup([click('a')]);
    engine.start({ paused: true });
    engine.step();
    await settled('completed');
  });

  it('moves past skip steps to the next real one', async () => {
    const { engine, driver, settled } = setup([click('a', { execution: 'skip' }), click('b'), click('c')]);
    engine.start({ paused: true });
    engine.step();
    await vi.waitFor(() => expect(driver.ran).toEqual(['b']));
    await settled('paused');
  });
});

describe('breakpoints', () => {
  it('pauses before the step and says which one', async () => {
    const steps = [click('a'), click('b', { breakpoint: { enabled: true, label: 'Before submit' } }), click('c')];
    const { engine, driver, settled } = setup(steps);
    engine.start();
    await settled('paused');
    expect(driver.ran).toEqual(['a']);
    const snapshot = engine.snapshot();
    expect(snapshot.pauseReason).toBe('breakpoint');
    expect(snapshot.cursorStepId).toBe(steps[1]!.id);
    expect(snapshot.pauseMessage).toContain('Before submit');
  });

  it('resuming runs the step it stopped at, without stopping there again', async () => {
    const { engine, driver, settled } = setup([click('a'), click('b', { breakpoint: { enabled: true } }), click('c')]);
    engine.start();
    await settled('paused');
    engine.resume();
    await settled('completed');
    expect(driver.ran).toEqual(['a', 'b', 'c']);
  });

  it('stops at each breakpoint in turn', async () => {
    const { engine, driver, settled } = setup([
      click('a'),
      click('b', { breakpoint: { enabled: true } }),
      click('c', { breakpoint: { enabled: true } }),
    ]);
    engine.start();
    await settled('paused');
    expect(driver.ran).toEqual(['a']);
    engine.resume();
    await vi.waitFor(() => expect(driver.ran).toEqual(['a', 'b']));
    await settled('paused');
    engine.resume();
    await settled('completed');
  });

  it('does not stop for a breakpoint on the step a run starts from', async () => {
    const { engine, driver, settled } = setup([click('a', { breakpoint: { enabled: true } }), click('b')]);
    engine.start();
    await settled('completed');
    expect(driver.ran).toEqual(['a', 'b']);
  });

  it('ignores a disabled breakpoint', async () => {
    const { engine, settled } = setup([click('a'), click('b', { breakpoint: { enabled: false } })]);
    engine.start();
    await settled('completed');
  });

  it('stepping onto a breakpoint step executes it', async () => {
    const { engine, driver, settled } = setup([click('a'), click('b', { breakpoint: { enabled: true } }), click('c')]);
    engine.start({ paused: true });
    engine.step();
    await vi.waitFor(() => expect(driver.ran).toEqual(['a']));
    await settled('paused');
    engine.step();
    await vi.waitFor(() => expect(driver.ran).toEqual(['a', 'b']));
  });
});

describe('execution types', () => {
  it('never executes skip steps, but reports them', async () => {
    const steps = [click('a'), click('b', { execution: 'skip' }), click('c')];
    const { engine, driver, settled } = setup(steps);
    engine.start();
    await settled('completed');
    expect(driver.ran).toEqual(['a', 'c']);
    expect(engine.snapshot().statuses[steps[1]!.id]).toBe('skipped');
  });

  it('carries on when an optional step fails', async () => {
    const steps = [click('banner', { execution: 'optional' }), click('next')];
    const { engine, driver, settled } = setup(steps);
    driver.failing.add('banner');
    engine.start();
    await settled('completed');
    expect(driver.ran).toEqual(['next']);
    const snapshot = engine.snapshot();
    expect(snapshot.statuses[steps[0]!.id]).toBe('skipped');
    expect(snapshot.failure).toBeNull();
    expect(snapshot.log.some((entry) => entry.event === 'skipped' && entry.message === 'Not found')).toBe(true);
  });

  it('gives optional steps the shorter timeout', async () => {
    const seen: number[] = [];
    const { engine, driver, settled } = setup([click('a', { execution: 'optional' }), click('b'), click('c', { wait: { timeoutMs: 42 } })]);
    const original = driver.runStep.bind(driver);
    driver.runStep = (step: Step, context?: unknown) => {
      seen.push((context as { timeoutMs: number }).timeoutMs);
      return original(step);
    };
    engine.start();
    await settled('completed');
    expect(seen).toEqual([100, 1000, 42]);
  });
});

describe('required failures', () => {
  it('stops and identifies the failed step', async () => {
    const steps = [click('a'), click('b'), click('c')];
    const { engine, driver, finished, settled } = setup(steps);
    driver.failing.add('b');
    engine.start();
    await settled('failed');
    expect(driver.ran).toEqual(['a']);
    const { failure, statuses } = engine.snapshot();
    expect(failure).toMatchObject({
      stepId: steps[1]!.id,
      stepIndex: 1,
      stepName: 'b',
      action: 'click',
      code: 'element-not-found',
      url: 'http://example.test/page',
    });
    expect(statuses[steps[1]!.id]).toBe('failed');
    expect(finished).toEqual(['failed']);
  });

  it('can retry the failed step', async () => {
    const { engine, driver, settled } = setup([click('a'), click('b')]);
    driver.failing.add('a');
    engine.start();
    await settled('failed');
    driver.failing.clear();
    engine.retry();
    await settled('completed');
    expect(driver.ran).toEqual(['a', 'b']);
    expect(engine.snapshot().failure).toBeNull();
  });

  it('can skip the failed step and continue', async () => {
    const { engine, driver, settled } = setup([click('a'), click('b')]);
    driver.failing.add('a');
    engine.start();
    await settled('failed');
    engine.skipFailed();
    await settled('completed');
    expect(driver.ran).toEqual(['b']);
  });

  it('wraps unexpected errors as failures', async () => {
    const { engine, driver, settled } = setup([click('a')]);
    driver.runStep = () => Promise.reject(new Error('boom'));
    engine.start();
    await settled('failed');
    expect(engine.snapshot().failure?.message).toBe('boom');
  });

  it('uses edits made while failed when retrying', async () => {
    const steps = [click('a')];
    const { engine, driver, settled } = setup(steps);
    driver.failing.add('a');
    engine.start();
    await settled('failed');
    engine.updatePlan(planOf([{ ...steps[0]!, name: 'fixed' }]));
    engine.retry();
    await settled('completed');
    expect(driver.ran).toEqual(['fixed']);
  });
});

describe('conditions', () => {
  const when = (selector: string): Partial<Step> => ({ condition: { kind: 'elementExists', selector } });

  it('skips a step whose condition does not hold', async () => {
    const { engine, driver, settled } = setup([click('a', when('.yes')), click('b', when('.no'))]);
    driver.conditions.set('.yes', true);
    engine.start();
    await settled('completed');
    expect(driver.ran).toEqual(['a']);
  });

  it('compares variables without touching the page', async () => {
    const step = click('a', { condition: { kind: 'variableEquals', variable: 'env', value: 'staging' } });
    const { engine, driver, settled } = setup([step], { env: 'staging' });
    engine.start();
    await settled('completed');
    expect(driver.ran).toEqual(['a']);
  });
});

describe('variables', () => {
  it('substitutes values before the driver sees the step', async () => {
    const step = newStep({ type: 'input', value: 'user-{{id}}@example.com' });
    const { engine, driver, settled } = setup([step], { id: '7' });
    engine.start();
    await settled('completed');
    expect((driver.received[0]!.action as Extract<StepAction, { type: 'input' }>).value).toBe('user-7@example.com');
  });
});

describe('setup', () => {
  const setCookie = (name: string, value = 'on') =>
    newSetupStep({ type: 'setCookie', name, value, url: 'http://example.test/' });
  const deleteCookie = (name: string) => newSetupStep({ type: 'deleteCookie', name, url: 'http://example.test/' });

  it('runs every setup step, in order, before the first step', async () => {
    const setupSteps = [deleteCookie('old'), setCookie('flag')];
    const { engine, driver, settled } = setup([click('a'), click('b')], {}, setupSteps);
    engine.start();
    await settled('completed');
    expect(driver.ran).toEqual(['setup:old', 'setup:flag', 'a', 'b']);
    const { statuses, log } = engine.snapshot();
    expect(statuses[setupSteps[0]!.id]).toBe('passed');
    expect(statuses[setupSteps[1]!.id]).toBe('passed');
    expect(log.find((entry) => entry.stepId === setupSteps[1]!.id)).toMatchObject({
      event: 'completed',
      stepName: 'Setup: Set cookie flag',
    });
    // Setup entries have no step number, which is how the log tells them apart.
    expect(log.find((entry) => entry.stepId === setupSteps[1]!.id)?.stepIndex).toBeUndefined();
  });

  it('runs setup as part of the first single step', async () => {
    const { engine, driver, settled } = setup([click('b')], {}, [setCookie('flag')]);
    engine.start({ paused: true });
    await settled('paused');
    expect(driver.ran).toEqual([]);
    engine.step();
    await settled('completed');
    expect(driver.ran).toEqual(['setup:flag', 'b']);
  });

  it('substitutes variables in setup', async () => {
    const step = newSetupStep({ type: 'setCookie', name: 'user', value: 'id-{{id}}', url: '{{base}}/app' });
    const { engine, driver, settled } = setup([click('a')], { id: '7', base: 'https://example.test' }, [step]);
    engine.start();
    await settled('completed');
    expect(driver.setupReceived[0]).toMatchObject({ value: 'id-7', url: 'https://example.test/app' });
  });

  it('fails the run before any step when a setup step fails', async () => {
    const setupSteps = [setCookie('ok'), setCookie('bad')];
    const { engine, driver, finished, settled } = setup([click('a')], {}, setupSteps);
    driver.failing.add('setup:bad');
    engine.start();
    await settled('failed');
    expect(driver.ran).toEqual(['setup:ok']);
    expect(engine.snapshot().failure).toMatchObject({
      phase: 'setup',
      stepId: setupSteps[1]!.id,
      stepIndex: 1,
      stepName: 'Set cookie bad',
      action: 'setCookie',
      message: 'Cookie refused',
      url: 'http://example.test/',
    });
    expect(engine.snapshot().statuses[setupSteps[1]!.id]).toBe('failed');
    expect(finished).toEqual(['failed']);
  });

  it('retries only the failed setup step, then carries on', async () => {
    const { engine, driver, settled } = setup([click('a')], {}, [setCookie('ok'), setCookie('bad')]);
    driver.failing.add('setup:bad');
    engine.start();
    await settled('failed');
    driver.failing.clear();
    engine.retry();
    await settled('completed');
    expect(driver.ran).toEqual(['setup:ok', 'setup:bad', 'a']);
  });

  it('can skip a failed setup step and go on to the steps', async () => {
    const setupSteps = [setCookie('bad'), setCookie('next')];
    const { engine, driver, settled } = setup([click('a')], {}, setupSteps);
    driver.failing.add('setup:bad');
    engine.start();
    await settled('failed');
    engine.skipFailed();
    await settled('completed');
    expect(driver.ran).toEqual(['setup:next', 'a']);
    expect(engine.snapshot().statuses[setupSteps[0]!.id]).toBe('skipped');
  });

  it('runs setup again on restart, but not on retrying a later step', async () => {
    const { engine, driver, settled } = setup([click('a')], {}, [setCookie('flag')]);
    driver.failing.add('a');
    engine.start();
    await settled('failed');
    driver.failing.clear();
    engine.retry();
    await settled('completed');
    expect(driver.ran).toEqual(['setup:flag', 'a']);
    engine.restart();
    await settled('completed');
    expect(driver.ran).toEqual(['setup:flag', 'a', 'setup:flag', 'a']);
  });

  it('uses setup edits made while failed', async () => {
    const broken = setCookie('bad');
    const { engine, driver, settled } = setup([click('a')], {}, [broken]);
    driver.failing.add('setup:bad');
    engine.start();
    await settled('failed');
    engine.updateSetup([{ ...broken, action: { type: 'setCookie', name: 'fixed', value: 'x', url: 'http://example.test/' } }]);
    engine.retry();
    await settled('completed');
    expect(driver.ran).toEqual(['setup:fixed', 'a']);
  });
});

describe('manual steps', () => {
  const password = () => newStep({ type: 'input', value: '', redacted: true }, { name: 'password' });

  it('pauses for a withheld value, then continues without executing it', async () => {
    const { engine, driver, settled } = setup([password(), click('next')]);
    engine.start();
    await settled('paused');
    expect(engine.snapshot().pauseReason).toBe('manual');
    expect(driver.ran).toEqual([]);
    engine.resume();
    await settled('completed');
    expect(driver.ran).toEqual(['next']);
  });

  it('runs normally once the step has been given a value', async () => {
    const step = newStep({ type: 'input', value: '{{secret}}', redacted: true }, { name: 'password' });
    const { engine, driver, settled } = setup([step], { secret: 'x' });
    engine.start();
    await settled('completed');
    expect(driver.ran).toEqual(['password']);
  });

  it('passes over an optional step with no value', async () => {
    const step = { ...password(), execution: 'optional' as const };
    const { engine, settled } = setup([step]);
    engine.start();
    await settled('completed');
  });
});

describe('plans', () => {
  const recordingWith = (steps: Step[], partial: Partial<Recording> = {}) => newRecording({ steps, ...partial });
  const noLoader = () => Promise.resolve(undefined);

  it('limits a plan to a range, inclusive at both ends', async () => {
    const steps = ['a', 'b', 'c', 'd'].map((name) => click(name));
    const plan = await buildPlan(recordingWith(steps), { fromStepId: steps[1]!.id, toStepId: steps[2]!.id }, noLoader);
    expect(plan.map((item) => item.step.name)).toEqual(['b', 'c']);
    expect(plan.map((item) => item.rootIndex)).toEqual([1, 2]);
  });

  it('expands nested recordings in place', async () => {
    const inner = recordingWith([click('login'), click('submit')]);
    const outer = recordingWith([
      click('open'),
      newStep({ type: 'runRecording', recordingId: inner.id }, { name: 'run login' }),
      click('after'),
    ]);
    const plan = await buildPlan(outer, {}, async (id) => (id === inner.id ? inner : undefined));
    expect(plan.map((item) => item.step.name)).toEqual(['open', 'run login', 'login', 'submit', 'after']);
    expect(plan[2]!.rootStepId).toBe(outer.steps[1]!.id);
    expect(plan[1]!.childCount).toBe(2);
    expect(plan[3]!.lastOfRoot).toBe(true);
  });

  it('refuses recordings that run themselves', async () => {
    const a = recordingWith([]);
    const b = recordingWith([newStep({ type: 'runRecording', recordingId: a.id })]);
    a.steps = [newStep({ type: 'runRecording', recordingId: b.id })];
    const load = async (id: string) => [a, b].find((recording) => recording.id === id);
    await expect(buildPlan(a, {}, load)).rejects.toThrow(/runs itself/);
  });

  it('makes the contents of an optional nested recording optional', async () => {
    const inner = recordingWith([click('flaky')]);
    const outer = recordingWith([newStep({ type: 'runRecording', recordingId: inner.id }, { execution: 'optional' })]);
    const plan = await buildPlan(outer, {}, async () => inner);
    expect(plan[1]!.step.execution).toBe('optional');
  });

  it('skips the contents along with a skipped nested recording', async () => {
    const parent = newStep({ type: 'runRecording', recordingId: 'x' }, { execution: 'skip', name: 'parent' });
    const child = click('child');
    const after = click('after');
    const plan: PlanItem[] = [
      { key: 'p', step: parent, rootStepId: parent.id, rootIndex: 0, childCount: 1, lastOfRoot: false, depth: 0 },
      { key: 'p/c', step: child, rootStepId: parent.id, rootIndex: 0, childCount: 0, lastOfRoot: true, depth: 1 },
      { key: 'a', step: after, rootStepId: after.id, rootIndex: 1, childCount: 0, lastOfRoot: false, depth: 0 },
    ];
    const driver = new FakeDriver();
    const engine = new PlaybackEngine({
      recordingId: 'r',
      driver,
      plan,
      timings: { defaultTimeoutMs: 100, optionalTimeoutMs: 100, stepDelayMs: 0 },
      variables: {},
      speed: 1,
      onChange: () => undefined,
    });
    engine.start();
    await vi.waitFor(() => expect(engine.mode).toBe('completed'));
    expect(driver.ran).toEqual(['after']);
  });
});
