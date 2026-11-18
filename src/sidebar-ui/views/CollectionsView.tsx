import { useState } from 'react';
import type { Collection, Recording } from '@shared/model/recording';
import { exportCollection, exportFileName } from '../../storage-engine';
import { downloadJson, storage } from '../api';
import { Button, CommitInput, EmptyState, Field, IconButton, Menu, Modal, formatDate, useConfirm, useToast } from '../components/ui';
import { useCollections, useRecordingList } from '../hooks';
import { useRecordingActions } from '../recording-actions';
import { ExportModal, RecordingRow } from './RecordingRow';

function NewCollectionModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const create = () => {
    if (!name.trim()) return;
    storage.createCollection(name.trim(), description.trim()).then(onClose, toast.error);
  };

  return (
    <Modal
      title="New collection"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim()} onClick={create}>Create</Button>
        </>
      }
    >
      <Field label="Name">
        <input
          className="input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && create()}
        />
      </Field>
      <Field label="Description">
        <textarea className="input" rows={2} value={description} onChange={(event) => setDescription(event.target.value)} />
      </Field>
    </Modal>
  );
}

function CollectionDetail({ collection, onBack, collections }: { collection: Collection; onBack: () => void; collections: Collection[] }) {
  const recordings = useRecordingList();
  const actions = useRecordingActions();
  const toast = useToast();
  const confirm = useConfirm();
  const [exporting, setExporting] = useState(false);
  const members = recordings?.filter((recording) => recording.collectionId === collection.id) ?? [];
  const others = recordings?.filter((recording) => recording.collectionId !== collection.id) ?? [];

  const save = (patch: Partial<Collection>) => {
    storage.saveCollection({ ...collection, ...patch, updatedAt: Date.now() }).catch(toast.error);
  };

  const remove = async () => {
    const confirmed = await confirm({
      title: 'Delete collection?',
      message: `"${collection.name}" will be deleted. The ${members.length} recording${members.length === 1 ? '' : 's'} in it will be kept.`,
      confirmLabel: 'Delete',
    });
    if (!confirmed) return;
    storage.deleteCollection(collection.id).then(onBack, toast.error);
  };

  const runExport = async (stripValues: boolean) => {
    try {
      const full = await Promise.all(members.map((member) => storage.getRecording(member.id)));
      const present = full.filter((recording): recording is Recording => recording !== undefined);
      downloadJson(exportCollection(collection, present, { stripValues }), exportFileName(collection.name));
    } catch (error) {
      toast.error(error);
    }
  };

  return (
    <div className="view">
      <div className="view-toolbar">
        <IconButton icon="chevronLeft" label="Back to collections" onClick={onBack} />
        <div className="grow rec-name">{collection.name}</div>
        <Menu
          label="Add recording"
          icon="plus"
          items={
            others.length > 0
              ? others.map((recording) => ({
                  label: recording.name,
                  onSelect: () => void actions.moveToCollection(recording.id, collection.id),
                }))
              : [{ label: 'No other recordings', disabled: true, onSelect: () => undefined }]
          }
        />
        <Menu
          label="Collection actions"
          items={[
            { label: 'Export collection', icon: 'download', disabled: members.length === 0, onSelect: () => setExporting(true) },
            { label: 'New empty recording', icon: 'plus', onSelect: () => void actions.createEmpty(collection.id) },
            { label: 'Delete collection', icon: 'trash', danger: true, separatorBefore: true, onSelect: () => void remove() },
          ]}
        />
      </div>
      <div className="view-scroll">
        <div className="settings">
          <Field label="Name">
            <CommitInput value={collection.name} onCommit={(name) => name.trim() && save({ name: name.trim() })} />
          </Field>
          <Field label="Description">
            <CommitInput multiline value={collection.description} onCommit={(description) => save({ description })} />
          </Field>
        </div>
        <div className="section-title">Recordings</div>
        {members.length === 0 ? (
          <EmptyState icon="list" title="This collection is empty">
            Add recordings with the + button, or from a recording's menu.
          </EmptyState>
        ) : (
          members.map((meta) => <RecordingRow key={meta.id} meta={meta} collections={collections} />)
        )}
      </div>
      {exporting && <ExportModal title="Export collection" onClose={() => setExporting(false)} onExport={(strip) => void runExport(strip)} />}
    </div>
  );
}

export function CollectionsView() {
  const collections = useCollections();
  const recordings = useRecordingList();
  const actions = useRecordingActions();
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const open = collections.find((collection) => collection.id === openId);
  if (open) return <CollectionDetail collection={open} collections={collections} onBack={() => setOpenId(null)} />;

  const countFor = (id: string) => recordings?.filter((recording) => recording.collectionId === id).length ?? 0;

  return (
    <div className="view">
      <div className="view-toolbar">
        <div className="grow" />
        <Button icon="upload" onClick={() => void actions.importFromFile()}>Import</Button>
        <Button variant="primary" icon="plus" data-testid="new-collection" onClick={() => setCreating(true)}>New collection</Button>
      </div>
      <div className="view-scroll">
        {collections.length === 0 && (
          <EmptyState icon="folder" title="No collections">
            Collections keep related recordings together, and can be exported as one file.
          </EmptyState>
        )}
        {collections.map((collection) => {
          const count = countFor(collection.id);
          return (
            <div
              key={collection.id}
              className="rec-row"
              role="button"
              tabIndex={0}
              onClick={() => setOpenId(collection.id)}
              onKeyDown={(event) => event.key === 'Enter' && setOpenId(collection.id)}
            >
              <div className="rec-main">
                <div className="rec-name">{collection.name}</div>
                {collection.description && <div className="rec-desc">{collection.description}</div>}
                <div className="rec-meta">
                  <span>{count} recording{count === 1 ? '' : 's'}</span>
                  <span>Created {formatDate(collection.createdAt)}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {creating && <NewCollectionModal onClose={() => setCreating(false)} />}
    </div>
  );
}
