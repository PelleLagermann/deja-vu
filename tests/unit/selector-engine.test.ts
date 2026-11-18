import { beforeEach, describe, expect, it } from 'vitest';
import type { ElementTarget, SelectorKind } from '@shared/model/selector';
import { captureTarget, cssPath, resolveTarget, xpathFor } from '../../src/selector-engine';
import { isStableClass, isStableId } from '../../src/selector-engine/stability';

const options = { testIdAttributes: ['data-testid'] };

function html(markup: string): void {
  document.body.innerHTML = markup;
}

function get(selector: string): Element {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`No ${selector}`);
  return element;
}

function kinds(target: ElementTarget): SelectorKind[] {
  return target.selectors.map((selector) => selector.kind);
}

/** Leaves only the strategies of the given kinds, plus nothing else to fall back on. */
function only(target: ElementTarget, ...allowed: SelectorKind[]): ElementTarget {
  return { ...target, selectors: target.selectors.filter((selector) => allowed.includes(selector.kind)) };
}

beforeEach(() => html(''));

describe('capture', () => {
  it('collects many strategies, most reliable first', () => {
    html('<form><label for="e">Email</label><input id="email" data-testid="email-input" name="email" type="email" placeholder="you@x.test" aria-label="Email address"></form>');
    const target = captureTarget(get('input'), options);
    expect(kinds(target)).toEqual(['testId', 'id', 'name', 'aria', 'role', 'placeholder', 'css', 'xpath', 'context']);
    expect(target.selectors[0]).toMatchObject({ value: 'email-input', attr: 'data-testid' });
  });

  it('uses visible text for buttons and links', () => {
    html('<button>Save changes</button>');
    const target = captureTarget(get('button'), options);
    expect(target.selectors).toContainEqual({ kind: 'text', value: 'Save changes', tag: 'button' });
    expect(target.summary).toBe('button "Save changes"');
  });

  it('leaves out generated IDs', () => {
    html('<input id=":r1a:"><button id="ember123">x</button>');
    expect(kinds(captureTarget(get('input'), options))).not.toContain('id');
    expect(kinds(captureTarget(get('button'), options))).not.toContain('id');
  });

  it('never captures an input value in the fingerprint', () => {
    html('<input value="my secret">');
    const target = captureTarget(get('input'), options);
    expect(JSON.stringify(target)).not.toContain('my secret');
  });

  it('keeps general page text out of the fingerprint', () => {
    html('<div class="customer-name">Jane Doe</div>');
    const target = captureTarget(get('div'), options);
    expect(JSON.stringify(target)).not.toContain('Jane Doe');
  });

  it('skips hashed CSS classes in the CSS path', () => {
    html('<div class="css-1a2b3c card"><span class="sc-bdVaJa label">x</span></div>');
    const path = cssPath(get('span'));
    expect(path).toContain('.label');
    expect(path).not.toContain('sc-bdVaJa');
    expect(path).not.toContain('css-1a2b3c');
  });

  it('anchors paths at the nearest stable ID', () => {
    html('<div id="sidebar"><ul><li>a</li><li>b</li></ul></div>');
    expect(cssPath(get('li:nth-child(2)'))).toBe('#sidebar > ul > li:nth-of-type(2)');
    expect(xpathFor(get('li:nth-child(2)'))).toBe('//*[@id="sidebar"]/ul/li[2]');
  });
});

describe('stability heuristics', () => {
  it.each(['submit-button', 'email', 'nav_main'])('trusts %s', (id) => expect(isStableId(id)).toBe(true));
  it.each([':r1:', 'react-select-3-input', 'mui-12', '550e8400-e29b-41d4-a716-446655440000', '12345'])(
    'distrusts %s',
    (id) => expect(isStableId(id)).toBe(false),
  );
  it('rejects utility and state classes', () => {
    expect(isStableClass('mt-4')).toBe(false);
    expect(isStableClass('active')).toBe(false);
    expect(isStableClass('w-[12px]')).toBe(false);
    expect(isStableClass('primary-button')).toBe(true);
  });
});

