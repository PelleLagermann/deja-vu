import { useState } from 'react';
import type { Collection, Recording, VariableDef } from '@shared/model/recording';
import { Button, CommitInput, Field, IconButton, Modal, Toggle } from '../components/ui';
import type { VariablePrompt } from './usePlayback';

type RecordingMutator = (mutate: (recording: Recording) => void) => void;

export function DetailsModal({
  recording,
  collections,
  update,
  onClose,
}: {
  recording: Recording;
  collections: Collection[];
  update: RecordingMutator;
  onClose: () => void;
}) {
  return (
    <Modal title="Recording details" onClose={onClose} footer={<Button onClick={onClose}>Done</Button>}>
      <Field label="Name">
        <CommitInput
          value={recording.name}
          onCommit={(name) =>
            name.trim() &&
            update((draft) => {
              draft.name = name.trim();
            })
          }
        />
      </Field>
      <Field label="Description">
        <CommitInput
          multiline
          value={recording.description}
          onCommit={(description) =>
            update((draft) => {
              draft.description = description;
            })
          }
        />
      </Field>
      <Field label="Tags" hint="Separate with commas.">
        <CommitInput
          value={recording.tags.join(', ')}
          onCommit={(text) =>
            update((draft) => {
              draft.tags = text.split(',').map((tag) => tag.trim()).filter(Boolean);
            })
          }
        />
      </Field>
      <Field label="Collection">
        <select
          className="input"
          value={recording.collectionId ?? ''}
          onChange={(event) =>
            update((draft) => {
              draft.collectionId = event.target.value || null;
            })
          }
        >
          <option value="">None</option>
          {collections.map((collection) => <option key={collection.id} value={collection.id}>{collection.name}</option>)}
        </select>
      </Field>
      <Field label="Starting URL">
        <CommitInput
          mono
          value={recording.startUrl}
          onCommit={(startUrl) =>
            update((draft) => {
              draft.startUrl = startUrl;
            })
          }
        />
      </Field>
    </Modal>
  );
}

export function VariablesModal({ recording, update, onClose }: { recording: Recording; update: RecordingMutator; onClose: () => void }) {
  const change = (index: number, patch: Partial<VariableDef>) =>
    update((draft) => {
      draft.variables = draft.variables.map((variable, i) => (i === index ? { ...variable, ...patch } : variable));
    });

  return (
    <Modal title="Variables" onClose={onClose} footer={<Button onClick={onClose}>Done</Button>}>
      <p className="field-hint">
        Use {'{{name}}'} in values, URLs and assertions. Built in: {'{{$timestamp}}'}, {'{{$date}}'}, {'{{$uuid}}'}, {'{{$random}}'}.
        Secret variables are asked for at each run and are never stored.
      </p>
      {recording.variables.map((variable, index) => (
        <div key={index} className="variable-row">
          <CommitInput mono label="Variable name" placeholder="name" value={variable.name} onCommit={(name) => change(index, { name: name.trim() })} />
          {variable.secret ? (
            <span className="field-hint">asked at each run</span>
          ) : (
            <CommitInput label="Default value" placeholder="value" value={variable.defaultValue} onCommit={(defaultValue) => change(index, { defaultValue })} />
          )}
          <Toggle label="Secret" checked={variable.secret ?? false} onChange={(secret) => change(index, { secret, defaultValue: '' })} />
          <IconButton
            icon="close"
            label={`Remove ${variable.name}`}
            onClick={() =>
              update((draft) => {
                draft.variables = draft.variables.filter((_, i) => i !== index);
              })
            }
          />
        </div>
      ))}
      <Button
        icon="plus"
        onClick={() =>
          update((draft) => {
            draft.variables = [...draft.variables, { name: `var${draft.variables.length + 1}`, defaultValue: '' }];
          })
        }
      >
        Add variable
      </Button>
    </Modal>
  );
}

export function VariablePromptModal({
  prompt,
  onSubmit,
  onCancel,
}: {
  prompt: VariablePrompt;
  onSubmit: (values: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(prompt.fields.map((field) => [field.name, field.defaultValue])),
  );
  return (
    <Modal
      title="Values for this run"
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" icon="play" data-testid="prompt-run" onClick={() => onSubmit(values)}>Run</Button>
        </>
      }
    >
      {prompt.fields.map((field) => (
        <Field key={field.name} label={field.name}>
          <input
            className="input"
            type={field.secret ? 'password' : 'text'}
            autoComplete="off"
            value={values[field.name] ?? ''}
            onChange={(event) => setValues({ ...values, [field.name]: event.target.value })}
          />
        </Field>
      ))}
    </Modal>
  );
}

export function NameModal({
  title,
  label,
  initial,
  onSubmit,
  onClose,
}: {
  title: string;
  label: string;
  initial: string;
  onSubmit: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial);
  const submit = () => {
    if (!name.trim()) return;
    onSubmit(name.trim());
    onClose();
  };
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" data-testid="name-confirm" disabled={!name.trim()} onClick={submit}>OK</Button>
        </>
      }
    >
      <Field label={label}>
        <input
          className="input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && submit()}
        />
      </Field>
    </Modal>
  );
}
