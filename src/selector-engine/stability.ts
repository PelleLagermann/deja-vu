/** Heuristics for telling hand-written identifiers from generated ones. */

const GENERATED_ID_PATTERNS: RegExp[] = [
  /^:r[0-9a-z]+:$/i, // React useId
  /^radix-/i,
  /^headlessui-/i,
  /^(ember|ext-gen|ext-comp|yui_|gwt-uid-|ui-id-|mui-|rc[-_]|vaadin-|ng-|cdk-|mat-)\S*\d/i,
  /^react-select-\d+/i,
  /^[0-9a-f]{8}-[0-9a-f]{4}-/i, // UUID
  /^[0-9a-f]{16,}$/i, // hash
  /^\d+$/,
  /[-_:]\d{4,}$/, // trailing long number
];

export function isStableId(id: string): boolean {
  return id.length > 0 && id.length <= 80 && !GENERATED_ID_PATTERNS.some((pattern) => pattern.test(id));
}

const GENERATED_CLASS_PATTERNS: RegExp[] = [
  /^css-[a-z0-9]+/i, // emotion
  /^sc-[a-z0-9]+/i, // styled-components
  /^jsx-\d+/, // styled-jsx
  /^jss\d+/,
  /^Mui[A-Z]\w*-root$/, // stable, but too generic to help
  /^_[a-z0-9]{5,}$/i, // CSS modules
  /__[a-z0-9]{5,}$/i, // CSS modules with a local name
  /^[a-z]{1,3}-[a-z0-9]{6,}$/i, // short prefix and hash
  /^ng-/, // Angular state classes
  /^(is|has)-(active|open|focused|hover|selected|disabled|loading)$/,
  /^(active|focus|focused|hover|selected|open|disabled|show|hidden)$/,
];

export function isStableClass(name: string): boolean {
  if (name.length < 2 || name.length > 40) return false;
  // Utility classes like `mt-4` or `w-[12px]` say nothing about the element's identity.
  if (/[[\]:/!]/.test(name) || /^-?[a-z]{1,3}-\d+$/.test(name)) return false;
  return !GENERATED_CLASS_PATTERNS.some((pattern) => pattern.test(name));
}

export function stableClasses(element: Element): string[] {
  return [...element.classList].filter(isStableClass);
}

/** `data-*` attributes that describe state or carry values, not identity. */
const VOLATILE_DATA_ATTRIBUTE = /^data-(state|active|selected|open|highlighted|disabled|focus|hover|checked|value|index|key|reactid|v-|orientation|side|align)/;

export function isStableDataAttribute(name: string, value: string): boolean {
  return (
    name.startsWith('data-') &&
    !VOLATILE_DATA_ATTRIBUTE.test(name) &&
    value.length > 0 &&
    value.length <= 60 &&
    isStableId(value)
  );
}
