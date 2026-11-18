import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Command, PlaybackRange } from '@shared/messages';
import type { Recording, RecordingMeta } from '@shared/model/recording';
import type { ExecutionType, Step, StepAction } from '@shared/model/step';
import { cloneStep, newStep } from '@shared/steps';
import { createId } from '@shared/util';
import { useApp } from '../App';
import { requestAccess, requestOrigins, send, storage } from '../api';
import { Icon } from '../components/Icon';
import { Button, CommitInput, EmptyState, IconButton, Menu, useConfirm, useToast, type MenuItem } from '../components/ui';
import { useCollections, useRecording, useRecordingList } from '../hooks';
import { useRecordingActions } from '../recording-actions';
import { ExportModal } from '../views/RecordingRow';
import { DetailsModal, NameModal, VariablePromptModal, VariablesModal } from './EditorModals';
import { FailurePanel } from './FailurePanel';
import { LogPanel } from './LogPanel';
import { PlaybackBar } from './PlaybackBar';
import { SetupModal, SetupSummary } from './SetupPanel';
import { Timeline, type TimelineActions } from './Timeline';
import { usePlayback } from './usePlayback';

type ModalState = 'details' | 'variables' | 'setup' | 'export' | { newGroupFor: string[] } | null;

const NEW_STEPS: { label: string; action: StepAction; execution?: ExecutionType }[] = [
  { label: 'Assertion', action: { type: 'assert', assertion: { kind: 'visible' } } },
  { label: 'Wait', action: { type: 'wait', condition: { kind: 'visible' } } },
  { label: 'Click', action: { type: 'click' } },
  { label: 'Hover', action: { type: 'hover' } },
  { label: 'Type text', action: { type: 'input', value: '' } },
  { label: 'Key press', action: { type: 'keyPress', key: 'Enter', code: 'Enter' } },
  { label: 'Navigate', action: { type: 'navigate', url: 'https://' } },
  { label: 'Reload', action: { type: 'reload' } },
  { label: 'Run another recording', action: { type: 'runRecording', recordingId: '' } },
];

