import type {
  AttemptVerdict,
  ElementFingerprint,
  ElementTarget,
  SelectorAttempt,
  SelectorKind,
  SelectorStrategy,
} from '@shared/model/selector';
import { normalizeWhitespace } from '@shared/util';
import { associatedLabelText, getAccessibleName, getRole } from './accessible';
import { captureFingerprint, type CaptureOptions } from './capture';
import { allElementsDeep, collectRoots, cssEscapeIdent, cssString, isVisible, queryAllDeep, shadowRootOf } from './dom';

export interface ResolveResult {
  element: Element | null;
  attempts: SelectorAttempt[];
  /** The strategy that located the element. */
  resolvedBy: SelectorStrategy | null;
}

/** The lowest score a structural selector's match may have and still count as the same element. */
const MIN_STRUCTURAL_SCORE = 0.5;
/** `context` has nothing but the fingerprint, so it has to agree strongly. */
const MIN_CONTEXT_SCORE = 0.7;
/** How far the best candidate must lead the next one for a choice between matches to be safe. */
const CLEAR_MARGIN = 0.15;

/** Selectors that encode position, not identity, and so can land on a different element. */
const STRUCTURAL: ReadonlySet<SelectorKind> = new Set<SelectorKind>(['css', 'xpath']);

function withTag(strategy: SelectorStrategy, elements: Element[]): Element[] {
  const { tag } = strategy;
  return tag ? elements.filter((element) => element.tagName.toLowerCase() === tag) : elements;
}

function byAttribute(attr: string, value: string, tag: string | undefined, roots: (Document | ShadowRoot)[]): Element[] {
  const css = `${tag ? cssEscapeIdent(tag) : ''}[${cssEscapeIdent(attr)}=${cssString(value)}]`;
  return queryAllDeep(css, roots);
}

/** Walks one CSS expression through its ` >>> ` shadow boundaries. */
function queryPiercing(expression: string, roots: (Document | ShadowRoot)[]): Element[] {
  const [first, ...rest] = expression.split(/\s*>>>\s*/);
  let matches = queryAllDeep(first!, rest.length ? roots.slice(0, 1) : roots);
  for (const part of rest) {
    matches = matches.flatMap((host) => {
      const shadow = shadowRootOf(host);
      return shadow ? [...shadow.querySelectorAll(part)] : [];
    });
  }
  return matches;
}

