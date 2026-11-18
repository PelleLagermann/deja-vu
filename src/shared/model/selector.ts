/** Ways of locating an element, listed from most to least reliable. */
export const SELECTOR_PRIORITY = [
  'testId',
  'id',
  'name',
  'aria',
  'role',
  'label',
  'placeholder',
  'attribute',
  'text',
  'css',
  'xpath',
  'context',
] as const;

export type SelectorKind = (typeof SELECTOR_PRIORITY)[number];

export interface SelectorStrategy {
  kind: SelectorKind;
  /**
   * The value to look for. Its meaning depends on `kind`: an attribute value, an
   * accessible name, visible text, or a CSS/XPath expression. CSS expressions may use
   * ` >>> ` to cross a shadow root boundary.
   */
  value: string;
  /** Attribute name, for `testId`, `aria` and `attribute`. */
  attr?: string;
  /** ARIA role, for `role`. */
  role?: string;
  /** Restricts matching to this tag name, in lower case. */
  tag?: string;
  /** Disabled strategies stay in the recording but are not tried. */
  disabled?: boolean;
}

export interface AncestorHint {
  tag: string;
  id?: string;
  testId?: string;
  role?: string;
}

/**
 * A description of the recorded element. Used to check that a selector still points at
 * the same thing, and to choose between several matches. Deliberately excludes input values.
 */
export interface ElementFingerprint {
  tag: string;
  type?: string;
  role?: string;
  name?: string;
  id?: string;
  testId?: string;
  ariaLabel?: string;
  placeholder?: string;
  /** Accessible name or visible text, trimmed and truncated. */
  text?: string;
  classes?: string[];
  /** Nearest ancestors, innermost first. */
  ancestors?: AncestorHint[];
  /** Index among same-tag siblings. */
  siblingIndex?: number;
  visible?: boolean;
}

/** One entry per frame between the top document and the target, outermost first. */
export interface FrameLocator {
  /** Origin and path of the frame. Query strings are ignored when matching. */
  url: string;
  name?: string;
  /** Position among sibling frames with the same URL and name. */
  index: number;
}

export interface ElementTarget {
  selectors: SelectorStrategy[];
  fingerprint: ElementFingerprint;
  frames?: FrameLocator[];
  /** Short human label, for example `button "Save"`. */
  summary: string;
}

export type AttemptVerdict =
  | 'resolved'
  | 'disambiguated'
  | 'no-match'
  | 'ambiguous'
  | 'mismatch'
  | 'invalid'
  | 'not-tried';

export interface SelectorAttempt {
  strategy: SelectorStrategy;
  verdict: AttemptVerdict;
  matchCount: number;
  detail?: string;
}
