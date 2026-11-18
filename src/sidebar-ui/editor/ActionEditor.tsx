import type { RecordingMeta } from '@shared/model/recording';
import type { Assertion, Step, StepAction, TextMatch, WaitCondition } from '@shared/model/step';
import { CommitInput, Field, NumberInput, Segmented, Toggle } from '../components/ui';

export function MatchEditor({ match, onChange, label }: { match: TextMatch; onChange: (match: TextMatch) => void; label: string }) {
  return (
    <div className="match-editor">
      <select
        className="input"
        aria-label={`${label} comparison`}
        value={match.mode}
        onChange={(event) => onChange({ ...match, mode: event.target.value as TextMatch['mode'] })}
      >
        <option value="contains">contains</option>
        <option value="exact">equals</option>
        <option value="regex">regex</option>
      </select>
      <CommitInput mono label={label} value={match.value} onCommit={(value) => onChange({ ...match, value })} />
    </div>
  );
}

const EMPTY_MATCH: TextMatch = { mode: 'contains', value: '' };

const ASSERTION_LABELS: Record<Assertion['kind'], string> = {
  exists: 'Element exists',
  notExists: 'Element does not exist',
  visible: 'Element is visible',
  hidden: 'Element is hidden',
  text: 'Text',
  value: 'Input value',
  checked: 'Is checked',
  unchecked: 'Is not checked',
  url: 'Page URL',
  title: 'Page title',
  count: 'Number of elements',
};

function defaultAssertion(kind: Assertion['kind']): Assertion {
  if (kind === 'text' || kind === 'value' || kind === 'url' || kind === 'title') return { kind, match: EMPTY_MATCH };
  if (kind === 'count') return { kind, expected: 1, selector: '' };
  return { kind };
}

