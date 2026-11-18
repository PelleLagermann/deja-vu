import type { Recording } from '@shared/model/recording';
import type { Step } from '@shared/model/step';

export interface PlanRange {
  fromStepId?: string;
  toStepId?: string;
}

/** One unit of work in a run. Nested recordings are flattened into the same list. */
export interface PlanItem {
  /** Unique within the plan, stable across rebuilds. */
  key: string;
  step: Step;
  /** The step of the opened recording this item belongs to, and its position there. */
  rootStepId: string;
  rootIndex: number;
  /** For a `runRecording` step: the number of items directly after it that it contains. */
  childCount: number;
  /** True for a `runRecording` step whose recording exists. It's only a heading for its contents. */
  isContainer?: boolean;
  /** True for the final item nested under its root step. */
  lastOfRoot: boolean;
  depth: number;
}

export type RecordingLoader = (id: string) => Promise<Recording | undefined>;

export class PlanError extends Error {}

async function expand(
  recording: Recording,
  steps: Step[],
  root: { id: string; index: number } | null,
  keyPrefix: string,
  ancestry: string[],
  load: RecordingLoader,
): Promise<PlanItem[]> {
  const items: PlanItem[] = [];
  for (const [index, step] of steps.entries()) {
    const rootStepId = root?.id ?? step.id;
    const rootIndex = root?.index ?? index;
    const key = `${keyPrefix}${step.id}`;
    const item: PlanItem = {
      key,
      step,
      rootStepId,
      rootIndex,
      childCount: 0,
      lastOfRoot: false,
      depth: ancestry.length - 1,
    };
    items.push(item);
    if (step.action.type !== 'runRecording') continue;

    const { recordingId } = step.action;
    if (ancestry.includes(recordingId)) {
      throw new PlanError(`"${recording.name}" runs itself through step ${index + 1}. Remove the loop to continue.`);
    }
    const child = await load(recordingId);
    if (!child) continue; // The driver reports this when the step runs.

    const children = await expand(
      child,
      child.steps,
      { id: rootStepId, index: rootIndex },
      `${key}/`,
      [...ancestry, recordingId],
      load,
    );
    item.childCount = children.length;
    item.isContainer = true;
    // An optional parent makes its contents optional, otherwise a failure inside would stop the run.
    if (step.execution === 'optional') {
      for (const nested of children) {
        if (nested.step.execution === 'required') nested.step = { ...nested.step, execution: 'optional' };
      }
    }
    items.push(...children);
  }
  return items;
}

/** Turns a recording and a range into the flat list of things to run. */
export async function buildPlan(recording: Recording, range: PlanRange, load: RecordingLoader): Promise<PlanItem[]> {
  const fromIndex = range.fromStepId ? recording.steps.findIndex((step) => step.id === range.fromStepId) : 0;
  const toIndex = range.toStepId ? recording.steps.findIndex((step) => step.id === range.toStepId) : recording.steps.length - 1;
  const start = Math.max(fromIndex, 0);
  const end = toIndex < 0 ? recording.steps.length - 1 : toIndex;

  const items = await expand(recording, recording.steps, null, '', [recording.id], load);
  const selected = items.filter((item) => item.rootIndex >= start && item.rootIndex <= end);
  for (let i = 0; i < selected.length; i++) {
    const item = selected[i]!;
    const next = selected[i + 1];
    item.lastOfRoot = item.depth > 0 && next?.rootStepId !== item.rootStepId;
  }
  return selected;
}
