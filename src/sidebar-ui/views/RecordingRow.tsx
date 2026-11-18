import { useState } from 'react';
import type { Collection, RecordingMeta } from '@shared/model/recording';
import { useApp } from '../App';
import { storage } from '../api';
import { Button, CommitInput, Field, Menu, Modal, Toggle, formatDate, useToast, type MenuItem } from '../components/ui';
import { useRecordingActions } from '../recording-actions';

export function ExportModal({ onClose, onExport, title }: { onClose: () => void; onExport: (strip: boolean) => void; title: string }) {
  const [strip, setStrip] = useState(false);
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            data-testid="export-confirm"
            onClick={() => {
              onExport(strip);
              onClose();
            }}
          >
            Export
          </Button>
        </>
      }
    >
      <p>The file contains the form values you recorded. Passwords are never included.</p>
      <Toggle checked={strip} onChange={setStrip} label="Remove typed values" hint="For sharing. Those steps will ask for input when played." />
    </Modal>
  );
}

function RenameModal({ meta, onClose }: { meta: RecordingMeta; onClose: () => void }) {
  const toast = useToast();
  return (
    <Modal title="Rename recording" onClose={onClose} footer={<Button onClick={onClose}>Done</Button>}>
      <Field label="Name">
        <CommitInput
          value={meta.name}
          onCommit={(name) => {
            if (!name.trim()) return;
            storage
              .updateRecording(meta.id, (recording) => {
                recording.name = name.trim();
              })
              .catch(toast.error);
          }}
        />
      </Field>
    </Modal>
  );
}

export function RecordingRow({ meta, collections }: { meta: RecordingMeta; collections: Collection[] }) {
  const { openRecording } = useApp();
  const actions = useRecordingActions();
  const [modal, setModal] = useState<'rename' | 'export' | null>(null);

  const items: MenuItem[] = [
    { label: 'Open', icon: 'chevronRight', onSelect: () => openRecording(meta.id) },
    { label: 'Rename', icon: 'text', onSelect: () => setModal('rename') },
    { label: 'Duplicate', icon: 'copy', onSelect: () => void actions.duplicate(meta) },
    { label: 'Export', icon: 'download', onSelect: () => setModal('export') },
    ...collections
      .filter((collection) => collection.id !== meta.collectionId)
      .map((collection, index): MenuItem => ({
        label: `Move to ${collection.name}`,
        icon: 'folder',
        separatorBefore: index === 0,
        onSelect: () => void actions.moveToCollection(meta.id, collection.id),
      })),
    ...(meta.collectionId
      ? [{ label: 'Remove from collection', onSelect: () => void actions.moveToCollection(meta.id, null) }]
      : []),
    { label: 'Delete', icon: 'trash', danger: true, separatorBefore: true, onSelect: () => void actions.remove(meta) },
  ];

  return (
    <>
      <div
        className="rec-row"
        role="button"
        tabIndex={0}
        data-testid="recording-row"
        onClick={() => openRecording(meta.id)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && event.target === event.currentTarget) openRecording(meta.id);
        }}
      >
        <div className="rec-main">
          <div className="rec-name">{meta.name}</div>
          {meta.description && <div className="rec-desc">{meta.description}</div>}
          <div className="rec-meta">
            <span>{meta.stepCount} step{meta.stepCount === 1 ? '' : 's'}</span>
            <span title={new Date(meta.createdAt).toLocaleString()}>Created {formatDate(meta.createdAt)}</span>
            <span title={new Date(meta.updatedAt).toLocaleString()}>Edited {formatDate(meta.updatedAt)}</span>
          </div>
          {meta.tags.length > 0 && (
            <div className="tags">
              {meta.tags.map((tag) => <span key={tag} className="tag">{tag}</span>)}
            </div>
          )}
        </div>
        <div className="rec-actions" onClick={(event) => event.stopPropagation()}>
          <Menu label={`Actions for ${meta.name}`} items={items} />
        </div>
      </div>
      {modal === 'rename' && <RenameModal meta={meta} onClose={() => setModal(null)} />}
      {modal === 'export' && (
        <ExportModal title="Export recording" onClose={() => setModal(null)} onExport={(strip) => void actions.exportOne(meta.id, strip)} />
      )}
    </>
  );
}
