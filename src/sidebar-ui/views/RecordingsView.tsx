import { useMemo, useState } from 'react';
import { isInjectableUrl } from '@shared/util';
import { useApp } from '../App';
import { requestAccess, send } from '../api';
import { Icon } from '../components/Icon';
import { Button, EmptyState, Menu, useToast } from '../components/ui';
import { useCollections, useRecordingList } from '../hooks';
import { useRecordingActions } from '../recording-actions';
import { RecordingRow } from './RecordingRow';

/** Starts a recording in the current tab. Must be called directly from a click. */
export function useStartRecording() {
  const { targetUrl, openRecording } = useApp();
  const toast = useToast();
  return {
    canRecord: isInjectableUrl(targetUrl ?? undefined),
    start() {
      requestAccess([targetUrl])
        .then((granted) => {
          if (!granted) throw new Error('Recording needs access to this site.');
          return send<string>({ type: 'recording/start' });
        })
        .then(openRecording)
        .catch(toast.error);
    },
  };
}

export function RecordingsView() {
  const recordings = useRecordingList();
  const collections = useCollections();
  const actions = useRecordingActions();
  const { canRecord, start } = useStartRecording();
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!recordings || words.length === 0) return recordings;
    return recordings.filter((recording) => {
      const haystack = `${recording.name} ${recording.description} ${recording.tags.join(' ')} ${recording.startUrl}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
  }, [recordings, query]);

  const recordButton = (
    <Button
      variant="primary"
      className="btn-record"
      icon="record"
      disabled={!canRecord}
      title={canRecord ? 'Record in the current tab' : "This page can't be recorded. Open a website first."}
      data-testid="start-recording"
      onClick={start}
    >
      Record
    </Button>
  );

  return (
    <div className="view">
      <div className="view-toolbar">
        <div className="search">
          <Icon name="search" size={14} />
          <input
            className="input"
            type="search"
            placeholder="Search recordings"
            aria-label="Search recordings"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        {recordButton}
        <Menu
          label="More"
          items={[
            { label: 'New empty recording', icon: 'plus', onSelect: () => void actions.createEmpty() },
            { label: 'Import from file', icon: 'upload', onSelect: () => void actions.importFromFile() },
          ]}
        />
      </div>
      <div className="view-scroll">
        {recordings?.length === 0 && (
          <EmptyState icon="record" title="Nothing recorded yet" action={recordButton}>
            Open the page you want to automate, press Record, and use it as you normally would.
          </EmptyState>
        )}
        {recordings !== null && recordings.length > 0 && filtered?.length === 0 && (
          <EmptyState icon="search" title="No matches">
            Nothing matches "{query}".
          </EmptyState>
        )}
        {filtered?.map((meta) => <RecordingRow key={meta.id} meta={meta} collections={collections} />)}
      </div>
    </div>
  );
}
