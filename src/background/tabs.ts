import type { ContentRequest } from '@shared/messages';
import type { FrameLocator } from '@shared/model/selector';
import { frameUrlKey } from '@shared/util';

const CONTENT_SCRIPT = '/content/index.js';

type FrameDetails = NonNullable<Awaited<ReturnType<typeof browser.webNavigation.getAllFrames>>>[number];

/** The tab a session should act on: the active one, ignoring the extension's own pages. */
export async function pickTargetTab(): Promise<browser.tabs.Tab | undefined> {
  const isWebPage = (tab: browser.tabs.Tab) => !tab.url?.startsWith('moz-extension:');
  const [active] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  if (active && isWebPage(active)) return active;
  // Only reached when the UI is open as a page of its own rather than in the sidebar.
  const tabs = await browser.tabs.query({});
  return tabs.filter(isWebPage).sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
}

/** Injects the content script. It guards against running twice, so this is safe to repeat. */
export async function injectContentScript(tabId: number, frameId?: number): Promise<void> {
  await browser.scripting.executeScript({
    target: frameId === undefined ? { tabId, allFrames: true } : { tabId, frameIds: [frameId] },
    files: [CONTENT_SCRIPT],
    injectImmediately: true,
  });
}

export function sendToFrame<T>(tabId: number, frameId: number, message: ContentRequest): Promise<T> {
  return browser.tabs.sendMessage(tabId, message, { frameId }) as Promise<T>;
}

export async function frameIds(tabId: number): Promise<number[]> {
  const frames = (await browser.webNavigation.getAllFrames({ tabId })) ?? [];
  return frames.map((frame) => frame.frameId);
}

/** Sends to every frame and waits for all of them, ignoring frames with no listener. */
export async function sendToAllFrames(tabId: number, message: ContentRequest): Promise<void> {
  const ids = await frameIds(tabId).catch(() => [0]);
  await Promise.allSettled(ids.map((frameId) => sendToFrame(tabId, frameId, message)));
}

function siblingIndex(frames: FrameDetails[], frame: FrameDetails): number {
  const key = frameUrlKey(frame.url);
  return frames
    .filter((other) => other.parentFrameId === frame.parentFrameId && frameUrlKey(other.url) === key)
    .sort((a, b) => a.frameId - b.frameId)
    .indexOf(frame);
}

/** Describes a frame in a way that still means something on the next page load. */
export async function frameChain(tabId: number, frameId: number): Promise<FrameLocator[]> {
  const frames = (await browser.webNavigation.getAllFrames({ tabId })) ?? [];
  const chain: FrameLocator[] = [];
  let current = frames.find((frame) => frame.frameId === frameId);
  while (current && current.frameId !== 0) {
    chain.unshift({ url: frameUrlKey(current.url), index: siblingIndex(frames, current) });
    const parentId = current.parentFrameId;
    current = frames.find((frame) => frame.frameId === parentId);
  }
  return chain;
}

/** The inverse of `frameChain`. Returns undefined if the frame isn't there yet. */
export async function findFrame(tabId: number, chain: FrameLocator[]): Promise<number | undefined> {
  const frames = (await browser.webNavigation.getAllFrames({ tabId })) ?? [];
  let parent = 0;
  for (const link of chain) {
    const candidates = frames
      .filter((frame) => frame.parentFrameId === parent && frameUrlKey(frame.url) === link.url)
      .sort((a, b) => a.frameId - b.frameId);
    const match = candidates[link.index] ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (!match) return undefined;
    parent = match.frameId;
  }
  return parent;
}
