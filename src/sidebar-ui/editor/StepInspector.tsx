import type { RecordingMeta } from '@shared/model/recording';
import { stepNeedsTarget, type ExecutionType, type Step, type StepCondition, type WaitConfig } from '@shared/model/step';
import { stepTitle } from '@shared/steps';
import { CommitInput, Field, IconButton, NumberInput, Segmented, Toggle } from '../components/ui';
import { ActionEditor, MatchEditor } from './ActionEditor';
import { TargetEditor } from './TargetEditor';

export const EXECUTION_OPTIONS: { value: ExecutionType; label: string }[] = [
  { value: 'required', label: 'Required' },
  { value: 'optional', label: 'Optional' },
  { value: 'skip', label: 'Skip' },
];

const EXECUTION_HINT: Record<ExecutionType, string> = {
  required: 'Playback stops if this step fails.',
  optional: "Attempted, but playback carries on if it can't be done. Good for things like cookie banners.",
  skip: 'Stays in the recording, but never runs.',
};

const CONDITION_LABELS: Record<StepCondition['kind'] | 'none', string> = {
  none: 'Always run',
  elementExists: 'Only if an element exists',
  elementMissing: 'Only if an element is missing',
  urlMatches: 'Only if the URL matches',
  variableEquals: 'Only if a variable equals',
};

function defaultCondition(kind: StepCondition['kind']): StepCondition {
  switch (kind) {
    case 'elementExists':
    case 'elementMissing':
      return { kind, selector: '' };
    case 'urlMatches':
      return { kind, match: { mode: 'contains', value: '' } };
    case 'variableEquals':
      return { kind, variable: '', value: '' };
  }
}

