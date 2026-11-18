const SENSITIVE_AUTOCOMPLETE = /^(current-password|new-password|one-time-code|cc-(number|csc|exp|exp-month|exp-year|name))$/i;
const SENSITIVE_NAME =
  /(pass(word|wd|code|phrase)|^pass$|pwd|secret|\bcvv|\bcvc|\bssn\b|card.?(number|num|no)\b|(^|[-_\s])(otp|pin|iban)($|[-_\s]))/i;

/** Fields whose values are never captured, whatever the settings say. */
export function isSensitiveField(element: Element): boolean {
  if (element.tagName === 'INPUT' && (element as HTMLInputElement).type === 'password') return true;
  const autocomplete = element.getAttribute('autocomplete')?.trim().split(/\s+/).pop();
  if (autocomplete && SENSITIVE_AUTOCOMPLETE.test(autocomplete)) return true;
  return ['name', 'id', 'aria-label', 'placeholder'].some((attribute) => {
    const value = element.getAttribute(attribute);
    return value !== null && SENSITIVE_NAME.test(value);
  });
}

export const IGNORE_ATTRIBUTE = 'data-dejavu-ignore';

/** Checks the built-in opt-out attribute and the user's exclusion list. */
export function isExcluded(element: Element, excludedSelectors: string[]): boolean {
  if (element.closest(`[${IGNORE_ATTRIBUTE}]`)) return true;
  return excludedSelectors.some((selector) => {
    try {
      return element.closest(selector) !== null;
    } catch {
      return false;
    }
  });
}
