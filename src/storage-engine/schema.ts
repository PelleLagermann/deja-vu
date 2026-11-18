import { SCHEMA_VERSION, type Collection, type Recording } from '@shared/model/recording';
import { SELECTOR_PRIORITY } from '@shared/model/selector';
import type { SetupActionType } from '@shared/model/setup';
import type { ActionType } from '@shared/model/step';

export const EXPORT_FORMAT = 'deja-vu-export';

export interface ExportFile {
  format: typeof EXPORT_FORMAT;
  schemaVersion: number;
  exportedAt: string;
  kind: 'recording' | 'collection';
  collection?: Pick<Collection, 'name' | 'description'>;
  recordings: Recording[];
}

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

type Migration = (file: Record<string, unknown>) => Record<string, unknown>;

/**
 * Upgrades from each older version to the next. When the schema changes, bump
 * SCHEMA_VERSION and add an entry here. Recordings in IndexedDB go through the same path.
 */
export const MIGRATIONS: Record<number, Migration> = {
  1: (file) => ({
    ...file,
    recordings: Array.isArray(file['recordings'])
      ? file['recordings'].map((recording: unknown) =>
          isObject(recording) ? { ...recording, setup: recording['setup'] ?? [], schemaVersion: 2 } : recording,
        )
      : file['recordings'],
  }),
};

export function migrate(raw: Record<string, unknown>, migrations: Record<number, Migration> = MIGRATIONS, target = SCHEMA_VERSION): Record<string, unknown> {
  let file = raw;
  const declared = file['schemaVersion'];
  if (typeof declared !== 'number' || !Number.isInteger(declared) || declared < 1) {
    throw new ImportError('The file has no valid schemaVersion.');
  }
  let version = declared;
  if (version > target) {
    throw new ImportError(
      `This file uses schema version ${version}, but this version of the extension only reads up to ${target}. Update the extension first.`,
    );
  }
  while (version < target) {
    const step = migrations[version];
    if (!step) throw new ImportError(`There is no upgrade path from schema version ${version}.`);
    version += 1;
    file = { ...step(file), schemaVersion: version };
  }
  return file;
}

const ACTION_TYPES: ReadonlySet<string> = new Set<ActionType>([
  'navigate', 'reload', 'history', 'urlChange', 'click', 'doubleClick', 'contextMenu', 'hover', 'dragDrop',
  'input', 'select', 'check', 'keyPress', 'scroll', 'file', 'dialog', 'wait', 'assert', 'runRecording',
]);

/** Fields each action can't work without. */
const REQUIRED_ACTION_FIELDS: Partial<Record<ActionType, Record<string, string>>> = {
  navigate: { url: 'string' },
  history: { direction: 'string' },
  urlChange: { match: 'object' },
  dragDrop: { mode: 'string', destination: 'object' },
  input: { value: 'string' },
  select: { values: 'object', labels: 'object' },
  check: { checked: 'boolean' },
  keyPress: { key: 'string', code: 'string' },
  scroll: { x: 'number', y: 'number' },
  dialog: { kind: 'string', accept: 'boolean', message: 'string' },
  wait: { condition: 'object' },
  assert: { assertion: 'object' },
  runRecording: { recordingId: 'string' },
};

const FORBIDDEN_URL = /^\s*(javascript|data|vbscript|chrome|resource|moz-extension|about):/i;
const SELECTOR_KINDS: ReadonlySet<string> = new Set(SELECTOR_PRIORITY);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(path: string, problem: string): never {
  throw new ImportError(`${path}: ${problem}`);
}

function expectType(value: unknown, type: string, path: string): void {
  const matches = type === 'object' ? typeof value === 'object' && value !== null : typeof value === type;
  if (!matches) fail(path, `expected ${type}, got ${value === null ? 'null' : typeof value}`);
}

function validateTarget(value: unknown, path: string): void {
  if (!isObject(value)) fail(path, 'expected an object');
  if (!Array.isArray(value['selectors'])) fail(`${path}.selectors`, 'expected an array');
  value['selectors'].forEach((selector, index) => {
    const selectorPath = `${path}.selectors[${index}]`;
    if (!isObject(selector)) fail(selectorPath, 'expected an object');
    if (!SELECTOR_KINDS.has(String(selector['kind']))) fail(`${selectorPath}.kind`, `unknown kind "${String(selector['kind'])}"`);
    expectType(selector['value'], 'string', `${selectorPath}.value`);
  });
  if (!isObject(value['fingerprint'])) fail(`${path}.fingerprint`, 'expected an object');
  expectType(value['fingerprint']['tag'], 'string', `${path}.fingerprint.tag`);
  expectType(value['summary'], 'string', `${path}.summary`);
}

