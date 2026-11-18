import type { Command, CommandResult } from '@shared/messages';
import { originPattern } from '@shared/util';
import { Storage } from '../storage-engine';

export const storage = new Storage();

/** Sends a command to the background page. Rejects with its error message on failure. */
export async function send<T = unknown>(command: Command): Promise<T> {
  const result = (await browser.runtime.sendMessage(command)) as CommandResult<T> | undefined;
  if (!result) throw new Error('The extension background page did not respond.');
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

/**
 * Asks for access to the sites behind these URLs. This has to be called directly from
 * a click handler, before any `await`, or Firefox refuses it for lack of a user gesture.
 * Already-granted origins don't prompt.
 */
export function requestAccess(urls: (string | null | undefined)[]): Promise<boolean> {
  const origins = [...new Set(urls.map((url) => (url ? originPattern(url) : null)).filter((url) => url !== null))];
  return origins.length === 0 ? Promise.resolve(true) : browser.permissions.request({ origins });
}

export function requestOrigins(origins: string[]): Promise<boolean> {
  return browser.permissions.request({ origins });
}

export function downloadJson(data: unknown, fileName: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function chooseFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      resolve(input.files?.[0] ?? null);
      input.remove();
    });
    input.addEventListener('cancel', () => {
      resolve(null);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  });
}
