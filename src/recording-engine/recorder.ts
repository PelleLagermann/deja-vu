import type { RecorderConfig, StepDraft } from '@shared/messages';
import type { ElementTarget } from '@shared/model/selector';
import type { Modifiers, RelativePoint, StepAction } from '@shared/model/step';
import { clamp } from '@shared/util';
import {
  captureTarget,
  deepActiveElement,
  deepElementFromPoint,
  isContentEditable,
  isEditable,
  shadowRootOf,
} from '../selector-engine';
import { isExcluded, isSensitiveField } from './privacy';

export type RecorderOutput =
  | { kind: 'step'; draft: StepDraft }
  | { kind: 'replace'; count: number; draft: StepDraft };

export interface RecorderOptions {
  config: RecorderConfig;
  emit: (output: RecorderOutput) => void;
  /** Root window to listen on. */
  win?: Window;
  /** Elements for which events should be ignored, such as the extension's own overlay. */
  isOwnElement?: (element: Element) => boolean;
  /** Replaceable because test environments can't create trusted events. */
  isTrusted?: (event: Event) => boolean;
}

/** Elements a click on an inner node should be attributed to. */
const INTERACTIVE =
  'a[href],button,summary,label,[role=button],[role=link],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=checkbox],[role=radio],[role=switch],[role=treeitem]';

/** Input types where the click says nothing the following value change doesn't. */
const VALUE_ONLY_INPUTS = new Set([
  'checkbox', 'radio', 'range', 'file', 'color', 'date', 'datetime-local', 'month', 'time', 'week',
]);

const SCROLL_DEBOUNCE_MS = 250;
const GESTURE_WINDOW_MS = 800;
const DRAG_THRESHOLD_PX = 12;
const KEY_CLICK_WINDOW_MS = 1000;

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'NumLock', 'ScrollLock', 'Dead', 'Process', 'Unidentified']);
const EDITING_SHORTCUTS = new Set(['a', 'c', 'v', 'x', 'y', 'z']);
const PAGE_SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', ' ']);

interface PendingInput {
  element: HTMLElement;
}

interface HeldStep {
  draft: StepDraft;
  kind: 'field-click' | 'tab';
  element: Element | null;
}

interface PointerStart {
  x: number;
  y: number;
  element: Element;
  target: ElementTarget;
  offset: RelativePoint;
}

function modifiersOf(event: MouseEvent | KeyboardEvent): Modifiers | undefined {
  const modifiers: Modifiers = {};
  if (event.ctrlKey) modifiers.ctrl = true;
  if (event.shiftKey) modifiers.shift = true;
  if (event.altKey) modifiers.alt = true;
  if (event.metaKey) modifiers.meta = true;
  return Object.keys(modifiers).length > 0 ? modifiers : undefined;
}

function relativeOffset(element: Element, x: number, y: number): RelativePoint | undefined {
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return undefined;
  const round = (value: number) => Math.round(clamp(value, 0, 1) * 1000) / 1000;
  return { x: round((x - rect.left) / rect.width), y: round((y - rect.top) / rect.height) };
}

/** The scrollbar is part of the element, but outside its client area. */
function isOnScrollbar(element: Element, event: MouseEvent): boolean {
  const isRoot = element.tagName === 'HTML';
  const rect = element.getBoundingClientRect();
  const left = isRoot ? 0 : rect.left + element.clientLeft;
  const top = isRoot ? 0 : rect.top + element.clientTop;
  return element.clientWidth > 0 && (event.clientX >= left + element.clientWidth || event.clientY >= top + element.clientHeight);
}

function valueOf(element: HTMLElement): string {
  if (isContentEditable(element) && !('value' in element)) return element.innerText ?? element.textContent ?? '';
  return (element as HTMLInputElement).value;
}

/**
 * Turns the raw event stream of one document into logical steps.
 *
 * Steps have to come out in the order the user acted, so everything funnels through
 * `emit`. That first flushes anything still pending, such as a half-typed input. Two
 * kinds of step are held back because the next event decides whether they matter: a
 * click into a text field (noise if typing follows) and a Tab (noise if the next step
 * sets a value, because playback focuses the field anyway).
 */
