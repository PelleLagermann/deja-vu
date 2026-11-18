import { normalizeWhitespace } from '@shared/util';

const INPUT_ROLES: Record<string, string> = {
  button: 'button',
  submit: 'button',
  reset: 'button',
  image: 'button',
  checkbox: 'checkbox',
  radio: 'radio',
  range: 'slider',
  search: 'searchbox',
  number: 'spinbutton',
};

const TAG_ROLES: Record<string, string> = {
  BUTTON: 'button',
  SUMMARY: 'button',
  TEXTAREA: 'textbox',
  H1: 'heading',
  H2: 'heading',
  H3: 'heading',
  H4: 'heading',
  H5: 'heading',
  H6: 'heading',
  NAV: 'navigation',
  MAIN: 'main',
  DIALOG: 'dialog',
  OPTION: 'option',
  LI: 'listitem',
  UL: 'list',
  OL: 'list',
  TABLE: 'table',
  TR: 'row',
  IMG: 'img',
};

export function getRole(element: Element): string | null {
  const explicit = element.getAttribute('role');
  if (explicit) return explicit.trim().split(/\s+/)[0] ?? null;
  const tag = element.tagName;
  if (tag === 'A' || tag === 'AREA') return element.hasAttribute('href') ? 'link' : null;
  if (tag === 'SELECT') return (element as HTMLSelectElement).multiple ? 'listbox' : 'combobox';
  if (tag === 'INPUT') {
    const type = (element as HTMLInputElement).type;
    if (type === 'hidden') return null;
    return INPUT_ROLES[type] ?? 'textbox';
  }
  return TAG_ROLES[tag] ?? null;
}

function textOfIds(element: Element, ids: string): string {
  const root = element.getRootNode() as Document | ShadowRoot;
  return ids
    .split(/\s+/)
    .map((id) => root.getElementById?.(id)?.textContent ?? '')
    .join(' ');
}

export function associatedLabelText(element: Element): string {
  const labels = (element as HTMLInputElement).labels;
  if (!labels || labels.length === 0) return '';
  return normalizeWhitespace([...labels].map((label) => label.textContent ?? '').join(' '));
}

/** A simplified accessible name. Input values are left out on purpose, as they may be private. */
export function getAccessibleName(element: Element): string {
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = normalizeWhitespace(textOfIds(element, labelledBy));
    if (text) return text;
  }
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel?.trim()) return normalizeWhitespace(ariaLabel);

  const label = associatedLabelText(element);
  if (label) return label;

  if (element.tagName === 'IMG') return normalizeWhitespace(element.getAttribute('alt') ?? '');
  if (element.tagName === 'INPUT') {
    const type = (element as HTMLInputElement).type;
    if (type === 'submit' || type === 'button' || type === 'reset') {
      return normalizeWhitespace((element as HTMLInputElement).value);
    }
    return normalizeWhitespace(element.getAttribute('title') ?? element.getAttribute('placeholder') ?? '');
  }
  if (element.tagName === 'TEXTAREA' || element.tagName === 'SELECT') {
    return normalizeWhitespace(element.getAttribute('title') ?? '');
  }
  const text = normalizeWhitespace(element.textContent ?? '');
  return text || normalizeWhitespace(element.getAttribute('title') ?? '');
}
