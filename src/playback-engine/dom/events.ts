import type { Modifiers } from '@shared/model/step';
import { deepActiveElement } from '../../selector-engine';

interface Point {
  x: number;
  y: number;
}

function mouseInit(point: Point, button: number, buttons: number, modifiers: Modifiers | undefined, detail = 0): MouseEventInit {
  return {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: point.x,
    clientY: point.y,
    screenX: point.x,
    screenY: point.y,
    button,
    buttons,
    detail,
    ctrlKey: modifiers?.ctrl ?? false,
    shiftKey: modifiers?.shift ?? false,
    altKey: modifiers?.alt ?? false,
    metaKey: modifiers?.meta ?? false,
  };
}

function pointerInit(init: MouseEventInit): PointerEventInit {
  return { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true };
}

export function dispatchHover(element: Element, point: Point): void {
  const base = mouseInit(point, 0, 0, undefined);
  element.dispatchEvent(new PointerEvent('pointerover', pointerInit(base)));
  element.dispatchEvent(new PointerEvent('pointerenter', { ...pointerInit(base), bubbles: false }));
  element.dispatchEvent(new MouseEvent('mouseover', base));
  element.dispatchEvent(new MouseEvent('mouseenter', { ...base, bubbles: false }));
  element.dispatchEvent(new PointerEvent('pointermove', pointerInit(base)));
  element.dispatchEvent(new MouseEvent('mousemove', base));
}

export function dispatchPress(element: Element, point: Point, modifiers?: Modifiers, detail = 1): void {
  const init = mouseInit(point, 0, 1, modifiers, detail);
  element.dispatchEvent(new PointerEvent('pointerdown', pointerInit(init)));
  element.dispatchEvent(new MouseEvent('mousedown', init));
}

export function dispatchRelease(element: Element, point: Point, modifiers?: Modifiers, detail = 1): void {
  const init = mouseInit(point, 0, 0, modifiers, detail);
  element.dispatchEvent(new PointerEvent('pointerup', pointerInit(init)));
  element.dispatchEvent(new MouseEvent('mouseup', init));
}

export function dispatchClick(element: Element, point: Point, modifiers?: Modifiers, detail = 1): void {
  element.dispatchEvent(new MouseEvent('click', mouseInit(point, 0, 0, modifiers, detail)));
}

export function dispatchDoubleClick(element: Element, point: Point, modifiers?: Modifiers): void {
  element.dispatchEvent(new MouseEvent('dblclick', mouseInit(point, 0, 0, modifiers, 2)));
}

export function dispatchContextMenu(element: Element, point: Point, modifiers?: Modifiers): void {
  const down = mouseInit(point, 2, 2, modifiers, 1);
  const up = mouseInit(point, 2, 0, modifiers, 1);
  element.dispatchEvent(new PointerEvent('pointerdown', pointerInit(down)));
  element.dispatchEvent(new MouseEvent('mousedown', down));
  element.dispatchEvent(new PointerEvent('pointerup', pointerInit(up)));
  element.dispatchEvent(new MouseEvent('mouseup', up));
  element.dispatchEvent(new MouseEvent('contextmenu', up));
}

export function dispatchPointerMove(element: Element, point: Point): void {
  const init = mouseInit(point, 0, 1, undefined);
  element.dispatchEvent(new PointerEvent('pointermove', pointerInit(init)));
  element.dispatchEvent(new MouseEvent('mousemove', init));
}

export function dispatchDrag(element: Element, type: string, point: Point, dataTransfer: DataTransfer): boolean {
  return element.dispatchEvent(new DragEvent(type, { ...mouseInit(point, 0, 1, undefined), dataTransfer }));
}

export function keyInit(key: string, code: string, modifiers?: Modifiers): KeyboardEventInit {
  return {
    key,
    code,
    bubbles: true,
    cancelable: true,
    composed: true,
    ctrlKey: modifiers?.ctrl ?? false,
    shiftKey: modifiers?.shift ?? false,
    altKey: modifiers?.alt ?? false,
    metaKey: modifiers?.meta ?? false,
  };
}

/**
 * Moves focus to the element. When the sidebar has focus, Gecko updates `activeElement`
 * without firing any events, which would leave on-blur validation unrun. Those events
 * are sent by hand in that case.
 */
export function focusElement(element: HTMLElement): void {
  const previous = deepActiveElement(element.ownerDocument);
  if (previous === element) return;

  let fired = false;
  const listener = () => (fired = true);
  element.addEventListener('focus', listener, { once: true, capture: true });
  element.focus({ preventScroll: true });
  element.removeEventListener('focus', listener, { capture: true });
  if (fired || deepActiveElement(element.ownerDocument) !== element) return;

  if (previous && previous.tagName !== 'BODY') {
    previous.dispatchEvent(new FocusEvent('blur', { relatedTarget: element, composed: true }));
    previous.dispatchEvent(new FocusEvent('focusout', { relatedTarget: element, bubbles: true, composed: true }));
  }
  element.dispatchEvent(new FocusEvent('focus', { composed: true }));
  element.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }));
}