export class Recorder {
  private readonly win: Window;
  private readonly options: RecorderOptions;
  private readonly controller = new AbortController();
  private pendingInput: PendingInput | null = null;
  private held: HeldStep[] = [];
  private pendingScroll: { target: Element | null; timer: ReturnType<typeof setTimeout> } | null = null;
  private pointerStart: PointerStart | null = null;
  private dragSource: { target: ElementTarget; offset?: RelativePoint } | null = null;
  private suppressNextClick = false;
  private clickRun: { element: Element; count: number } | null = null;
  /** The field whose value is the most recent step, so a new value can replace it. */
  private lastValueElement: Element | null = null;
  private lastGestureAt = 0;
  private lastActivationKeyAt = 0;

  constructor(options: RecorderOptions) {
    this.options = options;
    this.win = options.win ?? window;
  }

  start(): void {
    const listen = <K extends keyof WindowEventMap>(type: K, handler: (event: WindowEventMap[K]) => void) => {
      this.win.addEventListener(type, handler as EventListener, {
        capture: true,
        passive: true,
        signal: this.controller.signal,
      });
    };
    listen('mousedown', (event) => this.onMouseDown(event));
    listen('mouseup', (event) => this.onMouseUp(event));
    listen('click', (event) => this.onClick(event));
    listen('dblclick', (event) => this.onDoubleClick(event));
    listen('contextmenu', (event) => this.onContextMenu(event));
    listen('input', (event) => this.onInput(event));
    listen('change', (event) => this.onChange(event));
    listen('focusout', (event) => this.onFocusOut(event));
    listen('keydown', (event) => this.onKeyDown(event));
    listen('dragstart', (event) => this.onDragStart(event));
    listen('drop', (event) => this.onDrop(event));
    listen('dragend', () => (this.dragSource = null));
    listen('wheel', () => this.markGesture());
    listen('touchmove', () => this.markGesture());
    listen('scroll', (event) => this.onScroll(event));
    listen('pagehide', () => this.flush());
  }

  /** Emits everything pending, for use at the end of a session. */
  flush(): void {
    this.flushScroll();
    this.flushInput();
    this.flushHeld();
  }

  stop(): void {
    this.flush();
    this.controller.abort();
  }

  /** Records a native alert, confirm or prompt. */
  recordDialog(action: Extract<StepAction, { type: 'dialog' }>): void {
    this.flushInput();
    this.emit({ action, at: Date.now() });
  }

  /* ---------- Plumbing ---------- */

  private get config(): RecorderConfig {
    return this.options.config;
  }

  private trusted(event: Event): boolean {
    return this.options.isTrusted ? this.options.isTrusted(event) : event.isTrusted;
  }

  private capture(element: Element): ElementTarget {
    return captureTarget(element, { testIdAttributes: this.config.testIdAttributes });
  }

  /** The real target of an event, including inside shadow DOM. */
  private targetOf(event: Event): Element | null {
    const first = event.composedPath()[0] ?? event.target;
    let element: Element | null = null;
    if (first instanceof Element) element = first;
    else if (first instanceof Node) element = first.parentElement;
    if (!element) return null;

    // Events from a closed shadow root are retargeted to its host; look inside instead.
    if (event instanceof MouseEvent && shadowRootOf(element) && !element.shadowRoot) {
      element = deepElementFromPoint(event.clientX, event.clientY, element.ownerDocument) ?? element;
    }
    return this.isIgnored(element) ? null : element;
  }

  private isIgnored(element: Element): boolean {
    return this.options.isOwnElement?.(element) === true || isExcluded(element, this.config.excludedSelectors);
  }

  /** `typedInto` is the field an input step came from, which makes a held click on it redundant. */
  private emit(draft: StepDraft, typedInto?: Element): void {
    this.flushScroll();
    const setsValue = ['input', 'select', 'check', 'file'].includes(draft.action.type);
    for (const held of this.held) {
      const redundant = held.kind === 'tab' ? setsValue : held.element === typedInto;
      if (!redundant) this.options.emit({ kind: 'step', draft: held.draft });
    }
    this.held = [];
    this.lastValueElement = null;
    this.options.emit({ kind: 'step', draft });
  }


  private flushHeld(): void {
    for (const held of this.held) this.options.emit({ kind: 'step', draft: held.draft });
    this.held = [];
  }

