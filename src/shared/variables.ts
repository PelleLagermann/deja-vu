import type { Recording } from './model/recording';
import type { SetupAction } from './model/setup';
import type { Step, StepAction } from './model/step';

const VARIABLE = /\{\{\s*([$\w.-]+)\s*\}\}/g;

/**
 * Built-ins are evaluated once per run, so `{{$timestamp}}` is the same value everywhere
 * in that run. A later step can then assert on what an earlier one typed.
 */
export function builtinVariables(now = Date.now()): Record<string, string> {
  return {
    $timestamp: String(now),
    $date: new Date(now).toISOString().slice(0, 10),
    $uuid: crypto.randomUUID(),
    $random: String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0'),
  };
}

export function substitute(text: string, values: Record<string, string>): string {
  return text.replace(VARIABLE, (whole, name: string) => values[name] ?? whole);
}

export function findVariableNames(text: string): string[] {
  return [...text.matchAll(VARIABLE)].map((match) => match[1]!);
}

function mapActionStrings(action: StepAction, map: (text: string) => string): StepAction {
  switch (action.type) {
    case 'navigate':
      return { ...action, url: map(action.url) };
    case 'urlChange':
      return { ...action, match: { ...action.match, value: map(action.match.value) } };
    case 'input':
      return { ...action, value: map(action.value) };
    case 'select':
      return { ...action, values: action.values.map(map), labels: action.labels.map(map) };
    case 'dialog':
      return action.promptText === undefined ? action : { ...action, promptText: map(action.promptText) };
    case 'assert':
      return 'match' in action.assertion
        ? {
            ...action,
            assertion: {
              ...action.assertion,
              match: { ...action.assertion.match, value: map(action.assertion.match.value) },
            },
          }
        : action;
    case 'wait':
      return 'match' in action.condition
        ? {
            ...action,
            condition: {
              ...action.condition,
              match: { ...action.condition.match, value: map(action.condition.match.value) },
            },
          }
        : action;
    default:
      return action;
  }
}

/** Returns a copy of the step with `{{name}}` references replaced. */
export function resolveStepVariables(step: Step, values: Record<string, string>): Step {
  return { ...step, action: mapActionStrings(step.action, (text) => substitute(text, values)) };
}

/** Names used in a step's text fields. */
export function stepVariableNames(step: Step): string[] {
  const names: string[] = [];
  mapActionStrings(step.action, (text) => {
    names.push(...findVariableNames(text));
    return text;
  });
  return names;
}

/** Maps fields in the order the setup form shows them, so prompts come in that order too. */
function mapSetupStrings(action: SetupAction, map: (text: string) => string): SetupAction {
  const mapUrl = () => (action.url === undefined ? {} : { url: map(action.url) });
  switch (action.type) {
    case 'setCookie': {
      const name = map(action.name);
      const value = map(action.value);
      return {
        ...action,
        name,
        value,
        ...mapUrl(),
        ...(action.path === undefined ? {} : { path: map(action.path) }),
        ...(action.domain === undefined ? {} : { domain: map(action.domain) }),
      };
    }
    case 'deleteCookie': {
      const name = map(action.name);
      return { ...action, name, ...mapUrl() };
    }
    case 'clearCookies':
      return { ...action, ...mapUrl() };
  }
}

/** Returns a copy of the setup action with `{{name}}` references replaced. */
export function resolveSetupVariables(action: SetupAction, values: Record<string, string>): SetupAction {
  return mapSetupStrings(action, (text) => substitute(text, values));
}

function setupVariableNames(action: SetupAction): string[] {
  const names: string[] = [];
  mapSetupStrings(action, (text) => {
    names.push(...findVariableNames(text));
    return text;
  });
  return names;
}

/**
 * Variables the user must supply before a run: secrets, plus names used in steps that
 * have neither a definition nor a built-in.
 */
export function variablesToPrompt(recording: Recording): { name: string; secret: boolean; defaultValue: string }[] {
  const prompts = new Map<string, { name: string; secret: boolean; defaultValue: string }>();
  for (const definition of recording.variables) {
    if (definition.secret) {
      prompts.set(definition.name, { name: definition.name, secret: true, defaultValue: '' });
    }
  }
  const defined = new Set(recording.variables.map((definition) => definition.name));
  const used = [
    ...recording.setup.filter((item) => item.enabled).flatMap((item) => setupVariableNames(item.action)),
    ...recording.steps.flatMap(stepVariableNames),
  ];
  for (const name of used) {
    if (!defined.has(name) && !name.startsWith('$') && !prompts.has(name)) {
      prompts.set(name, { name, secret: false, defaultValue: '' });
    }
  }
  return [...prompts.values()];
}