function ConditionEditor({ condition, onChange }: { condition: StepCondition | undefined; onChange: (condition: StepCondition | undefined) => void }) {
  return (
    <>
      <Field label="Condition">
        <select
          className="input"
          value={condition?.kind ?? 'none'}
          onChange={(event) => {
            const kind = event.target.value as StepCondition['kind'] | 'none';
            onChange(kind === 'none' ? undefined : defaultCondition(kind));
          }}
        >
          {Object.entries(CONDITION_LABELS).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
        </select>
      </Field>
      {(condition?.kind === 'elementExists' || condition?.kind === 'elementMissing') && (
        <Field label="CSS selector">
          <CommitInput mono value={condition.selector} onCommit={(selector) => onChange({ ...condition, selector })} />
        </Field>
      )}
      {condition?.kind === 'urlMatches' && (
        <Field label="URL">
          <MatchEditor label="URL" match={condition.match} onChange={(match) => onChange({ ...condition, match })} />
        </Field>
      )}
      {condition?.kind === 'variableEquals' && (
        <div className="field-row">
          <Field label="Variable">
            <CommitInput mono value={condition.variable} onCommit={(variable) => onChange({ ...condition, variable })} />
          </Field>
          <Field label="Value">
            <CommitInput value={condition.value} onCommit={(value) => onChange({ ...condition, value })} />
          </Field>
        </div>
      )}
    </>
  );
}

interface StepInspectorProps {
  step: Step;
  index: number;
  stepCount: number;
  recordingId: string;
  recordings: RecordingMeta[];
  onPatch: (mutate: (step: Step) => void) => void;
  onMove: (delta: number) => void;
}

export function StepInspector({ step, index, stepCount, recordingId, recordings, onPatch, onMove }: StepInspectorProps) {
  const setWait = (change: Partial<WaitConfig>) => {
    onPatch((draft) => {
      draft.wait = { ...draft.wait, ...change };
      for (const key of Object.keys(change) as (keyof WaitConfig)[]) {
        if (change[key] === undefined || change[key] === '') delete draft.wait[key];
      }
    });
  };

  const showsTarget = step.target !== undefined || stepNeedsTarget(step.action) || step.action.type === 'keyPress';

  return (
    <div className="inspector" data-testid="inspector">
      <div className="inspector-section">
        <Field label="Name">
          <CommitInput
            value={step.name ?? ''}
            placeholder={stepTitle({ ...step, name: undefined })}
            label="Step name"
            onCommit={(name) =>
              onPatch((draft) => {
                if (name.trim()) draft.name = name.trim();
                else delete draft.name;
              })
            }
          />
        </Field>
        <Field label="Comment">
          <CommitInput
            multiline
            value={step.description ?? ''}
            label="Step comment"
            onCommit={(description) =>
              onPatch((draft) => {
                if (description.trim()) draft.description = description;
                else delete draft.description;
              })
            }
          />
        </Field>
        <Field label="When playing" hint={EXECUTION_HINT[step.execution]}>
          <Segmented
            label="Execution type"
            value={step.execution}
            options={EXECUTION_OPTIONS}
            onChange={(execution) =>
              onPatch((draft) => {
                draft.execution = execution;
              })
            }
          />
        </Field>
      </div>

      <div className="inspector-section">
        <ActionEditor
          step={step}
          recordings={recordings}
          currentRecordingId={recordingId}
          onChange={(action) =>
            onPatch((draft) => {
              draft.action = action;
            })
          }
        />
      </div>

      {showsTarget && (
        <div className="inspector-section">
          <div className="inspector-heading">Target element</div>
          <TargetEditor
            label="Selectors"
            target={step.target}
            onChange={(target) =>
              onPatch((draft) => {
                draft.target = target;
              })
            }
          />
          {step.action.type === 'dragDrop' && (
            <>
              <div className="inspector-heading">Drop target</div>
              <TargetEditor
                label="Selectors"
                target={step.action.destination}
                onChange={(destination) =>
                  onPatch((draft) => {
                    if (draft.action.type === 'dragDrop') draft.action.destination = destination;
                  })
                }
              />
            </>
          )}
        </div>
      )}

      <details className="inspector-section inspector-more">
        <summary>Timing and conditions</summary>
        <div className="field-row">
          <Field label="Timeout (ms)">
            <NumberInput
              label="Timeout in milliseconds"
              placeholder={step.execution === 'optional' ? 'Optional default' : 'Default'}
              value={step.wait.timeoutMs}
              onCommit={(timeoutMs) => setWait({ timeoutMs })}
            />
          </Field>
          <Field label="Delay before (ms)">
            <NumberInput placeholder="0" value={step.wait.preDelayMs} onCommit={(preDelayMs) => setWait({ preDelayMs })} />
          </Field>
          <Field label="Delay after (ms)">
            <NumberInput placeholder="0" value={step.wait.postDelayMs} onCommit={(postDelayMs) => setWait({ postDelayMs })} />
          </Field>
        </div>
        <Field label="Wait for this to disappear first" hint="CSS selector, such as a spinner.">
          <CommitInput mono value={step.wait.waitForGone ?? ''} onCommit={(waitForGone) => setWait({ waitForGone })} />
        </Field>
        <Toggle
          label="Force"
          hint="Act as soon as the element exists, skipping the visible, enabled and not-covered checks."
          checked={step.wait.force ?? false}
          onChange={(force) => setWait({ force: force || undefined })}
        />
        <ConditionEditor
          condition={step.condition}
          onChange={(condition) =>
            onPatch((draft) => {
              if (condition) draft.condition = condition;
              else delete draft.condition;
            })
          }
        />
        {step.breakpoint && (
          <Field label="Breakpoint label">
            <CommitInput
              value={step.breakpoint.label ?? ''}
              onCommit={(label) =>
                onPatch((draft) => {
                  if (draft.breakpoint) draft.breakpoint = { enabled: draft.breakpoint.enabled, ...(label ? { label } : {}) };
                })
              }
            />
          </Field>
        )}
      </details>

      <div className="inspector-move">
        <span className="field-hint">Step {index + 1} of {stepCount}</span>
        <IconButton icon="chevronUp" label="Move step up" disabled={index === 0} onClick={() => onMove(-1)} />
        <IconButton icon="chevronDown" label="Move step down" disabled={index === stepCount - 1} onClick={() => onMove(1)} />
      </div>
    </div>
  );
}