  private hold(step: HeldStep): void {
    this.flushScroll();
    this.held.push(step);
  }

  private markGesture(): void {
    this.lastGestureAt = Date.now();
  }

  /* ---------- Mouse ---------- */

  private onMouseDown(event: MouseEvent): void {
    if (!this.trusted(event)) return;
    const element = this.targetOf(event);
    if (!element) {
      this.pointerStart = null;
      return;
    }
    if (isOnScrollbar(element, event)) {
      this.markGesture();
      this.pointerStart = null;
      return;
    }
    if (this.pendingInput && this.pendingInput.element !== element) this.flushInput();
    if (event.button !== 0 || element.tagName === 'HTML' || element.tagName === 'BODY' || isEditable(element)) {
      this.pointerStart = null;
      return;
    }
    if (element.matches('input,select,option,textarea')) {
      this.pointerStart = null;
      return;
    }
    const offset = relativeOffset(element, event.clientX, event.clientY) ?? { x: 0.5, y: 0.5 };
    this.pointerStart = { x: event.clientX, y: event.clientY, element, target: this.capture(element), offset };
  }

  private onMouseUp(event: MouseEvent): void {
    const start = this.pointerStart;
    this.pointerStart = null;
    if (!start || !this.trusted(event) || this.dragSource) return;
    const distance = Math.hypot(event.clientX - start.x, event.clientY - start.y);
    if (distance < DRAG_THRESHOLD_PX) return;
    const selection = this.win.getSelection?.();
    if (selection && !selection.isCollapsed) return;
    const element = this.targetOf(event);
    if (!element) return;

    this.suppressNextClick = true;
    const toOffset = relativeOffset(element, event.clientX, event.clientY);
    this.emit({
      action: {
        type: 'dragDrop',
        mode: 'pointer',
        destination: this.capture(element),
        fromOffset: start.offset,
        ...(toOffset ? { toOffset } : {}),
      },
      target: start.target,
      at: Date.now(),
    });
    // A drag can end on a different element from where it started, in which case no
    // click follows and the flag above must not swallow the next real one.
    setTimeout(() => (this.suppressNextClick = false), 0);
  }

  private onClick(event: MouseEvent): void {
    if (!this.trusted(event) || event.button !== 0) return;
    if (this.suppressNextClick) {
      this.suppressNextClick = false;
      return;
    }
    // Enter or Space on a button causes a click with detail 0. The key step already covers it.
    if (event.detail === 0 && Date.now() - this.lastActivationKeyAt < KEY_CLICK_WINDOW_MS) return;

    const raw = this.targetOf(event);
    if (!raw) return;

    // The label's forwarded click, or the change event, will produce the real step.
    const label = raw.closest('label');
    const labelled = label ? (label as HTMLLabelElement).control : null;
    if (labelled) {
      this.flushInput();
      return;
    }

    if (raw.matches('select,option,optgroup')) return;
    if (raw.tagName === 'INPUT' && VALUE_ONLY_INPUTS.has((raw as HTMLInputElement).type)) return;

    const element = isEditable(raw) ? raw : (raw.closest(INTERACTIVE) ?? raw);
    const offset = relativeOffset(element, event.clientX, event.clientY);
    const modifiers = modifiersOf(event);
    const draft: StepDraft = {
      action: { type: 'click', ...(modifiers ? { modifiers } : {}), ...(offset ? { offset } : {}) },
      target: this.capture(element),
      at: Date.now(),
    };

    if (isEditable(element)) {
      // Clicking again in the same field adds nothing.
      if (!this.held.some((held) => held.kind === 'field-click' && held.element === element)) {
        this.hold({ draft, kind: 'field-click', element });
      }
      return;
    }

    this.flushInput();
    this.emit(draft);
    this.clickRun = this.clickRun?.element === element
      ? { element, count: this.clickRun.count + 1 }
      : { element, count: 1 };
  }

  private onDoubleClick(event: MouseEvent): void {
    if (!this.trusted(event)) return;
    const raw = this.targetOf(event);
    if (!raw || isEditable(raw)) return;
    const element = raw.closest(INTERACTIVE) ?? raw;
    const count = this.clickRun?.element === element ? Math.min(this.clickRun.count, 2) : 0;
    this.clickRun = null;
    const offset = relativeOffset(element, event.clientX, event.clientY);
    const modifiers = modifiersOf(event);
    const draft: StepDraft = {
      action: { type: 'doubleClick', ...(modifiers ? { modifiers } : {}), ...(offset ? { offset } : {}) },
      target: this.capture(element),
      at: Date.now(),
    };
    if (count > 0) this.options.emit({ kind: 'replace', count, draft });
    else this.emit(draft);
  }

