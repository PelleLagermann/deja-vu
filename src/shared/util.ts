import type { TextMatch } from './model/step';

export function createId(prefix = ''): string {
  const id = crypto.randomUUID();
  return prefix ? `${prefix}_${id}` : id;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function matchesText(actual: string, match: TextMatch): boolean {
  switch (match.mode) {
    case 'exact':
      return normalizeWhitespace(actual) === normalizeWhitespace(match.value);
    case 'contains':
      return normalizeWhitespace(actual).includes(normalizeWhitespace(match.value));
    case 'regex':
      try {
        return new RegExp(match.value).test(actual);
      } catch {
        return false;
      }
  }
}

export function describeMatch(match: TextMatch): string {
  const verb = { exact: 'equal to', contains: 'containing', regex: 'matching' }[match.mode];
  return `${verb} "${match.value}"`;
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SENSITIVE_PARAM =
  /(pass(word|wd)|pwd|secret|token|auth|session|api[-_]?key|access[-_]?key|signature|jwt)|^(pass|sid|sig|code|otp)$/i;

export const REDACTED_VALUE = 'REDACTED';

/** Replaces the values of query parameters that look like credentials. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    let changed = false;
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_PARAM.test(key)) {
        parsed.searchParams.set(key, REDACTED_VALUE);
        changed = true;
      }
    }
    return changed ? parsed.toString() : url;
  } catch {
    return url;
  }
}

const VOLATILE_SEGMENT =
  /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{24,})$/i;

/**
 * Builds a pattern for a URL reached by an earlier step. Numeric and UUID path segments
 * become wildcards, because `/orders/1042` is `/orders/1043` on the next run.
 */
export function urlToMatch(url: string): TextMatch {
  const parsed = new URL(url);
  const segments = parsed.pathname.split('/');
  const hasVolatile = segments.some((segment) => VOLATILE_SEGMENT.test(segment));
  const hash = parsed.hash.length > 1 ? parsed.hash : '';
  if (!hasVolatile) {
    return { mode: 'contains', value: `${parsed.pathname}${hash}` };
  }
  const pattern = segments
    .map((segment) => (VOLATILE_SEGMENT.test(segment) ? '[^/]+' : escapeRegExp(segment)))
    .join('/');
  return { mode: 'regex', value: `${pattern}${escapeRegExp(hash)}(\\?|#|$)` };
}

/** Origin plus path, used to compare frames across runs. */
export function frameUrlKey(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'about:' ? url : `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

export function isInjectableUrl(url: string | undefined): boolean {
  if (!url) return false;
  if (!/^(https?|file):/i.test(url)) return false;
  try {
    return !/^(addons\.mozilla\.org|accounts\.firefox\.com)$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Match pattern for a URL's host, in the form `permissions.request` expects. */
export function originPattern(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'file:') return 'file:///*';
    if (!/^https?:$/.test(parsed.protocol)) return null;
    return `*://${parsed.hostname}/*`;
  } catch {
    return null;
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class AbortError extends Error {
  constructor() {
    super('Aborted');
    this.name = 'AbortError';
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
