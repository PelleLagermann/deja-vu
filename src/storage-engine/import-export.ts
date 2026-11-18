import { SCHEMA_VERSION, type Collection, type Recording } from '@shared/model/recording';
import type { SetupStep } from '@shared/model/setup';
import type { Step } from '@shared/model/step';
import { createId } from '@shared/util';
import type { Storage } from './db';
import { EXPORT_FORMAT, parseExportFile, type ExportFile } from './schema';

export interface ExportOptions {
  /** Removes typed values, so the file can go to someone else without them. */
  stripValues?: boolean;
}

function stripStepValues(step: Step): Step {
  return step.action.type === 'input'
    ? { ...step, action: { ...step.action, value: '', redacted: true } }
    : step;
}

/** Cookie values are often session tokens, so they go along with typed values. */
function stripSetupValues(item: SetupStep): SetupStep {
  return item.action.type === 'setCookie' ? { ...item, action: { ...item.action, value: '' } } : item;
}

function prepareForExport(recording: Recording, options: ExportOptions): Recording {
  return {
    ...recording,
    schemaVersion: SCHEMA_VERSION,
    variables: recording.variables.map((variable) =>
      variable.secret || options.stripValues ? { ...variable, defaultValue: '' } : variable,
    ),
    setup: options.stripValues ? recording.setup.map(stripSetupValues) : recording.setup,
    steps: options.stripValues ? recording.steps.map(stripStepValues) : recording.steps,
  };
}

export function exportRecording(recording: Recording, options: ExportOptions = {}): ExportFile {
  return {
    format: EXPORT_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    kind: 'recording',
    recordings: [prepareForExport(recording, options)],
  };
}

export function exportCollection(collection: Collection, recordings: Recording[], options: ExportOptions = {}): ExportFile {
  return {
    format: EXPORT_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    kind: 'collection',
    collection: { name: collection.name, description: collection.description },
    recordings: recordings.map((recording) => prepareForExport(recording, options)),
  };
}

export interface ImportResult {
  recordings: Recording[];
  collection: Collection | null;
}

/** Everything gets a new ID, so importing never overwrites anything and can be repeated. */
export async function importFile(storage: Storage, text: string): Promise<ImportResult> {
  const file = parseExportFile(text);
  const collection = file.kind === 'collection'
    ? await storage.createCollection(file.collection!.name, file.collection!.description ?? '')
    : null;

  const recordingIds = new Map(file.recordings.map((recording) => [recording.id, createId('rec')]));
  const now = Date.now();
  const imported: Recording[] = file.recordings.map((source) => {
    const groupIds = new Map((source.groups ?? []).map((group) => [group.id, createId('grp')]));
    return {
      id: recordingIds.get(source.id)!,
      name: source.name,
      description: source.description ?? '',
      tags: source.tags ?? [],
      collectionId: collection?.id ?? null,
      createdAt: source.createdAt ?? now,
      updatedAt: now,
      startUrl: source.startUrl ?? '',
      schemaVersion: SCHEMA_VERSION,
      groups: (source.groups ?? []).map((group) => ({ ...group, id: groupIds.get(group.id)! })),
      variables: source.variables ?? [],
      setup: (source.setup ?? []).map((item) => ({ ...item, id: createId('setup') })),
      steps: source.steps.map((step) => {
        const remapped: Step = { ...step, id: createId('step') };
        if (step.groupId) {
          const groupId = groupIds.get(step.groupId);
          if (groupId) remapped.groupId = groupId;
          else delete remapped.groupId;
        }
        // Keep references between recordings in the same file pointing at each other.
        if (step.action.type === 'runRecording') {
          const recordingId = recordingIds.get(step.action.recordingId);
          if (recordingId) remapped.action = { ...step.action, recordingId };
        }
        return remapped;
      }),
    };
  });

  for (const recording of imported) await storage.saveRecording(recording);
  return { recordings: imported, collection };
}

export function exportFileName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'recording';
  return `${slug}.dejavu.json`;
}
