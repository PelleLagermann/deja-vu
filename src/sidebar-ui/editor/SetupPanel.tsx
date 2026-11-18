import type { StepStatus } from '@shared/model/execution';
import type { Recording } from '@shared/model/recording';
import type { CookieSameSite, SetupAction, SetupActionType, SetupStep } from '@shared/model/setup';
import { changeSetupType, newSetupStep, setupActionLabel, setupTitle } from '@shared/setup';
import { Icon } from '../components/Icon';
import { Button, CommitInput, Field, IconButton, Menu, Modal, NumberInput, Toggle } from '../components/ui';
import { StatusMark } from './Timeline';

type RecordingMutator = (mutate: (recording: Recording) => void) => void;

const TYPES: SetupActionType[] = ['setCookie', 'deleteCookie', 'clearCookies'];

const NEW_ACTIONS: Record<SetupActionType, SetupAction> = {
  setCookie: { type: 'setCookie', name: '', value: '' },
  deleteCookie: { type: 'deleteCookie', name: '' },
  clearCookies: { type: 'clearCookies' },
};

const SAME_SITE_OPTIONS: { value: CookieSameSite | ''; label: string }[] = [
  { value: '', label: 'Browser default' },
  { value: 'lax', label: 'Lax' },
  { value: 'strict', label: 'Strict' },
  { value: 'no_restriction', label: 'None' },
];

/** Optional action fields are removed rather than stored empty. */
type OptionalField = 'url' | 'domain' | 'path' | 'secure' | 'httpOnly' | 'sameSite' | 'expiresInDays';