function AssertionEditor({ assertion, onChange }: { assertion: Assertion; onChange: (assertion: Assertion) => void }) {
  return (
    <>
      <Field label="Check">
        <select
          className="input"
          data-testid="assert-kind"
          value={assertion.kind}
          onChange={(event) => onChange(defaultAssertion(event.target.value as Assertion['kind']))}
        >
          {Object.entries(ASSERTION_LABELS).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
        </select>
      </Field>
      {'match' in assertion && (
        <Field label="Expected">
          <MatchEditor label="Expected value" match={assertion.match} onChange={(match) => onChange({ ...assertion, match })} />
        </Field>
      )}
      {assertion.kind === 'count' && (
        <div className="field-row">
          <Field label="CSS selector">
            <CommitInput mono value={assertion.selector} onCommit={(selector) => onChange({ ...assertion, selector })} />
          </Field>
          <Field label="Expected count">
            <NumberInput value={assertion.expected} onCommit={(expected) => onChange({ ...assertion, expected: expected ?? 0 })} />
          </Field>
        </div>
      )}
    </>
  );
}

const WAIT_LABELS: Record<WaitCondition['kind'], string> = {
  exists: 'Element exists',
  visible: 'Element is visible',
  enabled: 'Element is enabled',
  hidden: 'Element is hidden',
  gone: 'Element disappears',
  text: 'Text appears in the page',
  url: 'URL matches',
  urlChanged: 'URL changes',
  loadingGone: 'Loading indicator disappears',
  delay: 'Fixed delay',
};

function defaultWait(kind: WaitCondition['kind']): WaitCondition {
  if (kind === 'text' || kind === 'url') return { kind, match: EMPTY_MATCH };
  if (kind === 'loadingGone') return { kind, selector: '' };
  if (kind === 'delay') return { kind, ms: 1000 };
  return { kind };
}

function WaitEditor({ condition, onChange }: { condition: WaitCondition; onChange: (condition: WaitCondition) => void }) {
  return (
    <>
      <Field label="Wait until">
        <select
          className="input"
          value={condition.kind}
          onChange={(event) => onChange(defaultWait(event.target.value as WaitCondition['kind']))}
        >
          {Object.entries(WAIT_LABELS).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
        </select>
      </Field>
      {'match' in condition && (
        <Field label="Expected">
          <MatchEditor label="Expected value" match={condition.match} onChange={(match) => onChange({ ...condition, match })} />
        </Field>
      )}
      {condition.kind === 'loadingGone' && (
        <Field label="CSS selector">
          <CommitInput mono value={condition.selector} onCommit={(selector) => onChange({ ...condition, selector })} />
        </Field>
      )}
      {condition.kind === 'delay' && (
        <Field label="Milliseconds">
          <NumberInput value={condition.ms} onCommit={(ms) => onChange({ ...condition, ms: ms ?? 0 })} />
        </Field>
      )}
    </>
  );
}

function listToText(values: string[]): string {
  return values.join(', ');
}

function textToList(text: string): string[] {
  return text.split(',').map((value) => value.trim()).filter(Boolean);
}

interface ActionEditorProps {
  step: Step;
  onChange: (action: StepAction) => void;
  recordings: RecordingMeta[];
  currentRecordingId: string;
}

/** Fields specific to the kind of step. Steps with nothing to edit render nothing. */
export function ActionEditor({ step, onChange, recordings, currentRecordingId }: ActionEditorProps) {
  const { action } = step;
  switch (action.type) {
    case 'navigate':
      return (
        <Field label="URL" hint="Supports variables, like {{baseUrl}}/login.">
          <CommitInput mono value={action.url} onCommit={(url) => onChange({ ...action, url })} />
        </Field>
      );
    case 'urlChange':
      return (
        <Field label="Expected URL" hint="Playback waits for this. It doesn't navigate.">
          <MatchEditor label="Expected URL" match={action.match} onChange={(match) => onChange({ ...action, match })} />
        </Field>
      );
    case 'history':
      return (
        <Field label="Direction">
          <Segmented
            label="Direction"
            value={action.direction}
            onChange={(direction) => onChange({ ...action, direction })}
            options={[{ value: 'back', label: 'Back' }, { value: 'forward', label: 'Forward' }]}
          />
        </Field>
      );
    case 'input':
      return (
        <>
          <Field
            label="Value"
            hint={action.redacted && !action.value
              ? "Not recorded. Playback pauses here so you can type it, or enter a value or {{variable}}."
              : 'Supports variables, like user+{{$timestamp}}@example.com.'}
          >
            <CommitInput
              multiline
              mono
              value={action.value}
              label="Value"
              onCommit={(value) => onChange({ type: 'input', value, ...(action.typing ? { typing: action.typing } : {}) })}
            />
          </Field>
          <Field label="Entry method">
            <Segmented
              label="Entry method"
              value={action.typing ?? 'fill'}
              onChange={(typing) => onChange({ ...action, typing })}
              options={[{ value: 'fill', label: 'Set value' }, { value: 'keystrokes', label: 'Type keys' }]}
            />
          </Field>
        </>
      );
    case 'select':
      return (
        <Field label="Option values" hint="Separate several with commas.">
          <CommitInput
            mono
            value={listToText(action.values)}
            onCommit={(text) => onChange({ ...action, values: textToList(text), labels: [] })}
          />
        </Field>
      );
    case 'check':
      return <Toggle label="Should be checked" checked={action.checked} onChange={(checked) => onChange({ ...action, checked })} />;
    case 'keyPress':
      return (
        <Field label="Key" hint="A KeyboardEvent.key value: Enter, Escape, ArrowDown, a">
          <CommitInput mono value={action.key} onCommit={(key) => onChange({ ...action, key, code: key.length === 1 ? '' : key })} />
        </Field>
      );
    case 'scroll':
      return (
        <div className="field-row">
          <Field label="X">
            <NumberInput value={action.x} onCommit={(x) => onChange({ ...action, x: x ?? 0 })} />
          </Field>
          <Field label="Y">
            <NumberInput value={action.y} onCommit={(y) => onChange({ ...action, y: y ?? 0 })} />
          </Field>
        </div>
      );
    case 'dialog':
      return (
        <>
          <p className="field-hint">The page shows a native {action.kind}: "{action.message}"</p>
          {action.kind !== 'alert' && (
            <Toggle label="Accept" checked={action.accept} onChange={(accept) => onChange({ ...action, accept })} />
          )}
          {action.kind === 'prompt' && (
            <Field label="Answer">
              <CommitInput value={action.promptText ?? ''} onCommit={(promptText) => onChange({ ...action, promptText })} />
            </Field>
          )}
        </>
      );
    case 'wait':
      return <WaitEditor condition={action.condition} onChange={(condition) => onChange({ ...action, condition })} />;
    case 'assert':
      return <AssertionEditor assertion={action.assertion} onChange={(assertion) => onChange({ ...action, assertion })} />;
    case 'runRecording':
      return (
        <Field label="Recording to run">
          <select
            className="input"
            value={action.recordingId}
            onChange={(event) => onChange({ ...action, recordingId: event.target.value })}
          >
            <option value="">Choose a recording</option>
            {recordings
              .filter((recording) => recording.id !== currentRecordingId)
              .map((recording) => <option key={recording.id} value={recording.id}>{recording.name}</option>)}
          </select>
        </Field>
      );
    case 'file':
      return <p className="field-hint">Browsers don't allow extensions to fill file inputs, so playback pauses for you to choose the file.</p>;
    default:
      return null;
  }
}