function validateStep(value: unknown, path: string): void {
  if (!isObject(value)) fail(path, 'expected an object');
  expectType(value['id'], 'string', `${path}.id`);
  if (!['required', 'optional', 'skip'].includes(String(value['execution']))) {
    fail(`${path}.execution`, `must be required, optional or skip, got "${String(value['execution'])}"`);
  }
  if (!isObject(value['wait'])) fail(`${path}.wait`, 'expected an object');

  const action = value['action'];
  if (!isObject(action)) fail(`${path}.action`, 'expected an object');
  const type = String(action['type']);
  if (!ACTION_TYPES.has(type)) fail(`${path}.action.type`, `unknown action "${type}"`);
  for (const [field, fieldType] of Object.entries(REQUIRED_ACTION_FIELDS[type as ActionType] ?? {})) {
    expectType(action[field], fieldType, `${path}.action.${field}`);
  }
  // Recordings get shared. A navigate step must not be a way of running code in a page.
  if (type === 'navigate' && FORBIDDEN_URL.test(action['url'] as string)) {
    fail(`${path}.action.url`, 'only web addresses can be navigated to');
  }
  if (type === 'dragDrop') validateTarget(action['destination'], `${path}.action.destination`);
  if (value['target'] !== undefined) validateTarget(value['target'], `${path}.target`);
}

const SETUP_TYPES: ReadonlySet<string> = new Set<SetupActionType>(['setCookie', 'deleteCookie', 'clearCookies']);
const SAME_SITE: ReadonlySet<string> = new Set(['no_restriction', 'lax', 'strict']);
/** A setup URL is a web address, or a variable that becomes one. */
const SETUP_URL = /^\s*(https?:\/\/|\{\{)/i;

function validateSetupStep(value: unknown, path: string): void {
  if (!isObject(value)) fail(path, 'expected an object');
  expectType(value['id'], 'string', `${path}.id`);
  expectType(value['enabled'], 'boolean', `${path}.enabled`);
  const action = value['action'];
  if (!isObject(action)) fail(`${path}.action`, 'expected an object');
  const type = String(action['type']);
  if (!SETUP_TYPES.has(type)) fail(`${path}.action.type`, `unknown setup action "${type}"`);
  if (type !== 'clearCookies') expectType(action['name'], 'string', `${path}.action.name`);
  if (type === 'setCookie') expectType(action['value'], 'string', `${path}.action.value`);
  // Recordings get shared. Setup must only ever touch web sites.
  if (action['url'] !== undefined) {
    expectType(action['url'], 'string', `${path}.action.url`);
    const url = action['url'] as string;
    if (url.trim() && !SETUP_URL.test(url)) fail(`${path}.action.url`, 'must be an http or https address');
  }
  for (const field of ['domain', 'path']) {
    if (action[field] !== undefined) expectType(action[field], 'string', `${path}.action.${field}`);
  }
  for (const field of ['secure', 'httpOnly']) {
    if (action[field] !== undefined) expectType(action[field], 'boolean', `${path}.action.${field}`);
  }
  if (action['expiresInDays'] !== undefined) expectType(action['expiresInDays'], 'number', `${path}.action.expiresInDays`);
  if (action['sameSite'] !== undefined && !SAME_SITE.has(String(action['sameSite']))) {
    fail(`${path}.action.sameSite`, 'must be no_restriction, lax or strict');
  }
}

function validateRecording(value: unknown, path: string): void {
  if (!isObject(value)) fail(path, 'expected an object');
  for (const field of ['id', 'name']) expectType(value[field], 'string', `${path}.${field}`);
  if (!Array.isArray(value['steps'])) fail(`${path}.steps`, 'expected an array');
  value['steps'].forEach((step, index) => validateStep(step, `${path}.steps[${index}]`));
  if (value['setup'] !== undefined) {
    if (!Array.isArray(value['setup'])) fail(`${path}.setup`, 'expected an array');
    value['setup'].forEach((item, index) => validateSetupStep(item, `${path}.setup[${index}]`));
  }
  for (const field of ['groups', 'variables', 'tags']) {
    if (value[field] !== undefined && !Array.isArray(value[field])) fail(`${path}.${field}`, 'expected an array');
  }
}

/** Parses and checks an export file. Throws an ImportError that says exactly what is wrong. */
export function parseExportFile(text: string): ExportFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ImportError("The file isn't valid JSON.");
  }
  if (!isObject(raw) || raw['format'] !== EXPORT_FORMAT) {
    throw new ImportError("This isn't a Déjà Vu export file.");
  }
  const file = migrate(raw);
  if (file['kind'] !== 'recording' && file['kind'] !== 'collection') {
    fail('kind', 'must be recording or collection');
  }
  if (!Array.isArray(file['recordings']) || file['recordings'].length === 0) {
    fail('recordings', 'expected at least one recording');
  }
  file['recordings'].forEach((recording, index) => validateRecording(recording, `recordings[${index}]`));
  if (file['kind'] === 'collection') {
    const collection = file['collection'];
    if (!isObject(collection)) fail('collection', 'expected an object');
    expectType(collection['name'], 'string', 'collection.name');
  }
  return file as unknown as ExportFile;
}
