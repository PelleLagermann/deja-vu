import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecorderConfig, StepDraft } from '@shared/messages';
import { Recorder, type RecorderOutput } from '../../src/recording-engine/recorder';
import { isExcluded, isSensitiveField } from '../../src/recording-engine/privacy';

const baseConfig: RecorderConfig = {
  captureFormValues: true,
  recordScroll: true,
  excludedSelectors: [],
  testIdAttributes: ['data-testid'],
};

let outputs: RecorderOutput[];
let recorder: Recorder;

function start(config: Partial<RecorderConfig> = {}, isTrusted: (event: Event) => boolean = () => true): void {
  outputs = [];
  recorder = new Recorder({
    config: { ...baseConfig, ...config },
    emit: (output) => outputs.push(output),
    isTrusted,
  });
  recorder.start();
}

function steps(): StepDraft[] {
  return outputs.filter((output) => output.kind === 'step').map((output) => output.draft);
}

function actions(): string[] {
  return steps().map((step) => step.action.type);
}

function get<T extends Element = HTMLElement>(selector: string): T {
  return document.querySelector<T>(selector)!;
}

function clickOn(element: Element, init: MouseEventInit = {}): void {
  const options = { bubbles: true, composed: true, cancelable: true, detail: 1, ...init };
  element.dispatchEvent(new MouseEvent('mousedown', options));
  element.dispatchEvent(new MouseEvent('mouseup', options));
  element.dispatchEvent(new MouseEvent('click', options));
}

function type(element: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  for (const char of text) {
    element.value += char;
    element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: char }));
  }
}

function press(element: Element, key: string, init: KeyboardEventInit = {}): void {
  (element as HTMLElement).focus?.();
  element.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, composed: true, ...init }));
}

beforeEach(() => {
  document.body.innerHTML = '';
  start();
});

afterEach(() => recorder.stop());

describe('clicks', () => {
  it('records a click with its target', () => {
    document.body.innerHTML = '<button data-testid="go">Go</button>';
    clickOn(get('button'));
    expect(actions()).toEqual(['click']);
    expect(steps()[0]!.target?.summary).toBe('button "Go"');
  });

  it('attributes a click on inner content to the button', () => {
    document.body.innerHTML = '<button id="go"><span class="icon">+</span></button>';
    clickOn(get('.icon'));
    expect(steps()[0]!.target?.fingerprint.tag).toBe('button');
  });

  it('records modifier keys', () => {
    document.body.innerHTML = '<a href="#x">x</a>';
    clickOn(get('a'), { ctrlKey: true });
    expect(steps()[0]!.action).toMatchObject({ modifiers: { ctrl: true } });
  });

  it('turns two clicks and a dblclick into one double-click', () => {
    document.body.innerHTML = '<div class="row" id="row">Item</div>';
    const row = get('#row');
    clickOn(row);
    clickOn(row);
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, composed: true, detail: 2 }));
    const replacement = outputs.at(-1)!;
    expect(replacement.kind).toBe('replace');
    expect(replacement).toMatchObject({ count: 2, draft: { action: { type: 'doubleClick' } } });
  });

  it('records a right-click', () => {
    document.body.innerHTML = '<div id="a">x</div>';
    get('#a').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true, button: 2 }));
    expect(actions()).toEqual(['contextMenu']);
  });

  it('ignores a click caused by pressing Enter on a button', () => {
    document.body.innerHTML = '<button id="b">x</button>';
    const button = get('#b');
    press(button, 'Enter');
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, detail: 0 }));
    expect(actions()).toEqual(['keyPress']);
  });
});

