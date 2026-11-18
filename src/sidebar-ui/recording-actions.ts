import { useMemo } from 'react';
import type { RecordingMeta } from '@shared/model/recording';
import { duplicateRecording, newRecording } from '@shared/steps';
import { exportFileName, exportRecording, importFile } from '../storage-engine';
import { useApp } from './App';
import { chooseFile, downloadJson, storage } from './api';
import { useConfirm, useToast } from './components/ui';

/** Actions on whole recordings, shared by every view that lists them. */
export function useRecordingActions() {
  const { openRecording } = useApp();
  const toast = useToast();
  const confirm = useConfirm();

  return useMemo(
    () => ({
      async createEmpty(collectionId: string | null = null) {
        const recording = newRecording({ collectionId });
        await storage.saveRecording(recording).catch(toast.error);
        openRecording(recording.id);
      },

      async duplicate(meta: Pick<RecordingMeta, 'id' | 'name'>) {
        try {
          const source = await storage.getRecording(meta.id);
          if (!source) return;
          await storage.saveRecording(duplicateRecording(source, `${meta.name} (copy)`));
          toast.info('Recording duplicated');
        } catch (error) {
          toast.error(error);
        }
      },

      /** Returns whether it was deleted. */
      async remove(meta: Pick<RecordingMeta, 'id' | 'name'>): Promise<boolean> {
        const confirmed = await confirm({
          title: 'Delete recording?',
          message: `"${meta.name}" and its run history will be deleted. This can't be undone.`,
          confirmLabel: 'Delete',
        });
        if (!confirmed) return false;
        try {
          await storage.deleteRecording(meta.id);
          return true;
        } catch (error) {
          toast.error(error);
          return false;
        }
      },

      async exportOne(id: string, stripValues: boolean) {
        try {
          const recording = await storage.getRecording(id);
          if (!recording) return;
          downloadJson(exportRecording(recording, { stripValues }), exportFileName(recording.name));
        } catch (error) {
          toast.error(error);
        }
      },

      async importFromFile() {
        const file = await chooseFile('.json,application/json');
        if (!file) return;
        try {
          const result = await importFile(storage, await file.text());
          const count = result.recordings.length;
          toast.info(
            result.collection
              ? `Imported "${result.collection.name}" with ${count} recording${count === 1 ? '' : 's'}`
              : `Imported "${result.recordings[0]!.name}"`,
          );
        } catch (error) {
          toast.error(error);
        }
      },

      async moveToCollection(id: string, collectionId: string | null) {
        await storage
          .updateRecording(id, (recording) => {
            recording.collectionId = collectionId;
          })
          .catch(toast.error);
      },
    }),
    [confirm, openRecording, toast],
  );
}