  private onContextMenu(event: MouseEvent): void {
    if (!this.trusted(event)) return;
    const element = this.targetOf(event);
    if (!element) return;
    this.flushInput();
    const offset = relativeOffset(element, event.clientX, event.clientY);
    const modifiers = modifiersOf(event);
    this.emit({
      action: { type: 'contextMenu', ...(modifiers ? { modifiers } : {}), ...(offset ? { offset } : {}) },
      target: this.capture(element),
      at: Date.now(),
    });
  }

  /* ---------- Form controls ---------- */

  private onInput(event: Event): void {
    if (!this.trusted(event)) return;
    const element = this.targetOf(event) as HTMLElement | null;
    if (!element) return;
    if (element.tagName === 'SELECT') return;
    if (element.tagName === 'INPUT') {
      const { type } = element as HTMLInputElement;
      if (type === 'checkbox' || type === 'radio' || type === 'file') return;
    } else if (element.tagName !== 'TEXTAREA' && !isContentEditable(element)) {
      return;
    }
    if (this.pendingInput?.element === element) return;
    this.flushInput();
    this.pendingInput = { element };
  }

  private onChange(event: Event): void {
    if (!this.trusted(event)) return;
    const element = this.targetOf(event);
    if (!element) return;

    if (element.tagName === 'SELECT') {
      const select = element as HTMLSelectElement;
      const selected = [...select.selectedOptions];
      this.flushInput();
      this.emit({
        action: {
          type: 'select',
          values: selected.map((option) => option.value),
          labels: selected.map((option) => option.label || option.text),
        },
        target: this.capture(select),
        at: Date.now(),
      });
      return;
    }

    if (element.tagName === 'INPUT') {
      const input = element as HTMLInputElement;
      if (input.type === 'checkbox' || input.type === 'radio') {
        this.flushInput();
        this.emit({ action: { type: 'check', checked: input.checked }, target: this.capture(input), at: Date.now() });
        return;
      }
      if (input.type === 'file') {
        this.flushInput();
        this.emit({
          action: { type: 'file', fileNames: [...(input.files ?? [])].map((file) => file.name) },
          target: this.capture(input),
          at: Date.now(),
        });
        return;
      }
    }
    if (this.pendingInput?.element === element) this.flushInput();
  }

  private onFocusOut(event: FocusEvent): void {
    if (!this.trusted(event)) return;
    if (this.pendingInput && event.composedPath()[0] === this.pendingInput.element) this.flushInput();
  }

  private flushInput(): void {
    const pending = this.pendingInput;
    if (!pending) return;
    this.pendingInput = null;
    const { element } = pending;
    const value = valueOf(element);
    const withheld = isSensitiveField(element) || !this.config.captureFormValues;
    const draft: StepDraft = {
      action: withheld ? { type: 'input', value: '', redacted: true } : { type: 'input', value },
      target: this.capture(element),
      at: Date.now(),
    };
    // Sliders and number fields commit on each key press. One step should hold the end result.
    if (this.lastValueElement === element && this.held.length === 0) {
      this.options.emit({ kind: 'replace', count: 1, draft });
      return;
    }
    this.emit(draft, element);
    this.lastValueElement = element;
  }

  /* ---------- Keyboard ---------- */