describe('text input', () => {
  it('produces one step for a whole typed value', () => {
    document.body.innerHTML = '<input id="name"><button>Next</button>';
    const input = get<HTMLInputElement>('#name');
    type(input, 'Ada Lovelace');
    expect(actions()).toEqual([]);
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(actions()).toEqual(['input']);
    expect(steps()[0]!.action).toEqual({ type: 'input', value: 'Ada Lovelace' });
  });

  it('flushes the value before a following click, keeping the order', () => {
    document.body.innerHTML = '<input id="name"><button id="next">Next</button>';
    type(get<HTMLInputElement>('#name'), 'abc');
    clickOn(get('#next'));
    expect(actions()).toEqual(['input', 'click']);
  });

  it('flushes on blur', () => {
    document.body.innerHTML = '<input id="name">';
    const input = get<HTMLInputElement>('#name');
    type(input, 'x');
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true }));
    expect(actions()).toEqual(['input']);
  });

  it('drops the click into a field when typing follows', () => {
    document.body.innerHTML = '<input id="name">';
    const input = get<HTMLInputElement>('#name');
    clickOn(input);
    type(input, 'x');
    recorder.flush();
    expect(actions()).toEqual(['input']);
  });

  it('keeps the click into a field when something else follows', () => {
    document.body.innerHTML = '<input id="search"><button id="b">x</button>';
    clickOn(get('#search'));
    clickOn(get('#b'));
    expect(actions()).toEqual(['click', 'click']);
  });

  it('keeps React-style controlled values, whose default value tracks the value', () => {
    document.body.innerHTML = '<input id="name">';
    const input = get<HTMLInputElement>('#name');
    input.value = 'abc';
    input.setAttribute('value', 'abc');
    input.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
    recorder.flush();
    expect(steps()[0]!.action).toEqual({ type: 'input', value: 'abc' });
  });

  it('handles textareas', () => {
    document.body.innerHTML = '<textarea id="t"></textarea>';
    const area = get<HTMLTextAreaElement>('#t');
    type(area, 'line');
    recorder.flush();
    expect(steps()[0]!.action).toEqual({ type: 'input', value: 'line' });
  });

  it('coalesces range and date inputs', () => {
    document.body.innerHTML = '<input id="r" type="range" min="0" max="10"><input id="d" type="date">';
    const range = get<HTMLInputElement>('#r');
    for (const value of ['1', '2', '3']) {
      range.value = value;
      range.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    }
    range.dispatchEvent(new Event('change', { bubbles: true }));
    const date = get<HTMLInputElement>('#d');
    date.value = '2026-11-06';
    date.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    date.dispatchEvent(new Event('change', { bubbles: true }));
    expect(steps().map((step) => step.action)).toEqual([
      { type: 'input', value: '3' },
      { type: 'input', value: '2026-11-06' },
    ]);
  });
});

describe('checkboxes, radios and selects', () => {
  it('records one step for a checkbox, not a click plus a change', () => {
    document.body.innerHTML = '<input id="c" type="checkbox">';
    // jsdom runs the click's activation behaviour, which toggles and fires input and change.
    clickOn(get('#c'));
    expect(steps().map((step) => step.action)).toEqual([{ type: 'check', checked: true }]);
  });

  it('records unchecking', () => {
    document.body.innerHTML = '<input id="c" type="checkbox" checked>';
    const box = get<HTMLInputElement>('#c');
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    expect(steps()[0]!.action).toEqual({ type: 'check', checked: false });
  });

  it('does not double-record a click on a label', () => {
    document.body.innerHTML = '<label>Agree <input id="c" type="checkbox"></label>';
    clickOn(get('label'));
    expect(actions()).toEqual(['check']);
  });

  it('records radio buttons', () => {
    document.body.innerHTML = '<input type="radio" name="plan" value="a"><input id="b" type="radio" name="plan" value="b">';
    const radio = get<HTMLInputElement>('#b');
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
    expect(steps()[0]!.action).toEqual({ type: 'check', checked: true });
  });

  it('records a select with both value and label', () => {
    document.body.innerHTML = '<select id="s"><option value="a">Alpha</option><option value="b">Beta</option></select>';
    const select = get<HTMLSelectElement>('#s');
    clickOn(select);
    select.value = 'b';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(steps().map((step) => step.action)).toEqual([{ type: 'select', values: ['b'], labels: ['Beta'] }]);
  });
});

