import type { SetupStep } from './setup';
import type { Step } from './step';

/** 2 added `setup`. */
export const SCHEMA_VERSION = 2;

export interface StepGroup {
  id: string;
  name: string;
  collapsed?: boolean;
}

export interface VariableDef {
  name: string;
  defaultValue: string;
  /** Secret variables are never persisted with a value. They are asked for before each run. */
  secret?: boolean;
}

export interface RecordingMeta {
  id: string;
  name: string;
  description: string;
  tags: string[];
  collectionId: string | null;
  createdAt: number;
  updatedAt: number;
  startUrl: string;
  schemaVersion: number;
  stepCount: number;
}

export interface Recording extends Omit<RecordingMeta, 'stepCount'> {
  steps: Step[];
  groups: StepGroup[];
  variables: VariableDef[];
  /** Runs before the first step of every run, such as setting or deleting cookies. */
  setup: SetupStep[];
}

export interface Collection {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
}

export interface Settings {
  theme: 'system' | 'light' | 'dark';
  defaultTimeoutMs: number;
  /** Optional steps give up sooner, so an absent cookie banner doesn't stall a run. */
  optionalTimeoutMs: number;
  /** Pause between steps at 1x speed. */
  stepDelayMs: number;
  defaultSpeed: number;
  highlightDuringPlayback: boolean;
  captureFormValues: boolean;
  recordScroll: boolean;
  redactUrlParams: boolean;
  /** Elements matching these CSS selectors are never recorded. */
  excludedSelectors: string[];
  /** Playback waits for visible matches of these to disappear before every action. */
  loadingSelectors: string[];
  testIdAttributes: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  defaultTimeoutMs: 10_000,
  optionalTimeoutMs: 2_500,
  stepDelayMs: 200,
  defaultSpeed: 1,
  highlightDuringPlayback: true,
  captureFormValues: true,
  recordScroll: true,
  redactUrlParams: true,
  excludedSelectors: [],
  loadingSelectors: ['[aria-busy="true"]'],
  testIdAttributes: ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa'],
};
