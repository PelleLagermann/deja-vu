import { useState } from 'react';
import type { LogEntry, LogEvent, PlaybackProgress } from '@shared/model/execution';
import { Icon, type IconName } from '../components/Icon';
import { EmptyState } from '../components/ui';
import { useRuns } from '../hooks';

const EVENT_LOOK: Record<LogEvent, { icon: IconName; label: string }> = {
  started: { icon: 'play', label: 'Started' },
  completed: { icon: 'check', label: 'Completed' },
  skipped: { icon: 'chevronRight', label: 'Skipped' },
  failed: { icon: 'alert', label: 'Failed' },
  paused: { icon: 'pause', label: 'Paused' },
  note: { icon: 'list', label: '' },
};

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const time = date.toLocaleTimeString(undefined, { hour12: false });
  return `${time}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

function LogRow({ entry, onReveal }: { entry: LogEntry; onReveal: (stepId: string) => void }) {
  const { icon, label } = EVENT_LOOK[entry.event];
  const hasStep = entry.stepIndex !== undefined;
  // Setup steps are named but not numbered, and have no row to reveal.
  const isSetup = !hasStep && entry.stepName !== undefined;
  return (
    <li className={`log-row log-${entry.event}`} data-testid="log-row" data-event={entry.event}>
      <Icon name={icon} size={12} />
      <div className="log-main">
        {hasStep ? (
          <button type="button" className="log-step" onClick={() => entry.stepId && onReveal(entry.stepId)}>
            {entry.stepIndex! + 1}. {entry.stepName}
          </button>
        ) : (
          <span>{isSetup ? entry.stepName : entry.message}</span>
        )}
        {(hasStep || isSetup) && (
          <div className="log-detail">
            {label}
            {entry.durationMs !== undefined && ` in ${entry.durationMs} ms`}
            {entry.message && `: ${entry.message}`}
          </div>
        )}
      </div>
      <time className="log-time mono">{formatTime(entry.at)}</time>
    </li>
  );
}

export function LogPanel({
  recordingId,
  live,
  onReveal,
}: {
  recordingId: string;
  live: PlaybackProgress | null;
  onReveal: (stepId: string) => void;
}) {
  const runs = useRuns(recordingId);
  const [selected, setSelected] = useState<string>('latest');

  const stored = runs.filter((run) => run.id !== live?.runId);
  const pastRun = stored.find((run) => run.id === selected);
  const entries = pastRun?.log ?? live?.log ?? stored[0]?.log ?? [];

  if (entries.length === 0) {
    return (
      <EmptyState icon="list" title="No runs yet">
        Each step's start, result and duration show up here when you play this recording.
      </EmptyState>
    );
  }

  return (
    <div className="log">
      {stored.length > 0 && (
        <div className="log-picker">
          <select className="input" aria-label="Run" value={selected} onChange={(event) => setSelected(event.target.value)}>
            <option value="latest">{live ? 'Current run' : 'Latest run'}</option>
            {stored.map((run) => (
              <option key={run.id} value={run.id}>
                {new Date(run.startedAt).toLocaleString()}, {run.outcome}
              </option>
            ))}
          </select>
        </div>
      )}
      <ol className="log-list" data-testid="log">
        {entries.map((entry) => <LogRow key={entry.seq} entry={entry} onReveal={onReveal} />)}
      </ol>
    </div>
  );
}
