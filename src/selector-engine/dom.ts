/** Firefox gives extensions access to closed shadow roots through this property. */
export function shadowRootOf(element: Element): ShadowRoot | null {
  const extended = element as Element & { openOrClosedShadowRoot?: ShadowRoot | null };
  return extended.openOrClosedShadowRoot ?? element.shadowRoot ?? null;
}

/** The document plus every shadow root below it. */
export function collectRoots(start: Document | ShadowRoot): (Document | ShadowRoot)[] {
  const roots: (Document | ShadowRoot)[] = [start];
  for (let i = 0; i < roots.length; i++) {
    for (const element of roots[i]!.querySelectorAll('*')) {
      const shadow = shadowRootOf(element);
      if (shadow) roots.push(shadow);
    }
  }
  return roots;
}

export function queryAllDeep(css: string, roots: (Document | ShadowRoot)[]): Element[] {
  return roots.flatMap((root) => [...root.querySelectorAll(css)]);
}

export function allElementsDeep(roots: (Document | ShadowRoot)[], tag?: string): Element[] {
  return queryAllDeep(tag ? cssEscapeIdent(tag) : '*', roots);
}

export function composedParent(node: Node): Node | null {
  if (node.parentNode) {
    return node.parentNode instanceof ShadowRoot ? node.parentNode.host : node.parentNode;
  }
  return node instanceof ShadowRoot ? node.host : null;
}

/** `contains` that also looks through shadow boundaries. */
export function composedContains(ancestor: Node, node: Node | null): boolean {
  for (let current = node; current; current = composedParent(current)) {
    if (current === ancestor) return true;
  }
  return false;
}

export function deepElementFromPoint(x: number, y: number, doc: Document = document): Element | null {
  let element = doc.elementFromPoint(x, y);
  while (element) {
    const shadow = shadowRootOf(element);
    const inner = shadow?.elementFromPoint(x, y);
    if (!inner || inner === element) break;
    element = inner;
  }
  return element;
}

export function deepActiveElement(doc: Document = document): Element | null {
  let active = doc.activeElement;
  while (active) {
    const inner = shadowRootOf(active)?.activeElement;
    if (!inner) break;
    active = inner;
  }
  return active;
}

export function isVisible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  if (typeof element.checkVisibility === 'function') {
    return element.checkVisibility({ visibilityProperty: true } as CheckVisibilityOptions);
  }
  const style = getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

export function isDisabled(element: Element): boolean {
  if ((element as HTMLInputElement).disabled) return true;
  if (element.closest('fieldset[disabled]') && element.matches('input,select,textarea,button')) return true;
  return element.getAttribute('aria-disabled') === 'true';
}

const TEXT_INPUT_TYPES = new Set([
  'text', 'search', 'url', 'tel', 'email', 'password', 'number', '',
]);

export function isTextEntry(element: Element): element is HTMLInputElement | HTMLTextAreaElement {
  if (element.tagName === 'TEXTAREA') return true;
  return element.tagName === 'INPUT' && TEXT_INPUT_TYPES.has((element as HTMLInputElement).type);
}

export function isContentEditable(element: Element): boolean {
  return (element as HTMLElement).isContentEditable === true || element.getAttribute('contenteditable') === 'true';
}

export function isEditable(element: Element): boolean {
  return isTextEntry(element) || isContentEditable(element);
}

/** Minimal CSS.escape, for environments that lack it. */
export function cssEscapeIdent(value: string): string {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(value);
  return value.replace(/^-?\d|[^\w-]/g, (char) => `\\${char}`);
}

export function cssString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\a ')}"`;
}