function queryXpath(expression: string, doc: Document): Element[] {
  const result = doc.evaluate(expression, doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
  const elements: Element[] = [];
  for (let i = 0; i < result.snapshotLength; i++) {
    const node = result.snapshotItem(i);
    if (node instanceof Element) elements.push(node);
  }
  return elements;
}

function findMatches(strategy: SelectorStrategy, roots: (Document | ShadowRoot)[], doc: Document): Element[] {
  const { kind, value, attr, tag, role } = strategy;
  switch (kind) {
    case 'testId':
      return byAttribute(attr ?? 'data-testid', value, tag, roots);
    case 'id':
      return byAttribute('id', value, tag, roots);
    case 'name':
      return byAttribute('name', value, tag, roots);
    case 'aria':
      return byAttribute(attr ?? 'aria-label', value, tag, roots);
    case 'attribute':
      return attr ? byAttribute(attr, value, tag, roots) : [];
    case 'placeholder':
      return byAttribute('placeholder', value, tag, roots);
    case 'role': {
      const wanted = normalizeWhitespace(value);
      return allElementsDeep(roots).filter(
        (element) => getRole(element) === role && getAccessibleName(element) === wanted,
      );
    }
    case 'label': {
      const wanted = normalizeWhitespace(value);
      return withTag(strategy, queryAllDeep('input,select,textarea,meter,progress', roots)).filter(
        (element) => associatedLabelText(element) === wanted,
      );
    }
    case 'text': {
      const wanted = normalizeWhitespace(value);
      return allElementsDeep(roots, tag).filter(
        (element) => normalizeWhitespace(element.textContent ?? '') === wanted,
      );
    }
    case 'css':
      return queryPiercing(value, roots);
    case 'xpath':
      return queryXpath(value, doc);
    case 'context':
      return [];
  }
}

function overlap(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const set = new Set(a);
  const shared = b.filter((item) => set.has(item)).length;
  return shared / Math.max(a.length, b.length);
}

/**
 * Compares a recorded fingerprint with a live element, from 0 to 1. A different tag is
 * always 0. Only features the fingerprint recorded count, so a sparse fingerprint
 * isn't punished for what it never knew.
 */
export function fingerprintScore(element: Element, recorded: ElementFingerprint, options: CaptureOptions): number {
  const live = captureFingerprint(element, options);
  if (live.tag !== recorded.tag) return 0;

  let total = 0;
  let earned = 0;
  const feature = (weight: number, similarity: number) => {
    total += weight;
    earned += weight * similarity;
  };
  const same = (a: unknown, b: unknown) => (a === b ? 1 : 0);

  if (recorded.testId) feature(5, same(recorded.testId, live.testId));
  if (recorded.id) feature(4, same(recorded.id, live.id));
  if (recorded.name) feature(3, same(recorded.name, live.name));
  if (recorded.type) feature(2, same(recorded.type, live.type));
  if (recorded.role) feature(1, same(recorded.role, live.role));
  if (recorded.ariaLabel) feature(3, same(recorded.ariaLabel, live.ariaLabel));
  if (recorded.placeholder) feature(2, same(recorded.placeholder, live.placeholder));
  if (recorded.text) feature(4, same(recorded.text, live.text));
  if (recorded.classes?.length) feature(1, overlap(recorded.classes, live.classes ?? []));
  if (recorded.ancestors?.length) {
    const key = (hint: { tag: string; id?: string; testId?: string; role?: string }) =>
      `${hint.tag}|${hint.id ?? ''}|${hint.testId ?? ''}|${hint.role ?? ''}`;
    feature(2, overlap(recorded.ancestors.map(key), (live.ancestors ?? []).map(key)));
  }
  if (recorded.siblingIndex !== undefined) feature(0.5, same(recorded.siblingIndex, live.siblingIndex));
  if (recorded.visible) feature(0.5, live.visible ? 1 : 0);

  return total === 0 ? 1 : earned / total;
}

interface Choice {
  element: Element | null;
  detail?: string;
}

/** Chooses among several matches. Returns no element if the choice wouldn't be safe. */
function disambiguate(matches: Element[], target: ElementTarget, options: CaptureOptions): Choice {
  const scored = matches
    .map((element) => ({ element, score: fingerprintScore(element, target.fingerprint, options) }))
    .sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  if (best && second && best.score >= MIN_STRUCTURAL_SCORE && best.score - second.score >= CLEAR_MARGIN) {
    return {
      element: best.element,
      detail: `Chose the best of ${matches.length} matches (score ${best.score.toFixed(2)} vs ${second.score.toFixed(2)})`,
    };
  }
  if (target.fingerprint.visible) {
    const visible = matches.filter(isVisible);
    const only = visible[0];
    if (visible.length === 1 && only && fingerprintScore(only, target.fingerprint, options) >= MIN_STRUCTURAL_SCORE) {
      return { element: only, detail: `Only one of ${matches.length} matches is visible` };
    }
  }
  return { element: null };
}

function resolveByContext(
  strategy: SelectorStrategy,
  target: ElementTarget,
  roots: (Document | ShadowRoot)[],
  options: CaptureOptions,
): { element: Element | null; attempt: SelectorAttempt } {
  const candidates = allElementsDeep(roots, target.fingerprint.tag);
  const scored = candidates
    .map((element) => ({ element, score: fingerprintScore(element, target.fingerprint, options) }))
    .sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  if (!best || best.score < MIN_CONTEXT_SCORE) {
    return {
      element: null,
      attempt: {
        strategy,
        verdict: 'no-match',
        matchCount: 0,
        detail: best ? `Closest candidate scored ${best.score.toFixed(2)}` : 'No elements with this tag',
      },
    };
  }
  if (second && best.score - second.score < CLEAR_MARGIN) {
    return {
      element: null,
      attempt: {
        strategy,
        verdict: 'ambiguous',
        matchCount: scored.filter((entry) => entry.score >= MIN_CONTEXT_SCORE).length,
        detail: `Top candidates are too similar (${best.score.toFixed(2)} vs ${second.score.toFixed(2)})`,
      },
    };
  }
  return {
    element: best.element,
    attempt: { strategy, verdict: 'resolved', matchCount: 1, detail: `Score ${best.score.toFixed(2)}` },
  };
}

function attempt(strategy: SelectorStrategy, verdict: AttemptVerdict, matchCount: number, detail?: string): SelectorAttempt {
  return detail === undefined ? { strategy, verdict, matchCount } : { strategy, verdict, matchCount, detail };
}

/**
 * Tries each strategy in order. Every outcome is recorded, so a failure can show exactly
 * what happened. If the matches can't be narrowed to one element it moves on, and
 * returns null rather than choosing arbitrarily.
 */
export function resolveTarget(target: ElementTarget, options: CaptureOptions, doc: Document = document): ResolveResult {
  const roots = collectRoots(doc);
  const attempts: SelectorAttempt[] = [];
  const enabled = target.selectors.filter((strategy) => !strategy.disabled);

  for (let index = 0; index < enabled.length; index++) {
    const strategy = enabled[index]!;
    const done = (element: Element, finalAttempt: SelectorAttempt): ResolveResult => {
      attempts.push(finalAttempt);
      for (const remaining of enabled.slice(index + 1)) {
        attempts.push(attempt(remaining, 'not-tried', 0));
      }
      return { element, attempts, resolvedBy: strategy };
    };

    if (strategy.kind === 'context') {
      const result = resolveByContext(strategy, target, roots, options);
      if (result.element) return done(result.element, result.attempt);
      attempts.push(result.attempt);
      continue;
    }

    let matches: Element[];
    try {
      matches = findMatches(strategy, roots, doc);
    } catch (error) {
      attempts.push(attempt(strategy, 'invalid', 0, error instanceof Error ? error.message : String(error)));
      continue;
    }

    const [only] = matches;
    if (!only) {
      attempts.push(attempt(strategy, 'no-match', 0));
      continue;
    }

    if (matches.length > 1) {
      const choice = disambiguate(matches, target, options);
      if (choice.element) return done(choice.element, attempt(strategy, 'disambiguated', matches.length, choice.detail));
      attempts.push(attempt(strategy, 'ambiguous', matches.length));
      continue;
    }

    const score = fingerprintScore(only, target.fingerprint, options);
    const minimum = STRUCTURAL.has(strategy.kind) ? MIN_STRUCTURAL_SCORE : Number.MIN_VALUE;
    if (score < minimum) {
      const found = only.tagName.toLowerCase();
      attempts.push(
        attempt(strategy, 'mismatch', 1, `Found <${found}>, but it doesn't look like the recorded element (score ${score.toFixed(2)})`),
      );
      continue;
    }
    return done(only, attempt(strategy, 'resolved', 1));
  }

  return { element: null, attempts, resolvedBy: null };
}

/** Counts matches for each strategy on its own, for the selector tester in the editor. */
export function testStrategy(strategy: SelectorStrategy, doc: Document = document): number {
  if (strategy.kind === 'context') return 0;
  try {
    return findMatches(strategy, collectRoots(doc), doc).length;
  } catch {
    return -1;
  }
}