describe('resolution', () => {
  it('prefers the most reliable strategy', () => {
    html('<button data-testid="save" id="save-btn">Save</button>');
    const target = captureTarget(get('button'), options);
    const result = resolveTarget(target, options);
    expect(result.element).toBe(get('button'));
    expect(result.resolvedBy?.kind).toBe('testId');
    expect(result.attempts[0]?.verdict).toBe('resolved');
    expect(result.attempts.at(-1)?.verdict).toBe('not-tried');
  });

  it('falls back when better selectors stop working', () => {
    html('<button data-testid="save" id="save-btn">Save</button>');
    const target = captureTarget(get('button'), options);
    html('<button id="save-btn">Save</button>');
    const result = resolveTarget(target, options);
    expect(result.element).toBe(get('button'));
    expect(result.resolvedBy?.kind).toBe('id');
    expect(result.attempts[0]).toMatchObject({ verdict: 'no-match', matchCount: 0 });
  });

  it('falls back through to text when all attributes change', () => {
    html('<button data-testid="old" id="old-id" class="old">Pay now</button>');
    const target = captureTarget(get('button'), options);
    html('<button class="new">Pay now</button>');
    const result = resolveTarget(target, options);
    expect(result.element).toBe(get('button'));
    expect(['role', 'text']).toContain(result.resolvedBy?.kind);
  });

  it('reports every attempt when nothing matches', () => {
    html('<button id="a">Save</button>');
    const target = captureTarget(get('button'), options);
    html('<p>Gone</p>');
    const result = resolveTarget(target, options);
    expect(result.element).toBeNull();
    expect(result.attempts.length).toBeGreaterThan(2);
    expect(result.attempts.every((attempt) => attempt.verdict === 'no-match')).toBe(true);
  });

  it('refuses to choose between identical matches', () => {
    html('<button>Delete</button>');
    const target = only(captureTarget(get('button'), options), 'text');
    html('<button>Delete</button><button>Delete</button>');
    const result = resolveTarget(target, options);
    expect(result.element).toBeNull();
    expect(result.attempts[0]).toMatchObject({ verdict: 'ambiguous', matchCount: 2 });
  });

  it('uses the fingerprint to pick the clearly better match', () => {
    html('<div id="users"><button data-role="x" class="danger" name="del">Delete</button></div>');
    const target = only(captureTarget(get('button'), options), 'text');
    html('<div id="orders"><button>Delete</button></div><div id="users"><button class="danger" name="del">Delete</button></div>');
    const result = resolveTarget(target, options);
    expect(result.element).toBe(get('#users button'));
    expect(result.attempts[0]?.verdict).toBe('disambiguated');
  });

  it('rejects a positional match that is clearly a different element', () => {
    html('<form><button name="save">Save</button><button name="cancel">Cancel</button></form>');
    const target = only(captureTarget(get('[name=cancel]'), options), 'css');
    html('<form><button name="save">Save</button><button name="delete">Delete everything</button></form>');
    const result = resolveTarget(target, options);
    expect(result.element).toBeNull();
    expect(result.attempts[0]?.verdict).toBe('mismatch');
  });

  it('rejects a match with the wrong tag even from a strong selector', () => {
    html('<input id="thing">');
    const target = only(captureTarget(get('input'), options), 'id');
    html('<div id="thing"></div>');
    const result = resolveTarget(target, options);
    expect(result.element).toBeNull();
    expect(result.attempts[0]?.verdict).toBe('mismatch');
  });

  it('finds an element by fingerprint alone as a last resort', () => {
    html('<section id="billing"><input name="vat" type="text" class="tax-field" placeholder="VAT number"></section>');
    const target = only(captureTarget(get('input'), options), 'context');
    html('<section id="billing"><div><input name="vat" type="text" class="tax-field" placeholder="VAT number"></div></section><input name="other">');
    const result = resolveTarget(target, options);
    expect(result.element).toBe(get('[name=vat]'));
    expect(result.resolvedBy?.kind).toBe('context');
  });

  it('skips disabled strategies', () => {
    html('<button id="a" data-testid="b">x</button>');
    const target = captureTarget(get('button'), options);
    target.selectors[0]!.disabled = true;
    expect(resolveTarget(target, options).resolvedBy?.kind).toBe('id');
  });

  it('reports invalid selectors instead of throwing', () => {
    html('<button>x</button>');
    const target = captureTarget(get('button'), options);
    target.selectors.unshift({ kind: 'css', value: '[[nonsense' });
    const result = resolveTarget(target, options);
    expect(result.attempts[0]?.verdict).toBe('invalid');
    expect(result.element).toBe(get('button'));
  });
});

describe('shadow DOM', () => {
  function shadowFixture(mode: ShadowRootMode = 'open'): Element {
    html('<my-card id="card"></my-card>');
    const root = get('#card').attachShadow({ mode });
    root.innerHTML = '<div class="inner"><button class="go" data-testid="go">Go</button></div>';
    return root.querySelector('button')!;
  }

  it('finds elements inside open shadow roots', () => {
    const button = shadowFixture();
    const target = captureTarget(button, options);
    expect(resolveTarget(target, options).element).toBe(button);
  });

  it('writes CSS paths that cross the boundary', () => {
    const button = shadowFixture();
    const path = cssPath(button);
    expect(path).toContain(' >>> ');
    const target = only(captureTarget(button, options), 'css');
    expect(resolveTarget(target, options).element).toBe(button);
  });

  it('does not produce XPath for shadow content', () => {
    const button = shadowFixture();
    expect(xpathFor(button)).toBeNull();
  });
});