describe('keyboard', () => {
  it('records Enter in a field, after the value', () => {
    document.body.innerHTML = '<input id="q">';
    const input = get<HTMLInputElement>('#q');
    type(input, 'hi');
    press(input, 'Enter');
    expect(actions()).toEqual(['input', 'keyPress']);
  });

  it('does not record ordinary typing as key steps', () => {
    document.body.innerHTML = '<input id="q">';
    press(get('#q'), 'a');
    press(get('#q'), 'ArrowLeft');
    expect(actions()).toEqual([]);
  });

  it('records keyboard shortcuts', () => {
    document.body.innerHTML = '<button id="b">x</button>';
    press(get('#b'), 's', { ctrlKey: true });
    expect(steps()[0]!.action).toMatchObject({ key: 's', modifiers: { ctrl: true } });
  });

  it('ignores clipboard shortcuts in fields', () => {
    document.body.innerHTML = '<input id="q">';
    press(get('#q'), 'v', { ctrlKey: true });
    expect(actions()).toEqual([]);
  });

  it('records Escape and arrows on widgets', () => {
    document.body.innerHTML = '<div id="m" tabindex="0" role="menu"></div>';
    press(get('#m'), 'ArrowDown');
    press(get('#m'), 'Escape');
    expect(steps().map((step) => (step.action as { key: string }).key)).toEqual(['ArrowDown', 'Escape']);
  });

  it('keeps arrows on a combobox field', () => {
    document.body.innerHTML = '<input id="c" role="combobox">';
    press(get('#c'), 'ArrowDown');
    expect(actions()).toEqual(['keyPress']);
  });

  it('drops a Tab when the next step fills a field', () => {
    document.body.innerHTML = '<input id="a"><input id="b">';
    const first = get<HTMLInputElement>('#a');
    const second = get<HTMLInputElement>('#b');
    type(first, 'x');
    press(first, 'Tab');
    type(second, 'y');
    recorder.flush();
    expect(steps().map((step) => step.action.type)).toEqual(['input', 'input']);
  });

  it('keeps a Tab when something else follows', () => {
    document.body.innerHTML = '<button id="a">a</button><button id="b">b</button>';
    press(get('#a'), 'Tab');
    press(get('#b'), 'Enter');
    expect(steps().map((step) => (step.action as { key: string }).key)).toEqual(['Tab', 'Enter']);
  });
});

describe('scrolling', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('collapses a burst of user scrolling into one optional step', () => {
    window.dispatchEvent(new Event('wheel'));
    for (let i = 0; i < 5; i++) document.dispatchEvent(new Event('scroll', { bubbles: true }));
    vi.advanceTimersByTime(400);
    expect(actions()).toEqual(['scroll']);
    expect(steps()[0]!.execution).toBe('optional');
  });

  it('ignores scrolling the page did by itself', () => {
    vi.advanceTimersByTime(2000);
    document.dispatchEvent(new Event('scroll', { bubbles: true }));
    vi.advanceTimersByTime(400);
    expect(actions()).toEqual([]);
  });

  it('can be turned off', () => {
    recorder.stop();
    start({ recordScroll: false });
    window.dispatchEvent(new Event('wheel'));
    document.dispatchEvent(new Event('scroll', { bubbles: true }));
    vi.advanceTimersByTime(400);
    expect(actions()).toEqual([]);
  });
});

