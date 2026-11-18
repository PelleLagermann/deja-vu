import type { Modifiers } from '@shared/model/step';
import { collectRoots, deepActiveElement, isDisabled, isVisible, queryAllDeep } from '../../selector-engine';
import { focusElement, keyInit } from './events';

const TABBABLE =
  'a[href],button,input:not([type=hidden]),select,textarea,summary,[tabindex],[contenteditable=""],[contenteditable=true]';

function tabbables(doc: Document): HTMLElement[] {
  return queryAllDeep(TABBABLE, collectRoots(doc)).filter((element): element is HTMLElement => {
    const tabIndex = (element as HTMLElement).tabIndex;
    return tabIndex >= 0 && !isDisabled(element) && isVisible(element);
  });
}

function moveFocus(from: Element, backwards: boolean): void {
  const elements = tabbables(from.ownerDocument);
  if (elements.length === 0) return;
  const index = elements.indexOf(from as HTMLElement);
  const next = backwards
    ? elements[(index <= 0 ? elements.length : index) - 1]
    : elements[(index + 1) % elements.length];
  if (next) focusElement(next);
}

function submitFromField(field: HTMLInputElement): void {
  const { form } = field;
  if (!form) return;
  const submitter = form.querySelector<HTMLElement>('button:not([type]),button[type=submit],input[type=submit],input[type=image]');
  if (submitter && !isDisabled(submitter)) submitter.click();
  else form.requestSubmit();
}

function stepSelect(select: HTMLSelectElement, delta: number): void {
  const next = select.selectedIndex + delta;
  if (next < 0 || next >= select.options.length) return;
  select.selectedIndex = next;
  select.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Browsers ignore default actions for synthetic keys, so the common ones are done here. */
function applyDefaultAction(element: Element, key: string, modifiers: Modifiers | undefined): void {
  switch (key) {
    case 'Tab':
      moveFocus(element, modifiers?.shift === true);
      return;
    case 'Enter':
      if (element.matches('a[href],button,summary,[role=button],[role=link]')) (element as HTMLElement).click();
      else if (element.tagName === 'INPUT') submitFromField(element as HTMLInputElement);
      return;
    case ' ':
      if (element.matches('button,summary,input[type=checkbox],input[type=radio],[role=button],[role=checkbox]')) {
        (element as HTMLElement).click();
      }
      return;
    case 'Escape': {
      const dialogs = [...element.ownerDocument.querySelectorAll<HTMLDialogElement>('dialog[open]')];
      const top = dialogs.at(-1);
      if (top && top.dispatchEvent(new Event('cancel', { cancelable: true }))) top.close();
      return;
    }
    case 'ArrowDown':
    case 'ArrowRight':
      if (element.tagName === 'SELECT') stepSelect(element as HTMLSelectElement, 1);
      return;
    case 'ArrowUp':
    case 'ArrowLeft':
      if (element.tagName === 'SELECT') stepSelect(element as HTMLSelectElement, -1);
      return;
  }
}

export function pressKey(element: Element, key: string, code: string, modifiers?: Modifiers): void {
  const init = keyInit(key, code, modifiers);
  const accepted = element.dispatchEvent(new KeyboardEvent('keydown', init));
  const printable = key.length === 1 || key === 'Enter';
  if (accepted && printable) element.dispatchEvent(new KeyboardEvent('keypress', init));
  if (accepted) applyDefaultAction(element, key, modifiers);
  // The default action may have moved focus, in which case that element sees the keyup.
  const current = deepActiveElement(element.ownerDocument) ?? element;
  current.dispatchEvent(new KeyboardEvent('keyup', init));
}

function codeForCharacter(char: string): string {
  if (/[a-z]/i.test(char)) return `Key${char.toUpperCase()}`;
  if (/\d/.test(char)) return `Digit${char}`;
  return char === ' ' ? 'Space' : '';
}

function fireInput(element: Element, data: string | null, inputType: string): void {
  element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data, inputType }));
}

type TextField = HTMLInputElement | HTMLTextAreaElement;

/** Sets a value in one go. Content scripts see the native setter, which is what makes React notice. */
export function fillField(field: TextField, value: string): void {
  field.value = value;
  fireInput(field, value, 'insertText');
  field.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Types each character with key events, for fields that react to individual keys. */
export async function typeIntoField(field: TextField, value: string, delayMs: number): Promise<void> {
  field.value = '';
  fireInput(field, null, 'deleteContentBackward');
  for (const char of value) {
    const init = keyInit(char, codeForCharacter(char));
    field.dispatchEvent(new KeyboardEvent('keydown', init));
    field.dispatchEvent(new KeyboardEvent('keypress', init));
    field.value += char;
    fireInput(field, char, 'insertText');
    field.dispatchEvent(new KeyboardEvent('keyup', init));
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  field.dispatchEvent(new Event('change', { bubbles: true }));
}

export function fillContentEditable(element: HTMLElement, value: string): void {
  const doc = element.ownerDocument;
  const selection = doc.getSelection();
  if (selection) {
    const range = doc.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  // execCommand goes through the editing pipeline that rich text editors listen to.
  let inserted = false;
  try {
    inserted = doc.execCommand('insertText', false, value);
  } catch {
    inserted = false;
  }
  if (!inserted || element.innerText.trim() !== value.trim()) {
    element.textContent = value;
    fireInput(element, value, 'insertText');
  }
}