  private onKeyDown(event: KeyboardEvent): void {
    if (!this.trusted(event) || event.isComposing || MODIFIER_KEYS.has(event.key)) return;
    if (PAGE_SCROLL_KEYS.has(event.key) || event.key.startsWith('Arrow')) this.markGesture();
    if (event.repeat) return;

    const element = deepActiveElement(this.win.document) ?? this.targetOf(event);
    if (element && this.isIgnored(element)) return;
    if (!this.isRelevantKey(event, element)) return;

    if (event.key === 'Enter' || event.key === ' ') this.lastActivationKeyAt = Date.now();
    this.flushInput();

    const onPage = !element || element.tagName === 'BODY' || element.tagName === 'HTML';
    const modifiers = modifiersOf(event);
    const draft: StepDraft = {
      action: { type: 'keyPress', key: event.key, code: event.code, ...(modifiers ? { modifiers } : {}) },
      ...(onPage ? {} : { target: this.capture(element!) }),
      at: Date.now(),
    };
    if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      this.hold({ draft, kind: 'tab', element });
    } else {
      this.emit(draft);
    }
  }

  private isRelevantKey(event: KeyboardEvent, element: Element | null): boolean {
    const { key } = event;
    const hasCommand = event.ctrlKey || event.metaKey || event.altKey;
    const onPage = !element || element.tagName === 'BODY' || element.tagName === 'HTML';

    if (key === 'Tab' || key === 'Escape') return true;

    if (element && isEditable(element)) {
      if (key === 'Enter') return element.tagName !== 'TEXTAREA' && !isContentEditable(element) ? true : hasCommand;
      if (hasCommand) {
        return !EDITING_SHORTCUTS.has(key.toLowerCase()) && !isSensitiveField(element);
      }
      // Arrows are cursor movement, unless the field drives a popup list.
      if (key === 'ArrowUp' || key === 'ArrowDown') {
        return element.matches('[role=combobox],[aria-autocomplete],[aria-activedescendant],[list]');
      }
      return false;
    }

    if (element?.tagName === 'SELECT') return key === 'Enter';

    // Keys on sliders, radios, checkboxes and date fields show up as the value they set.
    if (element?.tagName === 'INPUT') return key === 'Enter' || hasCommand;

    // These scroll the page, and the scroll step already covers that.
    if (onPage && !hasCommand && PAGE_SCROLL_KEYS.has(key)) return false;

    return true;
  }

  /* ---------- Drag and drop ---------- */

  private onDragStart(event: DragEvent): void {
    if (!this.trusted(event)) return;
    this.pointerStart = null;
    const element = this.targetOf(event);
    if (!element) return;
    this.flushInput();
    const offset = relativeOffset(element, event.clientX, event.clientY);
    this.dragSource = { target: this.capture(element), ...(offset ? { offset } : {}) };
  }

  private onDrop(event: DragEvent): void {
    if (!this.trusted(event) || !this.dragSource) return;
    const source = this.dragSource;
    this.dragSource = null;
    const element = this.targetOf(event);
    if (!element) return;
    const toOffset = relativeOffset(element, event.clientX, event.clientY);
    this.emit({
      action: {
        type: 'dragDrop',
        mode: 'html5',
        destination: this.capture(element),
        ...(source.offset ? { fromOffset: source.offset } : {}),
        ...(toOffset ? { toOffset } : {}),
      },
      target: source.target,
      at: Date.now(),
    });
  }

  /* ---------- Scrolling ---------- */

  private onScroll(event: Event): void {
    if (!this.config.recordScroll || !this.trusted(event)) return;
    // Pages scroll themselves all the time. Only follow what the user just did.
    if (Date.now() - this.lastGestureAt > GESTURE_WINDOW_MS) return;

    const raw = event.composedPath()[0];
    const target = raw instanceof Element && raw.tagName !== 'HTML' && raw.tagName !== 'BODY' ? raw : null;
    if (target && this.isIgnored(target)) return;

    if (this.pendingScroll) {
      clearTimeout(this.pendingScroll.timer);
      if (this.pendingScroll.target !== target) this.emitScroll(this.pendingScroll.target);
    }
    this.pendingScroll = {
      target,
      timer: setTimeout(() => this.flushScroll(), SCROLL_DEBOUNCE_MS),
    };
  }

  private flushScroll(): void {
    const pending = this.pendingScroll;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingScroll = null;
    this.emitScroll(pending.target);
  }

  private emitScroll(target: Element | null): void {
    const x = target ? target.scrollLeft : this.win.scrollX;
    const y = target ? target.scrollTop : this.win.scrollY;
    // Scroll steps are optional: targets are scrolled into view during playback anyway.
    this.options.emit({
      kind: 'step',
      draft: {
        action: { type: 'scroll', x, y },
        ...(target ? { target: this.capture(target) } : {}),
        execution: 'optional',
        at: Date.now(),
      },
    });
  }
}