describe('drag and drop', () => {
  it('records an HTML5 drag as one step', () => {
    document.body.innerHTML = '<div id="card" draggable="true">x</div><div id="lane">y</div>';
    const init = { bubbles: true, composed: true };
    get('#card').dispatchEvent(new MouseEvent('dragstart', init));
    get('#lane').dispatchEvent(new MouseEvent('drop', init));
    const [step] = steps();
    expect(step!.action.type).toBe('dragDrop');
    expect(step!.target?.selectors[0]).toMatchObject({ kind: 'id', value: 'card' });
    expect(step!.action).toMatchObject({ mode: 'html5', destination: { fingerprint: { id: 'lane' } } });
  });

  it('records a mouse drag between elements and suppresses its click', () => {
    document.body.innerHTML = '<div id="from">a</div><div id="to">b</div>';
    const init = { bubbles: true, composed: true };
    get('#from').dispatchEvent(new MouseEvent('mousedown', { ...init, clientX: 0, clientY: 0 }));
    get('#to').dispatchEvent(new MouseEvent('mouseup', { ...init, clientX: 100, clientY: 0 }));
    get('#to').dispatchEvent(new MouseEvent('click', { ...init, clientX: 100, clientY: 0, detail: 1 }));
    expect(actions()).toEqual(['dragDrop']);
  });

  it('treats a small wobble as a click', () => {
    document.body.innerHTML = '<button id="b">x</button>';
    const init = { bubbles: true, composed: true };
    get('#b').dispatchEvent(new MouseEvent('mousedown', { ...init, clientX: 0, clientY: 0 }));
    get('#b').dispatchEvent(new MouseEvent('mouseup', { ...init, clientX: 3, clientY: 0 }));
    get('#b').dispatchEvent(new MouseEvent('click', { ...init, clientX: 3, clientY: 0, detail: 1 }));
    expect(actions()).toEqual(['click']);
  });
});

describe('what never gets recorded', () => {
  it('ignores untrusted events, which covers playback itself', () => {
    recorder.stop();
    start({}, (event) => event.isTrusted);
    document.body.innerHTML = '<button id="b">x</button><input id="i">';
    clickOn(get('#b'));
    type(get<HTMLInputElement>('#i'), 'x');
    recorder.flush();
    expect(steps()).toEqual([]);
  });

  it('withholds password values, and their keystrokes', () => {
    document.body.innerHTML = '<input id="p" type="password">';
    const input = get<HTMLInputElement>('#p');
    type(input, 'hunter2');
    press(input, 'a');
    recorder.flush();
    expect(steps().map((step) => step.action)).toEqual([{ type: 'input', value: '', redacted: true }]);
    expect(JSON.stringify(outputs)).not.toContain('hunter2');
  });

  it('withholds all typed values when capture is off', () => {
    recorder.stop();
    start({ captureFormValues: false });
    document.body.innerHTML = '<input id="n">';
    type(get<HTMLInputElement>('#n'), 'private');
    recorder.flush();
    expect(steps()[0]!.action).toEqual({ type: 'input', value: '', redacted: true });
  });

  it('skips elements on the exclusion list', () => {
    recorder.stop();
    start({ excludedSelectors: ['.private'] });
    document.body.innerHTML = '<div class="private"><button id="b">x</button><input id="i"></div>';
    clickOn(get('#b'));
    type(get<HTMLInputElement>('#i'), 'x');
    recorder.flush();
    expect(steps()).toEqual([]);
  });

  it('honours the opt-out attribute', () => {
    document.body.innerHTML = '<div data-dejavu-ignore><button id="b">x</button></div>';
    clickOn(get('#b'));
    expect(steps()).toEqual([]);
  });
});

describe('sensitive field detection', () => {
  const field = (markup: string) => {
    document.body.innerHTML = markup;
    return document.body.firstElementChild!;
  };

  it.each([
    '<input type="password">',
    '<input autocomplete="cc-number">',
    '<input autocomplete="one-time-code">',
    '<input autocomplete="section-a current-password">',
    '<input name="user_password">',
    '<input id="cvv">',
    '<input placeholder="Card number">',
    '<input name="user_otp">',
    '<input name="account-pin">',
  ])('flags %s', (markup) => expect(isSensitiveField(field(markup))).toBe(true));

  it.each([
    '<input type="text" name="email">',
    '<input name="company">',
    '<textarea name="notes"></textarea>',
    '<input name="passenger_name">',
    '<input name="compass_heading">',
    '<input name="card_notes">',
    '<input name="shipping_address">',
  ])(
    'allows %s',
    (markup) => expect(isSensitiveField(field(markup))).toBe(false),
  );

  it('survives invalid exclusion selectors', () => {
    expect(isExcluded(field('<div></div>'), ['[[bad'])).toBe(false);
  });
});
