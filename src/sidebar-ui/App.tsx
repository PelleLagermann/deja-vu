import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { SessionSnapshot } from '@shared/model/execution';
import type { Settings } from '@shared/model/recording';
import { Icon, type IconName } from './components/Icon';
import { ConfirmProvider, ToastProvider } from './components/ui';
import { EditorView } from './editor/EditorView';
import { useSession, useSettings, useTargetUrl, useTheme } from './hooks';
import { CollectionsView } from './views/CollectionsView';
import { RecordingsView } from './views/RecordingsView';
import { SettingsView } from './views/SettingsView';

export type Tab = 'recordings' | 'collections' | 'settings';

export interface AppContextValue {
  session: SessionSnapshot;
  settings: Settings;
  /** URL of the tab a session would run in. */
  targetUrl: string | null;
  openRecording: (id: string) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside App');
  return value;
}

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'recordings', label: 'Recordings', icon: 'list' },
  { id: 'collections', label: 'Collections', icon: 'folder' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

export function App() {
  const session = useSession();
  const settings = useSettings();
  const targetUrl = useTargetUrl();
  useTheme(settings.theme);

  const [tab, setTab] = useState<Tab>('recordings');
  const [editing, setEditing] = useState<string | null>(null);

  // Reopening the sidebar mid-session should land on what's running.
  const inProgress = session.mode !== 'idle' && session.mode !== 'completed';
  const activeId = inProgress ? (session.recording?.recordingId ?? session.playback?.recordingId ?? null) : null;
  const reopened = useRef(false);
  useEffect(() => {
    if (activeId && !reopened.current) setEditing(activeId);
    if (activeId) reopened.current = true;
  }, [activeId]);

  return (
    <AppContext.Provider value={{ session, settings, targetUrl, openRecording: setEditing }}>
      <ToastProvider>
        <ConfirmProvider>
          <div className="app">
            {editing ? (
              <EditorView key={editing} recordingId={editing} onClose={() => setEditing(null)} />
            ) : (
              <>
                <nav className="nav" aria-label="Main">
                  {TABS.map(({ id, label, icon }) => (
                    <button
                      key={id}
                      type="button"
                      className={`nav-tab ${tab === id ? 'is-active' : ''}`}
                      aria-current={tab === id ? 'page' : undefined}
                      data-testid={`nav-${id}`}
                      onClick={() => setTab(id)}
                    >
                      <Icon name={icon} size={14} />
                      {label}
                    </button>
                  ))}
                </nav>
                {tab === 'recordings' && <RecordingsView />}
                {tab === 'collections' && <CollectionsView />}
                {tab === 'settings' && <SettingsView />}
              </>
            )}
          </div>
        </ConfirmProvider>
      </ToastProvider>
    </AppContext.Provider>
  );
}