function SetupRow({
  item,
  index,
  count,
  startUrl,
  status,
  change,
  remove,
  move,
}: {
  item: SetupStep;
  index: number;
  count: number;
  startUrl: string;
  status: StepStatus | undefined;
  change: (mutate: (item: SetupStep) => void) => void;
  remove: () => void;
  move: (delta: number) => void;
}) {
  const { action } = item;
  const setRequired = (field: 'name' | 'value', value: string) =>
    change((draft) => {
      (draft.action as Record<string, unknown>)[field] = value;
    });
  const setOptional = (field: OptionalField, value: string | number | boolean | undefined) =>
    change((draft) => {
      const target = draft.action as Record<string, unknown>;
      if (value === undefined || value === '') delete target[field];
      else target[field] = value;
    });

  return (
    <div className={`setup-row ${item.enabled ? '' : 'is-disabled'}`} data-testid="setup-row" data-type={action.type}>
      <div className="setup-row-head">
        <span className="setup-index">{index + 1}</span>
        <select
          className="input"
          aria-label="Setup action"
          data-testid="setup-type"
          value={action.type}
          onChange={(event) =>
            change((draft) => {
              draft.action = changeSetupType(draft.action, event.target.value as SetupActionType);
            })
          }
        >
          {TYPES.map((type) => <option key={type} value={type}>{setupActionLabel(type)}</option>)}
        </select>
        <StatusMark status={status} />
        <IconButton icon="chevronUp" label="Move up" disabled={index === 0} onClick={() => move(-1)} />
        <IconButton icon="chevronDown" label="Move down" disabled={index === count - 1} onClick={() => move(1)} />
        <IconButton icon="close" label={`Remove ${setupTitle(action)}`} onClick={remove} />
      </div>
      <div className="setup-row-fields">
        {action.type !== 'clearCookies' && (
          <Field label="Cookie name">
            <CommitInput mono label="Cookie name" value={action.name} placeholder="session_id" onCommit={(name) => setRequired('name', name.trim())} />
          </Field>
        )}
        {action.type === 'setCookie' && (
          <Field label="Value">
            <CommitInput mono label="Cookie value" value={action.value} placeholder="value or {{variable}}" onCommit={(value) => setRequired('value', value)} />
          </Field>
        )}
        <Field label="Site" hint={action.url ? undefined : 'Empty uses the starting URL.'}>
          <CommitInput mono label="Site" value={action.url ?? ''} placeholder={startUrl || 'https://…'} onCommit={(url) => setOptional('url', url.trim())} />
        </Field>
        {action.type === 'setCookie' && (
          <details className="setup-options">
            <summary>Cookie options</summary>
            <div className="field-row">
              <Field label="Path">
                <CommitInput mono label="Path" value={action.path ?? ''} placeholder="/" onCommit={(path) => setOptional('path', path.trim())} />
              </Field>
              <Field label="Domain" hint="Empty: this host only.">
                <CommitInput mono label="Domain" value={action.domain ?? ''} placeholder=".example.com" onCommit={(domain) => setOptional('domain', domain.trim())} />
              </Field>
            </div>
            <div className="field-row">
              <Field label="Expires in days" hint="Empty: session cookie.">
                <NumberInput label="Expires in days" value={action.expiresInDays} onCommit={(days) => setOptional('expiresInDays', days)} />
              </Field>
              <Field label="SameSite">
                <select className="input" value={action.sameSite ?? ''} onChange={(event) => setOptional('sameSite', event.target.value)}>
                  {SAME_SITE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </Field>
            </div>
            <Toggle label="Secure" hint="Only sent over https." checked={action.secure ?? false} onChange={(secure) => setOptional('secure', secure || undefined)} />
            <Toggle label="HttpOnly" hint="Hidden from the page's scripts." checked={action.httpOnly ?? false} onChange={(httpOnly) => setOptional('httpOnly', httpOnly || undefined)} />
          </details>
        )}
        <Toggle
          label="Enabled"
          checked={item.enabled}
          onChange={(enabled) =>
            change((draft) => {
              draft.enabled = enabled;
            })
          }
        />
      </div>
    </div>
  );
}

export function SetupModal({
  recording,
  statuses,
  update,
  onClose,
}: {
  recording: Recording;
  statuses: Record<string, StepStatus>;
  update: RecordingMutator;
  onClose: () => void;
}) {
  const changeItem = (id: string) => (mutate: (item: SetupStep) => void) =>
    update((draft) => {
      const item = draft.setup.find((candidate) => candidate.id === id);
      if (item) mutate(item);
    });
  const add = (type: SetupActionType) =>
    update((draft) => {
      draft.setup.push(newSetupStep(structuredClone(NEW_ACTIONS[type])));
    });

  return (
    <Modal title="Setup" onClose={onClose} footer={<Button onClick={onClose}>Done</Button>}>
      <p className="field-hint">
        Runs in this order before the first step of every run, including partial runs. Use it to put cookies in a known
        state. Names, values and sites can use {'{{variables}}'}.
      </p>
      {recording.setup.map((item, index) => (
        <SetupRow
          key={item.id}
          item={item}
          index={index}
          count={recording.setup.length}
          startUrl={recording.startUrl}
          status={statuses[item.id]}
          change={changeItem(item.id)}
          remove={() =>
            update((draft) => {
              draft.setup = draft.setup.filter((candidate) => candidate.id !== item.id);
            })
          }
          move={(delta) =>
            update((draft) => {
              const from = draft.setup.findIndex((candidate) => candidate.id === item.id);
              const to = from + delta;
              if (from < 0 || to < 0 || to >= draft.setup.length) return;
              const [moved] = draft.setup.splice(from, 1);
              draft.setup.splice(to, 0, moved!);
            })
          }
        />
      ))}
      <Menu
        label="Add setup step"
        trigger={<><Icon name="plus" size={14} /> Add setup step</>}
        items={TYPES.map((type) => ({ label: setupActionLabel(type), onSelect: () => add(type) }))}
      />
    </Modal>
  );
}

function overallStatus(setup: SetupStep[], statuses: Record<string, StepStatus>): StepStatus | undefined {
  const all = setup.filter((item) => item.enabled).map((item) => statuses[item.id]);
  if (all.includes('failed')) return 'failed';
  if (all.includes('running')) return 'running';
  if (all.length > 0 && all.every((status) => status === 'passed' || status === 'skipped')) return 'passed';
  return undefined;
}

/** One line above the steps that says what happens before them. */
export function SetupSummary({
  setup,
  statuses,
  onOpen,
}: {
  setup: SetupStep[];
  statuses: Record<string, StepStatus>;
  onOpen: () => void;
}) {
  const enabled = setup.filter((item) => item.enabled);
  const text = enabled.length ? enabled.map((item) => setupTitle(item.action)).join(', ') : 'All setup steps are disabled';
  return (
    <button type="button" className="setup-summary" data-testid="setup-summary" onClick={onOpen} title="Edit setup">
      <Icon name="cookie" size={13} />
      <span className="setup-summary-label">Setup</span>
      <span className="setup-summary-text">{text}</span>
      <StatusMark status={overallStatus(setup, statuses)} />
    </button>
  );
}
