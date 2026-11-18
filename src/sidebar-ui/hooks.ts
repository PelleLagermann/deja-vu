import { useCallback, useEffect, useRef, useState } from 'react';
import { SIDEBAR_PORT, type SidebarEvent } from '@shared/messages';
import { IDLE_SNAPSHOT, type RunRecord, type SessionSnapshot } from '@shared/model/execution';
import {
  DEFAULT_SETTINGS,
  type Collection,
  type Recording,
  type RecordingMeta,
  type Settings,
} from '@shared/model/recording';
import type { StorageChange } from '../storage-engine';
import { storage } from './api';

const HEARTBEAT_MS = 15_000;
const RECONNECT_MS = 500;

/** The live session state, kept current over a port to the background page. */
export function useSession(): SessionSnapshot {
  const [snapshot, setSnapshot] = useState<SessionSnapshot>(IDLE_SNAPSHOT);

  useEffect(() => {
    let port: browser.runtime.Port | null = null;
    let closed = false;
    let reconnect: ReturnType<typeof setTimeout>;

    const connect = () => {
      port = browser.runtime.connect({ name: SIDEBAR_PORT });
      port.onMessage.addListener((message: object) => {
        const event = message as SidebarEvent;
        if (event.type === 'session') setSnapshot(event.snapshot);
      });
      port.onDisconnect.addListener(() => {
        port = null;
        // This happens when the event page is suspended. Reconnecting wakes it again.
        if (!closed) reconnect = setTimeout(connect, RECONNECT_MS);
      });
    };
    connect();

    // Regular traffic stops Firefox from suspending the event page mid-session.
    const heartbeat = setInterval(() => port?.postMessage({ type: 'ping' }), HEARTBEAT_MS);
    return () => {
      closed = true;
      clearTimeout(reconnect);
      clearInterval(heartbeat);
      port?.disconnect();
    };
  }, []);

  return snapshot;
}

/** Loads a value from storage, and reloads it whenever a relevant change comes in. */
function useStored<T>(load: () => Promise<T>, initial: T, isRelevant: (change: StorageChange) => boolean): T {
  const [value, setValue] = useState<T>(initial);
  const loadRef = useRef(load);
  const relevantRef = useRef(isRelevant);
  loadRef.current = load;
  relevantRef.current = isRelevant;

  const refresh = useCallback(() => {
    void loadRef.current().then(setValue);
  }, []);

  useEffect(() => {
    refresh();
    return storage.subscribe((change) => {
      if (relevantRef.current(change)) refresh();
    });
  }, [refresh]);

  return value;
}

export function useRecordingList(): RecordingMeta[] | null {
  return useStored<RecordingMeta[] | null>(() => storage.listRecordings(), null, (change) => change.entity === 'recording');
}

export function useCollections(): Collection[] {
  return useStored<Collection[]>(() => storage.listCollections(), [], (change) => change.entity === 'collection');
}

/** `undefined` while loading, `null` if it doesn't exist. */
export function useRecording(id: string): Recording | null | undefined {
  const [recording, setRecording] = useState<Recording | null | undefined>(undefined);
  useEffect(() => {
    let current = true;
    const load = () => {
      void storage.getRecording(id).then((loaded) => {
        if (current) setRecording(loaded ?? null);
      });
    };
    load();
    const unsubscribe = storage.subscribe((change) => {
      if (change.entity === 'recording' && (change.id === id || change.id === undefined)) load();
    });
    return () => {
      current = false;
      unsubscribe();
    };
  }, [id]);
  return recording;
}

export function useSettings(): Settings {
  return useStored<Settings>(() => storage.getSettings(), DEFAULT_SETTINGS, (change) => change.entity === 'settings');
}

export function useRuns(recordingId: string): RunRecord[] {
  return useStored<RunRecord[]>(
    () => storage.listRuns(recordingId),
    [],
    (change) => change.entity === 'run' && change.id === recordingId,
  );
}

/** URL of the tab a session would run in. Kept in state so that clicks can use it synchronously. */
export function useTargetUrl(): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let windowId: number | undefined;
    const refresh = () => {
      void browser.tabs.query({}).then((tabs) => {
        const pages = tabs.filter((tab) => !tab.url?.startsWith('moz-extension:'));
        const sidebarWindow = pages.find((tab) => tab.active && tab.windowId === windowId);
        const latest = sidebarWindow ?? pages.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
        setUrl(latest?.url ?? null);
      });
    };
    void browser.windows.getCurrent().then((current) => {
      windowId = current.id;
      refresh();
    });
    const onUpdated = (_id: number, change: { url?: string }) => {
      if (change.url) refresh();
    };
    browser.tabs.onActivated.addListener(refresh);
    browser.tabs.onUpdated.addListener(onUpdated);
    return () => {
      browser.tabs.onActivated.removeListener(refresh);
      browser.tabs.onUpdated.removeListener(onUpdated);
    };
  }, []);

  return url;
}

/** Applies the theme setting to the document. */
export function useTheme(theme: Settings['theme']): void {
  useEffect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);
}
