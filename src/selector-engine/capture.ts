import type {
  AncestorHint,
  ElementFingerprint,
  ElementTarget,
  SelectorStrategy,
} from '@shared/model/selector';
import { normalizeWhitespace, truncate } from '@shared/util';
import { associatedLabelText, getAccessibleName, getRole } from './accessible';
import { cssEscapeIdent, isVisible } from './dom';
import { isStableDataAttribute, isStableId, stableClasses } from './stability';

export interface CaptureOptions {
  testIdAttributes: string[];
}

const TEXT_LIMIT = 80;

/** Elements whose visible text identifies them, and is unlikely to be user data. */
const TEXT_IDENTIFIED = 'button,a,summary,label,legend,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=switch],[role=treeitem]';

function firstTestId(element: Element, attributes: string[]): { attr: string; value: string } | null {
  for (const attr of attributes) {
    const value = element.getAttribute(attr);
    if (value) return { attr, value };
  }
  return null;
}

function nthOfType(element: Element): number {
  let index = 1;
  for (let sibling = element.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
    if (sibling.tagName === element.tagName) index++;
  }
  return index;
}

function hasSameTagSibling(element: Element): boolean {
  const parent = element.parentNode;
  if (!parent) return false;
  return [...parent.children].some((child) => child !== element && child.tagName === element.tagName);
}

function isUniqueInRoot(root: ParentNode, css: string): boolean {
  try {
    return root.querySelectorAll(css).length === 1;
  } catch {
    return false;
  }
}

function cssSegment(element: Element): string {
  const tag = cssEscapeIdent(element.tagName.toLowerCase());
  const classes = stableClasses(element)
    .slice(0, 2)
    .map((name) => `.${cssEscapeIdent(name)}`)
    .join('');
  const nth = hasSameTagSibling(element) ? `:nth-of-type(${nthOfType(element)})` : '';
  return `${tag}${classes}${nth}`;
}

/** Path from the element up to its root, or to the nearest ancestor with a usable ID. */
function cssPathInRoot(element: Element): string {
  const root = element.getRootNode() as ParentNode;
  const segments: string[] = [];
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (current.id && isStableId(current.id)) {
      const anchor = `#${cssEscapeIdent(current.id)}`;
      if (isUniqueInRoot(root, anchor)) {
        segments.unshift(anchor);
        break;
      }
    }
    if (current.tagName === 'HTML' || current.tagName === 'BODY') {
      if (segments.length === 0) segments.unshift(current.tagName.toLowerCase());
      break;
    }
    segments.unshift(cssSegment(current));
  }
  return segments.join(' > ');
}

/** CSS path that uses ` >>> ` to step through each shadow root on the way. */
export function cssPath(element: Element): string {
  const parts: string[] = [];
  let current: Element | null = element;
  while (current) {
    parts.unshift(cssPathInRoot(current));
    const root: Node = current.getRootNode();
    current = root instanceof ShadowRoot ? root.host : null;
  }
  return parts.join(' >>> ');
}

/** XPath can't cross shadow boundaries, so this returns null for elements in a shadow root. */
export function xpathFor(element: Element): string | null {
  if (element.getRootNode() instanceof ShadowRoot) return null;
  const segments: string[] = [];
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (current.id && isStableId(current.id) && current !== element) {
      segments.unshift(`//*[@id=${xpathLiteral(current.id)}]`);
      return segments.join('/');
    }
    const name = current.tagName.toLowerCase();
    const isHtml = current.namespaceURI === 'http://www.w3.org/1999/xhtml';
    const test = isHtml ? name : `*[local-name()=${xpathLiteral(current.localName)}]`;
    segments.unshift(hasSameTagSibling(current) ? `${test}[${nthOfType(current)}]` : test);
  }
  return `/${segments.join('/')}`;
}

function xpathLiteral(value: string): string {
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  return `concat(${value.split('"').map((part) => `"${part}"`).join(`,'"',`)})`;
}

function ancestorHints(element: Element, testIdAttributes: string[]): AncestorHint[] {
  const hints: AncestorHint[] = [];
  for (
    let current = element.parentElement;
    current && hints.length < 3 && current.tagName !== 'BODY' && current.tagName !== 'HTML';
    current = current.parentElement
  ) {
    const hint: AncestorHint = { tag: current.tagName.toLowerCase() };
    if (current.id && isStableId(current.id)) hint.id = current.id;
    const testId = firstTestId(current, testIdAttributes);
    if (testId) hint.testId = testId.value;
    const role = getRole(current);
    if (role) hint.role = role;
    hints.push(hint);
  }
  return hints;
}