function Editor({ recording, recordings, onClose }: { recording: Recording; recordings: RecordingMeta[]; onClose: () => void }) {
  const { session, targetUrl } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const collections = useCollections();
  const recordingActions = useRecordingActions();
  const playback = usePlayback(recording);
  const { command } = playback;

  const [openStepId, setOpenStepId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [panel, setPanel] = useState<'steps' | 'log'>('steps');
  const [range, setRange] = useState<PlaybackRange>({});
  const [modal, setModal] = useState<ModalState>(null);

  const ownsSession = session.recording?.recordingId === recording.id || session.playback?.recordingId === recording.id;
  const progress = ownsSession ? session.playback : null;
  const mode = ownsSession ? session.mode : 'idle';
  const isPlaying = mode === 'playing';
  const isRecording = mode === 'recording';
  const inRun = mode === 'playing' || mode === 'paused';

  const lastWrite = useRef<Promise<unknown>>(Promise.resolve());
  const update = useCallback(
    (mutate: (draft: Recording) => void) => {
      lastWrite.current = storage.updateRecording(recording.id, mutate).catch(toast.error);
    },
    [recording.id, toast],
  );

  /**
   * Leaving a field saves it, and pressing Retry leaves the field. The save has to land
   * before the command does, or the run would use the step as it was.
   */
  const commandAfterSave = (message: Command) => {
    void lastWrite.current.then(() => command(message));
  };

  const insertStep = (action: StepAction) => {
    const step = newStep(structuredClone(action));
    if (isRecording) {
      send({ type: 'recording/addStep', step }).catch(toast.error);
    } else {
      update((draft) => {
        const after = draft.steps.findIndex((item) => item.id === openStepId);
        draft.steps.splice(after >= 0 ? after + 1 : draft.steps.length, 0, step);
      });
    }
    setOpenStepId(step.id);
    setPanel('steps');
  };

  const revealStep = (stepId: string) => {
    setPanel('steps');
    setOpenStepId(stepId);
    requestAnimationFrame(() => {
      document.querySelector(`[data-step-id="${CSS.escape(stepId)}"]`)?.scrollIntoView({ block: 'nearest' });
    });
  };

  // A failure is the next thing to look at, so bring its step into view.
  const failedStepId = progress?.failure?.stepId ?? null;
  useEffect(() => {
    if (failedStepId) setPanel('steps');
  }, [failedStepId]);

  const deleteSteps = async (stepIds: string[]) => {
    const count = stepIds.length;
    const confirmed = await confirm({
      title: count === 1 ? 'Delete step?' : `Delete ${count} steps?`,
      message: count === 1 ? 'The step will be removed from this recording.' : 'These steps will be removed from this recording.',
      confirmLabel: 'Delete',
    });
    if (!confirmed) return;
    const removed = new Set(stepIds);
    update((draft) => {
      draft.steps = draft.steps.filter((step) => !removed.has(step.id));
      const used = new Set(draft.steps.map((step) => step.groupId));
      draft.groups = draft.groups.filter((group) => used.has(group.id));
    });
    setSelection(new Set());
  };

  const addGroup = (stepIds: string[], name: string) => {
    const id = createId('grp');
    const members = new Set(stepIds);
    update((draft) => {
      draft.groups.push({ id, name });
      // Group members must sit together, so they gather where the first one is.
      const firstIndex = draft.steps.findIndex((step) => members.has(step.id));
      const moved = draft.steps.filter((step) => members.has(step.id));
      const rest = draft.steps.filter((step) => !members.has(step.id));
      for (const step of moved) step.groupId = id;
      const before = draft.steps.slice(0, firstIndex).filter((step) => !members.has(step.id)).length;
      draft.steps = [...rest.slice(0, before), ...moved, ...rest.slice(before)];
    });
    setSelection(new Set());
  };

  const timelineActions: TimelineActions = {
    toggleBreakpoint: (stepId) =>
      update((draft) => {
        const step = draft.steps.find((item) => item.id === stepId);
        if (!step) return;
        if (step.breakpoint?.enabled) delete step.breakpoint;
        else step.breakpoint = { enabled: true };
      }),
    patchStep: (stepId, mutate) =>
      update((draft) => {
        const step = draft.steps.find((item) => item.id === stepId);
        if (step) mutate(step);
      }),
    moveStep: (stepId, delta) =>
      update((draft) => {
        const index = draft.steps.findIndex((item) => item.id === stepId);
        const target = index + delta;
        if (index < 0 || target < 0 || target >= draft.steps.length) return;
        const [step] = draft.steps.splice(index, 1);
        const neighbour = draft.steps[target];
        if (step && neighbour) {
          if (neighbour.groupId) step.groupId = neighbour.groupId;
          else delete step.groupId;
        }
        draft.steps.splice(target, 0, step!);
      }),
    reorder: (stepIds, beforeStepId) =>
      update((draft) => {
        const moving = new Set(stepIds);
        if (beforeStepId && moving.has(beforeStepId)) return;
        const moved = draft.steps.filter((step) => moving.has(step.id));
        const rest = draft.steps.filter((step) => !moving.has(step.id));
        const index = beforeStepId ? rest.findIndex((step) => step.id === beforeStepId) : rest.length;
        const groupId = rest[index]?.groupId;
        for (const step of moved) {
          if (groupId) step.groupId = groupId;
          else delete step.groupId;
        }
        draft.steps = [...rest.slice(0, index), ...moved, ...rest.slice(index)];
      }),
    duplicateStep: (stepId) =>
      update((draft) => {
        const index = draft.steps.findIndex((item) => item.id === stepId);
        if (index >= 0) draft.steps.splice(index + 1, 0, cloneStep(draft.steps[index]!));
      }),
    deleteSteps: (stepIds) => void deleteSteps(stepIds),
    playFrom: (index) => playback.run({ range: { from: index } }),
    playUntil: (index) => playback.run({ range: { to: index } }),
    playOnly: (index) => playback.run({ range: { from: index, to: index } }),
    playRange: (from, to) => playback.run({ range: { from, to } }),
    renameGroup: (groupId, name) =>
      update((draft) => {
        const group = draft.groups.find((item) => item.id === groupId);
        if (group) group.name = name;
      }),
    toggleGroup: (groupId) =>
      update((draft) => {
        const group = draft.groups.find((item) => item.id === groupId);
        if (group) group.collapsed = !group.collapsed;
      }),
    ungroup: (groupId) =>
      update((draft) => {
        draft.groups = draft.groups.filter((group) => group.id !== groupId);
        for (const step of draft.steps) if (step.groupId === groupId) delete step.groupId;
      }),
    addToGroup: (stepIds, groupId) =>
      update((draft) => {
        const members = new Set(stepIds);
        const moved = draft.steps.filter((step) => members.has(step.id));
        const rest = draft.steps.filter((step) => !members.has(step.id));
        for (const step of moved) step.groupId = groupId;
        const lastIndex = rest.findLastIndex((step) => step.groupId === groupId);
        const at = lastIndex >= 0 ? lastIndex + 1 : rest.length;
        draft.steps = [...rest.slice(0, at), ...moved, ...rest.slice(at)];
      }),
    newGroup: (stepIds) => setModal({ newGroupFor: stepIds }),
  };

  const selectedIndexes = useMemo(
    () => recording.steps.flatMap((step, index) => (selection.has(step.id) ? [index] : [])),
    [recording.steps, selection],
  );

  const setExecutionForSelection = (execution: ExecutionType) => {
    update((draft) => {
      for (const step of draft.steps) if (selection.has(step.id)) step.execution = execution;
    });
  };

  const recordMore = () => {
    const openIndex = recording.steps.findIndex((step) => step.id === openStepId);
    requestAccess([targetUrl])
      .then((granted) => {
        if (!granted) throw new Error('Recording needs access to this site.');
        return send({
          type: 'recording/start',
          recordingId: recording.id,
          ...(openIndex >= 0 ? { insertAt: openIndex + 1 } : {}),
        });
      })
      .catch(toast.error);
  };

  const menuItems: MenuItem[] = [
    { label: 'Details', icon: 'text', onSelect: () => setModal('details') },
    { label: 'Variables', icon: 'variable', onSelect: () => setModal('variables') },
    { label: 'Setup', icon: 'cookie', onSelect: () => setModal('setup') },
    { label: 'Duplicate', icon: 'copy', separatorBefore: true, onSelect: () => void recordingActions.duplicate(recording) },
    { label: 'Export', icon: 'download', onSelect: () => setModal('export') },
    {
      label: 'Delete recording',
      icon: 'trash',
      danger: true,
      separatorBefore: true,
      disabled: inRun || isRecording,
      onSelect: () => {
        void recordingActions.remove(recording).then((removed) => {
          if (removed) onClose();
        });
      },
    },
  ];

  const blockedOrigin = session.recording?.blockedOrigin;

  return (
    <div className="view editor">
      <header className="editor-header">
        <IconButton icon="chevronLeft" label="Back to recordings" data-testid="back" onClick={onClose} />
        <div className="editor-title">
          <CommitInput
            label="Recording name"
            value={recording.name}
            onCommit={(name) =>
              name.trim() &&
              update((draft) => {
                draft.name = name.trim();
              })
            }
          />
        </div>
        <Menu label="Recording actions" items={menuItems} />
      </header>

      <PlaybackBar
        session={session}
        ownsSession={ownsSession}
        stepCount={recording.steps.length}
        range={range}
        onRangeChange={setRange}
        speed={playback.speed}
        onSpeedChange={playback.changeSpeed}
        onPlay={() => playback.run({ range })}
        onPause={() => command({ type: 'playback/pause' })}
        onResume={() => commandAfterSave({ type: 'playback/resume' })}
        onRetry={() => commandAfterSave({ type: 'playback/retry' })}
        onStep={() => (mode === 'paused' || mode === 'failed' ? commandAfterSave({ type: 'playback/step' }) : playback.run({ range, stepping: true }))}
        onStop={() => command({ type: 'playback/stop' })}
        onRestart={() => command({ type: 'playback/restart' })}
        onRecord={recordMore}
        onStopRecording={() => command({ type: 'recording/stop' })}
      />

      {isRecording && (
        <div className="banner banner-warn" data-testid="recording-banner">
          <Icon name="alert" size={14} />
          <span className="banner-text">
            {session.recording?.capturesValues
              ? 'Form values you type are being stored, except passwords and card numbers.'
              : "Typed values aren't being stored. Playback will ask for them."}
          </span>
        </div>
      )}
      {blockedOrigin && (
        <div className="banner banner-danger">
          <Icon name="shield" size={14} />
          <span className="banner-text">This page isn't being recorded because Déjà Vu has no access to it.</span>
          <Button onClick={() => void requestOrigins([blockedOrigin]).catch(toast.error)}>Allow</Button>
        </div>
      )}
      {progress?.pauseReason === 'manual' && progress.pauseMessage && (
        <div className="banner banner-info" data-testid="manual-banner">
          <Icon name="hand" size={14} />
          <span className="banner-text">{progress.pauseMessage}</span>
          <Button variant="primary" onClick={() => commandAfterSave({ type: 'playback/resume' })}>Done</Button>
        </div>
      )}
      {progress?.pauseReason === 'breakpoint' && progress.pauseMessage && (
        <div className="banner banner-danger" data-testid="breakpoint-banner">
          <Icon name="record" size={14} />
          <span className="banner-text">{progress.pauseMessage}</span>
        </div>
      )}
      {session.notice && (
        <div className="banner banner-warn">
          <Icon name="alert" size={14} />
          <span className="banner-text">{session.notice}</span>
        </div>
      )}
      {progress?.failure && mode === 'failed' && (
        <FailurePanel
          failure={progress.failure}
          onRetry={() => commandAfterSave({ type: 'playback/retry' })}
          onSkip={() => command({ type: 'playback/skip' })}
          onStop={() => command({ type: 'playback/stop' })}
          onReveal={() => (progress.failure!.phase === 'setup' ? setModal('setup') : revealStep(progress.failure!.stepId))}
          onAllowAndRetry={() => {
            requestAccess([progress.failure!.url])
              .then((granted) => {
                if (granted) commandAfterSave({ type: 'playback/retry' });
              })
              .catch(toast.error);
          }}
        />
      )}

      <div className="editor-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={panel === 'steps'} className={panel === 'steps' ? 'is-active' : ''} data-testid="tab-steps" onClick={() => setPanel('steps')}>
          Steps <span className="tab-count">{recording.steps.length}</span>
        </button>
        <button type="button" role="tab" aria-selected={panel === 'log'} className={panel === 'log' ? 'is-active' : ''} data-testid="tab-log" onClick={() => setPanel('log')}>
          Log
        </button>
        <div className="grow" />
        <Menu
          label="Add step"
          icon="plus"
          trigger={<><Icon name="plus" size={14} /> Add step</>}
          items={NEW_STEPS.map(({ label, action }) => ({ label, onSelect: () => insertStep(action) }))}
        />
      </div>

      {selection.size > 0 && (
        <div className="bulk-bar" data-testid="bulk-bar">
          <span>{selection.size} selected</span>
          <div className="grow" />
          <IconButton
            icon="play"
            label="Play selection"
            disabled={inRun}
            onClick={() => playback.run({ range: { from: selectedIndexes[0]!, to: selectedIndexes.at(-1)! } })}
          />
          <IconButton icon="group" label="Group selection" data-testid="group-selection" onClick={() => setModal({ newGroupFor: [...selection] })} />
          <Menu
            label="Set execution type"
            icon="checkSquare"
            items={[
              { label: 'Required', onSelect: () => setExecutionForSelection('required') },
              { label: 'Optional', onSelect: () => setExecutionForSelection('optional') },
              { label: 'Skip', onSelect: () => setExecutionForSelection('skip') },
            ]}
          />
          <IconButton icon="trash" label="Delete selection" onClick={() => void deleteSteps([...selection])} />
          <IconButton icon="close" label="Clear selection" onClick={() => setSelection(new Set())} />
        </div>
      )}

      {panel === 'steps' && recording.setup.length > 0 && (
        <SetupSummary setup={recording.setup} statuses={progress?.statuses ?? {}} onOpen={() => setModal('setup')} />
      )}

      {panel === 'steps' ? (
        recording.steps.length === 0 ? (
          <div className="view-scroll">
            <EmptyState icon="record" title="No steps yet">
              Press Record to capture steps from the current tab, or use Add step to build them by hand.
            </EmptyState>
          </div>
        ) : (
          <Timeline
            recording={recording}
            recordings={recordings}
            statuses={progress?.statuses ?? {}}
            cursorStepId={inRun ? (progress?.cursorStepId ?? null) : (mode === 'failed' ? failedStepId : null)}
            pausedAtBreakpoint={mode === 'paused' && progress?.pauseReason === 'breakpoint'}
            mode={mode}
            isPlaying={isPlaying}
            isRecording={isRecording}
            openStepId={openStepId}
            onOpenStep={setOpenStepId}
            selection={selection}
            onSelectionChange={setSelection}
            actions={timelineActions}
          />
        )
      ) : (
        <div className="view-scroll">
          <LogPanel recordingId={recording.id} live={progress} onReveal={revealStep} />
        </div>
      )}

      {modal === 'details' && <DetailsModal recording={recording} collections={collections} update={update} onClose={() => setModal(null)} />}
      {modal === 'variables' && <VariablesModal recording={recording} update={update} onClose={() => setModal(null)} />}
      {modal === 'setup' && (
        <SetupModal recording={recording} statuses={progress?.statuses ?? {}} update={update} onClose={() => setModal(null)} />
      )}
      {modal === 'export' && (
        <ExportModal title="Export recording" onClose={() => setModal(null)} onExport={(strip) => void recordingActions.exportOne(recording.id, strip)} />
      )}
      {modal !== null && typeof modal === 'object' && (
        <NameModal
          title="New group"
          label="Group name"
          initial=""
          onClose={() => setModal(null)}
          onSubmit={(name) => addGroup(modal.newGroupFor, name)}
        />
      )}
      {playback.prompt && (
        <VariablePromptModal prompt={playback.prompt} onSubmit={playback.submitPrompt} onCancel={playback.cancelPrompt} />
      )}
    </div>
  );
}

export function EditorView({ recordingId, onClose }: { recordingId: string; onClose: () => void }) {
  const recording = useRecording(recordingId);
  const recordings = useRecordingList();

  if (recording === undefined) return <div className="view" />;
  if (recording === null) {
    return (
      <div className="view">
        <EmptyState icon="alert" title="This recording no longer exists" action={<Button onClick={onClose}>Back to recordings</Button>} />
      </div>
    );
  }
  return <Editor recording={recording} recordings={recordings ?? []} onClose={onClose} />;
}
