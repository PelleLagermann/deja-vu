import { useState } from 'react';
import type { PlaybackRange } from '@shared/messages';
import type { SessionSnapshot } from '@shared/model/execution';
import { Icon } from '../components/Icon';
import { IconButton, NumberInput } from '../components/ui';

const SPEEDS = [
  { value: 0.25, label: '0.25×' },
  { value: 0.5, label: '0.5×' },
  { value: 1, label: '1×' },
  { value: 2, label: '2×' },
  { value: 4, label: '4×' },
  { value: 100, label: 'Max' },
];

interface PlaybackBarProps {
  session: SessionSnapshot;
  /** True if the session belongs to this recording. */
  ownsSession: boolean;
  stepCount: number;
  range: PlaybackRange;
  onRangeChange: (range: PlaybackRange) => void;
  speed: number;
  onSpeedChange: (speed: number) => void;
  onPlay: () => void;
  onPause: () => void;
  onResume: () => void;
  onRetry: () => void;
  onStep: () => void;
  onStop: () => void;
  onRestart: () => void;
  onRecord: () => void;
  onStopRecording: () => void;
}

function statusText(session: SessionSnapshot, stepCount: number): string {
  const progress = session.playback;
  switch (session.mode) {
    case 'recording':
      return `Recording, ${session.recording?.stepCount ?? 0} steps`;
    case 'playing':
      return `Playing step ${(progress?.cursorIndex ?? 0) + 1} of ${stepCount}`;
    case 'paused':
      if (progress?.pauseReason === 'breakpoint') return `Breakpoint at step ${progress.cursorIndex + 1}`;
      if (progress?.pauseReason === 'manual') return `Waiting for you at step ${progress.cursorIndex + 1}`;
      return `Paused before step ${(progress?.cursorIndex ?? 0) + 1}`;
    case 'failed':
      return `Failed at step ${(progress?.failure?.stepIndex ?? 0) + 1}`;
    case 'completed':
      return 'Completed';
    default:
      return 'Ready';
  }
}

function RangeControl({ range, stepCount, onChange }: { range: PlaybackRange; stepCount: number; onChange: (range: PlaybackRange) => void }) {
  const [open, setOpen] = useState(false);
  const isSet = range.from !== undefined || range.to !== undefined;
  const from = range.from === undefined ? undefined : range.from + 1;
  const to = range.to === undefined ? undefined : range.to + 1;
  const clamp = (value: number | undefined) => (value === undefined ? undefined : Math.min(Math.max(value, 1), stepCount) - 1);

  return (
    <>
      <IconButton
        icon="range"
        label={isSet ? `Playing steps ${from ?? 1} to ${to ?? stepCount}` : 'Play a range of steps'}
        active={isSet}
        aria-expanded={open}
        data-testid="range-toggle"
        onClick={() => setOpen(!open)}
      />
      {open && (
        <div className="range-row">
          <span>Steps</span>
          <NumberInput label="First step" placeholder="1" min={1} value={from} onCommit={(value) => onChange({ ...range, from: clamp(value) })} />
          <span>to</span>
          <NumberInput label="Last step" placeholder={String(stepCount)} min={1} value={to} onCommit={(value) => onChange({ ...range, to: clamp(value) })} />
          <IconButton icon="close" label="Clear range" onClick={() => onChange({})} />
        </div>
      )}
    </>
  );
}

export function PlaybackBar(props: PlaybackBarProps) {
  const { session, ownsSession, stepCount, speed } = props;
  const mode = ownsSession ? session.mode : 'idle';
  const busyElsewhere = !ownsSession && session.mode !== 'idle' && session.mode !== 'completed' && session.mode !== 'failed';
  const recording = mode === 'recording';
  const canControl = !busyElsewhere && !recording && stepCount > 0;

  const mainButton = (() => {
    switch (mode) {
      case 'playing':
        return { icon: 'pause', label: 'Pause', action: props.onPause } as const;
      case 'paused':
        return { icon: 'play', label: 'Resume until next breakpoint', action: props.onResume } as const;
      case 'failed':
        return { icon: 'play', label: 'Retry failed step', action: props.onRetry } as const;
      default:
        return { icon: 'play', label: 'Play', action: props.onPlay } as const;
    }
  })();

  const progress = session.playback;
  const donePercent =
    ownsSession && progress && stepCount > 0
      ? Math.round(
          (Object.values(progress.statuses).filter((status) => status === 'passed' || status === 'skipped').length / stepCount) * 100,
        )
      : 0;

  return (
    <div className={`transport mode-${mode}`} data-testid="transport" data-mode={mode}>
      <div className="transport-row">
        <button
          type="button"
          className="transport-main"
          disabled={!canControl}
          aria-label={mainButton.label}
          title={mainButton.label}
          data-testid="play"
          onClick={mainButton.action}
        >
          <Icon name={mainButton.icon} />
        </button>
        <IconButton
          icon="step"
          label="Play next step"
          disabled={!canControl || mode === 'playing'}
          data-testid="step"
          onClick={props.onStep}
        />
        <IconButton
          icon="stop"
          label="Stop"
          disabled={!(mode === 'playing' || mode === 'paused' || mode === 'failed')}
          data-testid="stop"
          onClick={props.onStop}
        />
        <IconButton
          icon="restart"
          label="Restart from the beginning"
          disabled={!(mode === 'playing' || mode === 'paused' || mode === 'failed' || mode === 'completed')}
          data-testid="restart"
          onClick={props.onRestart}
        />
        <select
          className="speed"
          aria-label="Playback speed"
          title="Playback speed"
          data-testid="speed"
          value={speed}
          onChange={(event) => props.onSpeedChange(Number(event.target.value))}
        >
          {SPEEDS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <RangeControl range={props.range} stepCount={stepCount} onChange={props.onRangeChange} />
        <div className="grow" />
        {recording ? (
          <button type="button" className="btn btn-danger" data-testid="stop-recording" onClick={props.onStopRecording}>
            <Icon name="stop" size={14} /> Stop
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-default btn-record"
            disabled={busyElsewhere || mode === 'playing' || mode === 'paused'}
            title="Record more steps into this recording"
            data-testid="record-more"
            onClick={props.onRecord}
          >
            <Icon name="record" size={14} /> Record
          </button>
        )}
      </div>
      <div className="transport-status" data-testid="status">
        {recording && <span className="rec-dot" aria-hidden="true" />}
        {busyElsewhere ? 'Another session is running' : statusText(ownsSession ? session : { ...session, mode: 'idle' }, stepCount)}
      </div>
      <div className="transport-progress" aria-hidden="true">
        <div style={{ width: `${donePercent}%` }} />
      </div>
    </div>
  );
}
