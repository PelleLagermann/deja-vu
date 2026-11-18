import type { SetupAction, SetupActionType, SetupStep } from './model/setup';
import { createId } from './util';

const SETUP_LABELS: Record<SetupActionType, string> = {
  setCookie: 'Set cookie',
  deleteCookie: 'Delete cookie',
  clearCookies: 'Delete all cookies',
};

export function setupActionLabel(type: SetupActionType): string {
  return SETUP_LABELS[type];
}

export function setupTitle(action: SetupAction): string {
  const label = SETUP_LABELS[action.type];
  return action.type === 'clearCookies' ? label : `${label} ${action.name || '(no name)'}`;
}

export function newSetupStep(action: SetupAction): SetupStep {
  return { id: createId('setup'), enabled: true, action };
}

/** A fresh action of the given kind, keeping the name and site of the one it replaces. */
export function changeSetupType(action: SetupAction, type: SetupActionType): SetupAction {
  const url = action.url ? { url: action.url } : {};
  const name = 'name' in action ? action.name : '';
  switch (type) {
    case 'setCookie':
      return { type, name, value: action.type === 'setCookie' ? action.value : '', ...url };
    case 'deleteCookie':
      return { type, name, ...url };
    case 'clearCookies':
      return { type, ...url };
  }
}

/** The site a setup action applies to: its own URL, or the recording's starting URL. */
export function setupUrl(action: SetupAction, startUrl: string): string {
  return action.url?.trim() || startUrl;
}

/** Addresses whose access a setup action needs: its site, plus a cookie's shared domain. */
export function setupUrls(action: SetupAction, startUrl: string): string[] {
  const urls = [setupUrl(action, startUrl)];
  if (action.type === 'setCookie' && action.domain?.trim()) {
    urls.push(`https://${action.domain.trim().replace(/^\./, '')}/`);
  }
  return urls.filter((url) => url && !url.includes('{{'));
}