function identifyingText(element: Element): string {
  if (!element.matches(TEXT_IDENTIFIED)) return '';
  return normalizeWhitespace(element.textContent ?? '');
}

export function captureFingerprint(element: Element, options: CaptureOptions): ElementFingerprint {
  const testId = firstTestId(element, options.testIdAttributes);
  const name = getAccessibleName(element);
  const isFormField = element.matches('input,textarea,select');
  const fingerprint: ElementFingerprint = {
    tag: element.tagName.toLowerCase(),
    classes: stableClasses(element).slice(0, 6),
    ancestors: ancestorHints(element, options.testIdAttributes),
    siblingIndex: nthOfType(element),
    visible: isVisible(element),
  };
  const type = element.getAttribute('type');
  const role = getRole(element);
  const fieldName = element.getAttribute('name');
  const ariaLabel = element.getAttribute('aria-label');
  const placeholder = element.getAttribute('placeholder');
  if (type) fingerprint.type = type;
  if (role) fingerprint.role = role;
  if (fieldName) fingerprint.name = fieldName;
  if (element.id && isStableId(element.id)) fingerprint.id = element.id;
  if (testId) fingerprint.testId = testId.value;
  if (ariaLabel) fingerprint.ariaLabel = truncate(ariaLabel, TEXT_LIMIT);
  if (placeholder) fingerprint.placeholder = truncate(placeholder, TEXT_LIMIT);
  // Text inside a general-purpose element may be customer data, so only identifying
  // text and names of form fields are kept.
  const text = isFormField ? name : identifyingText(element) || (element.matches('img,svg') ? name : '');
  if (text) fingerprint.text = truncate(text, TEXT_LIMIT);
  return fingerprint;
}

function buildStrategies(element: Element, options: CaptureOptions): SelectorStrategy[] {
  const tag = element.tagName.toLowerCase();
  const strategies: SelectorStrategy[] = [];

  const testId = firstTestId(element, options.testIdAttributes);
  if (testId) strategies.push({ kind: 'testId', attr: testId.attr, value: testId.value });

  if (element.id && isStableId(element.id)) strategies.push({ kind: 'id', value: element.id });

  const fieldName = element.getAttribute('name');
  if (fieldName) strategies.push({ kind: 'name', value: fieldName, tag });

  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel) strategies.push({ kind: 'aria', attr: 'aria-label', value: ariaLabel, tag });

  const role = getRole(element);
  const accessibleName = getAccessibleName(element);
  if (role && accessibleName && accessibleName.length <= TEXT_LIMIT) {
    strategies.push({ kind: 'role', role, value: accessibleName });
  }

  const label = associatedLabelText(element);
  if (label && label.length <= TEXT_LIMIT) strategies.push({ kind: 'label', value: label, tag });

  const placeholder = element.getAttribute('placeholder');
  if (placeholder) strategies.push({ kind: 'placeholder', value: placeholder, tag });

  for (const attr of ['title', 'alt', 'for', 'href', 'src']) {
    const value = element.getAttribute(attr);
    if (value && value.length <= 120 && !value.startsWith('data:') && !value.startsWith('javascript:')) {
      strategies.push({ kind: 'attribute', attr, value, tag });
    }
  }
  const dataAttributes = [...element.attributes]
    .filter((attribute) => !options.testIdAttributes.includes(attribute.name))
    .filter((attribute) => isStableDataAttribute(attribute.name, attribute.value))
    .slice(0, 2);
  for (const attribute of dataAttributes) {
    strategies.push({ kind: 'attribute', attr: attribute.name, value: attribute.value, tag });
  }

  const text = identifyingText(element);
  if (text && text.length <= TEXT_LIMIT) strategies.push({ kind: 'text', value: text, tag });

  strategies.push({ kind: 'css', value: cssPath(element) });

  const xpath = xpathFor(element);
  if (xpath) strategies.push({ kind: 'xpath', value: xpath });

  strategies.push({ kind: 'context', value: 'fingerprint', tag });
  return strategies;
}

function summarize(element: Element, fingerprint: ElementFingerprint): string {
  const label =
    fingerprint.ariaLabel ??
    fingerprint.text ??
    fingerprint.placeholder ??
    fingerprint.name ??
    fingerprint.testId ??
    fingerprint.id;
  const kind = fingerprint.role && fingerprint.role !== 'generic' ? fingerprint.role : fingerprint.tag;
  return label ? `${kind} "${truncate(label, 40)}"` : `<${element.tagName.toLowerCase()}>`;
}

export function captureTarget(element: Element, options: CaptureOptions): ElementTarget {
  const fingerprint = captureFingerprint(element, options);
  return {
    selectors: buildStrategies(element, options),
    fingerprint,
    summary: summarize(element, fingerprint),
  };
}
