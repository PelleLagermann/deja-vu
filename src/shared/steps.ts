import { SCHEMA_VERSION, type Recording } from './model/recording';
import type { Step, StepAction, Assertion, WaitCondition } from './model/step';
import { createId, describeMatch, truncate } from './util';

const ACTION_LABELS: Record<StepAction['type'], string> = {
  navigate: 'Navigate',
  reload: 'Reload',
  history: 'History',
  urlChange: 'URL change',
  click: 'Click',
  doubleClick: 'Double-click',
  contextMenu: 'Right-click',
  hover: 'Hover',
  dragDrop: 'Drag & drop',
  input: 'Type',
  select: 'Select',
  check: 'Check',
  keyPress: 'Key',
  scroll: 'Scroll',
  file: 'File',
  dialog: 'Dialog',
  wait: 'Wait',
  assert: 'Assert',
  runRecording: 'Run',
};

export function actionTypeLabel(type: StepAction['type']): string {
  return ACTION_LABELS[type];
}

export function actionLabel(action: StepAction): string {
  if (action.type === 'check' && !action.checked) return 'Uncheck';
  return ACTION_LABELS[action.type];
}

export function describeAssertion(assertion: Assertion): string {
  switch (assertion.kind) {
    case 'exists':
      return 'element exists';
    case 'notExists':
      return 'element does not exist';
    case 'visible':
      return 'element is visible';
    case 'hidden':
      return 'element is hidden';
    case 'text':
      return `text ${describeMatch(assertion.match)}`;
    case 'value':
      return `value ${describeMatch(assertion.match)}`;
    case 'checked':
      return 'element is checked';
    case 'unchecked':
      return 'element is not checked';
    case 'url':
      return `URL ${describeMatch(assertion.match)}`;
    case 'title':
      return `title ${describeMatch(assertion.match)}`;
    case 'count':
      return `${assertion.expected} × ${assertion.selector}`;
  }
}

export function describeWait(condition: WaitCondition): string {
  switch (condition.kind) {
    case 'exists':
      return 'element exists';
    case 'visible':
      return 'element is visible';
    case 'enabled':
      return 'element is enabled';
    case 'hidden':
      return 'element is hidden';
    case 'gone':
      return 'element disappears';
    case 'text':
      return `page text ${describeMatch(condition.match)}`;
    case 'url':
      return `URL ${describeMatch(condition.match)}`;
    case 'urlChanged':
      return 'URL changes';
    case 'loadingGone':
      return `${condition.selector} disappears`;
    case 'delay':
      return `${condition.ms} ms`;
  }
}

/** The action-specific part of a step, for one-line display. */
export function actionDetail(action: StepAction): string {
  switch (action.type) {
    case 'navigate':
      return action.url;
    case 'urlChange':
      return action.match.value;
    case 'history':
      return action.direction;
    case 'input':
      if (action.redacted && !action.value) return 'value withheld';
      return truncate(action.value, 60);
    case 'select':
      return action.labels.join(', ') || action.values.join(', ');
    case 'keyPress':
      return formatKey(action);
    case 'scroll':
      return `${Math.round(action.x)}, ${Math.round(action.y)}`;
    case 'file':
      return action.fileNames.join(', ') || 'choose a file';
    case 'dialog':
      return `${action.kind}: ${action.accept ? 'accept' : 'dismiss'}`;
    case 'wait':
      return describeWait(action.condition);
    case 'assert':
      return describeAssertion(action.assertion);
    case 'dragDrop':
      return `to ${action.destination.summary}`;
    default:
      return '';
  }
}

export function formatKey(action: Extract<StepAction, { type: 'keyPress' }>): string {
  const { modifiers: m } = action;
  const parts = [m?.ctrl && 'Ctrl', m?.alt && 'Alt', m?.shift && 'Shift', m?.meta && 'Meta', action.key];
  return parts.filter(Boolean).join('+');
}

/** `textbox "Name"` becomes `"Name"`: the action already says what kind of thing it is. */
function labelOnly(summary: string): string {
  return /^[\w-]+ (".*")$/.exec(summary)?.[1] ?? summary;
}

/** A short title for a step: the user's name, or one derived from what it does. */
export function stepTitle(step: Step): string {
  if (step.name) return step.name;
  const label = actionLabel(step.action);
  const target = step.target?.summary;
  switch (step.action.type) {
    case 'input':
      return target ? `Type into ${labelOnly(target)}` : label;
    case 'select':
      return target ? `Select in ${labelOnly(target)}` : label;
    case 'check':
      return target ? `${label} ${labelOnly(target)}` : label;
    case 'navigate':
    case 'urlChange':
    case 'keyPress':
    case 'wait':
    case 'assert':
    case 'dialog':
      return `${label} ${actionDetail(step.action)}`;
    default:
      return target ? `${label} ${target}` : label;
  }
}

export function newStep(action: StepAction, partial: Partial<Step> = {}): Step {
  return { id: createId('step'), action, execution: 'required', wait: {}, ...partial };
}

export function cloneStep(step: Step): Step {
  return { ...structuredClone(step), id: createId('step') };
}

export function newRecording(partial: Partial<Recording> = {}): Recording {
  const now = Date.now();
  return {
    id: createId('rec'),
    name: 'Untitled recording',
    description: '',
    tags: [],
    collectionId: null,
    createdAt: now,
    updatedAt: now,
    startUrl: '',
    schemaVersion: SCHEMA_VERSION,
    steps: [],
    groups: [],
    variables: [],
    setup: [],
    ...partial,
  };
}

/** Copies a recording with new IDs throughout, keeping group membership intact. */
export function duplicateRecording(source: Recording, name: string): Recording {
  const groupIds = new Map(source.groups.map((group) => [group.id, createId('grp')]));
  const now = Date.now();
  return {
    ...structuredClone(source),
    id: createId('rec'),
    name,
    createdAt: now,
    updatedAt: now,
    groups: source.groups.map((group) => ({ ...group, id: groupIds.get(group.id)! })),
    setup: source.setup.map((item) => ({ ...structuredClone(item), id: createId('setup') })),
    steps: source.steps.map((step) => ({
      ...cloneStep(step),
      groupId: step.groupId ? groupIds.get(step.groupId) : undefined,
    })),
  };
}
