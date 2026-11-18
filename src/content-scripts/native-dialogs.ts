import type { NativeDialogKind } from '@shared/model/step';

/** Firefox's API for handing a content script function to the page. */
declare function exportFunction<T extends (...args: never[]) => unknown>(
  fn: T,
  target: object,
  options?: { defineAs?: string },
): T;

type PageWindow = Window & { wrappedJSObject?: Record<string, unknown> };

export interface DialogCall {
  kind: NativeDialogKind;
  message: string;
  /** Shows the real dialog and returns what the user did. */
  showNative: () => unknown;
}

type DialogHandler = (call: DialogCall) => unknown;

const KINDS: NativeDialogKind[] = ['alert', 'confirm', 'prompt'];

/**
 * Replaces `alert`, `confirm` and `prompt` in the page. These block the page's thread,
 * and the content script with it, so nothing could respond to them from outside.
 * Returns a function that restores the originals.
 */
export function patchNativeDialogs(handler: DialogHandler): () => void {
  const page = (window as PageWindow).wrappedJSObject;
  if (!page || typeof exportFunction !== 'function') return () => undefined;

  const originals = new Map<NativeDialogKind, unknown>();
  for (const kind of KINDS) {
    const original = page[kind] as (...args: unknown[]) => unknown;
    originals.set(kind, original);
    exportFunction(
      ((...args: unknown[]) =>
        handler({
          kind,
          message: String(args[0] ?? ''),
          // `apply` would fail: the page's realm isn't allowed to read an array from this one.
          showNative: () => original.call(page, ...args),
        })) as (...args: never[]) => unknown,
      page,
      { defineAs: kind },
    );
  }
  return () => {
    for (const [kind, original] of originals) page[kind] = original;
  };
}
