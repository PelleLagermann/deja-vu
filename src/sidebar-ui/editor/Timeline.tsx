import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from 'react';
import type { SessionMode, StepStatus } from '@shared/model/execution';
import type { Recording, RecordingMeta, StepGroup } from '@shared/model/recording';
import type { Step } from '@shared/model/step';
import { actionDetail, actionLabel, stepTitle } from '@shared/steps';
import { Icon } from '../components/Icon';
import { CommitInput, IconButton, Menu, type MenuItem } from '../components/ui';
import { StepInspector } from './StepInspector';
import { STEP_APPEARANCE } from './step-appearance';

export interface TimelineActions {
  toggleBreakpoint: (stepId: string) => void;
  patchStep: (stepId: string, mutate: (step: Step) => void) => void;
  moveStep: (stepId: string, delta: number) => void;
  reorder: (stepIds: string[], beforeStepId: string | null) => void;
  duplicateStep: (stepId: string) => void;
  deleteSteps: (stepIds: string[]) => void;
  playFrom: (index: number) => void;
  playUntil: (index: number) => void;
  playOnly: (index: number) => void;
  playRange: (from: number, to: number) => void;
  renameGroup: (groupId: string, name: string) => void;
  toggleGroup: (groupId: string) => void;
  ungroup: (groupId: string) => void;
  addToGroup: (stepIds: string[], groupId: string) => void;
  newGroup: (stepIds: string[]) => void;
}

interface TimelineProps {
  recording: Recording;
  recordings: RecordingMeta[];
  statuses: Record<string, StepStatus>;
  cursorStepId: string | null;
  pausedAtBreakpoint: boolean;
  mode: SessionMode;
  isPlaying: boolean;
  isRecording: boolean;
  openStepId: string | null;
  onOpenStep: (stepId: string | null) => void;
  selection: Set<string>;
  onSelectionChange: (selection: Set<string>) => void;
  actions: TimelineActions;
}

type Block =
  | { kind: 'step'; step: Step; index: number }
  | { kind: 'group'; group: StepGroup; items: { step: Step; index: number }[] };

/** Consecutive steps in the same group form one block. A group can't be split by others. */
function toBlocks(recording: Recording): Block[] {
  const groups = new Map(recording.groups.map((group) => [group.id, group]));
  const blocks: Block[] = [];
  recording.steps.forEach((step, index) => {
    const group = step.groupId ? groups.get(step.groupId) : undefined;
    const last = blocks.at(-1);
    if (!group) blocks.push({ kind: 'step', step, index });
    else if (last?.kind === 'group' && last.group.id === group.id) last.items.push({ step, index });
    else blocks.push({ kind: 'group', group, items: [{ step, index }] });
  });
  return blocks;
}

export function StatusMark({ status }: { status: StepStatus | undefined }) {
  switch (status) {
    case 'running':
      return <span className="spinner" role="img" aria-label="Running" />;
    case 'passed':
      return <span className="status-mark is-passed" role="img" aria-label="Passed"><Icon name="check" size={13} /></span>;
    case 'failed':
      return <span className="status-mark is-failed" role="img" aria-label="Failed"><Icon name="alert" size={13} /></span>;
    case 'skipped':
      return <span className="status-mark is-skipped" role="img" aria-label="Skipped"><Icon name="chevronRight" size={13} /></span>;
    default:
      return null;
  }
}

interface RowProps extends Pick<TimelineProps, 'statuses' | 'cursorStepId' | 'pausedAtBreakpoint' | 'isPlaying' | 'actions' | 'recording'> {
  step: Step;
  index: number;
  isOpen: boolean;
  isSelected: boolean;
  dropBefore: boolean;
  onRowClick: (event: MouseEvent) => void;
  onDragStart: (event: DragEvent) => void;
  onDragOver: (event: DragEvent) => void;
  onDragEnd: () => void;
  onDrop: (event: DragEvent) => void;
  children?: ReactNode;
}

function StepRow(props: RowProps) {
  const { step, index, statuses, cursorStepId, pausedAtBreakpoint, isPlaying, actions, recording, isOpen, isSelected } = props;
  const status = statuses[step.id];
  const isCursor = cursorStepId === step.id;
  const appearance = STEP_APPEARANCE[step.action.type];
  const detail = actionDetail(step.action);
  const breakpoint = step.breakpoint?.enabled === true;

  const groupItems: MenuItem[] = [
    { label: 'New group from this step', icon: 'group', separatorBefore: true, onSelect: () => actions.newGroup([step.id]) },
    ...recording.groups
      .filter((group) => group.id !== step.groupId)
      .map((group): MenuItem => ({ label: `Add to ${group.name}`, onSelect: () => actions.addToGroup([step.id], group.id) })),
  ];

  const menu: MenuItem[] = [
    { label: 'Play from here', icon: 'play', disabled: isPlaying, onSelect: () => actions.playFrom(index) },
    { label: 'Play until here', icon: 'range', disabled: isPlaying, onSelect: () => actions.playUntil(index) },
    { label: 'Play only this step', icon: 'step', disabled: isPlaying, onSelect: () => actions.playOnly(index) },
    { label: breakpoint ? 'Remove breakpoint' : 'Add breakpoint', icon: 'record', separatorBefore: true, onSelect: () => actions.toggleBreakpoint(step.id) },
    { label: 'Duplicate', icon: 'copy', onSelect: () => actions.duplicateStep(step.id) },
    ...groupItems,
    { label: 'Delete', icon: 'trash', danger: true, separatorBefore: true, onSelect: () => actions.deleteSteps([step.id]) },
  ];

  const classes = [
    'step',
    `cat-${appearance.category}`,
    `exec-${step.execution}`,
    status ? `status-${status}` : '',
    isCursor ? 'is-cursor' : '',
    isCursor && pausedAtBreakpoint ? 'is-stopped' : '',
    isOpen ? 'is-open' : '',
    isSelected ? 'is-selected' : '',
  ].filter(Boolean).join(' ');

  return (
    <li className="step-item" data-step-index={index}>
      {props.dropBefore && <div className="drop-line" />}
      {breakpoint && (
        <div className={`bp-line ${isCursor && pausedAtBreakpoint ? 'is-hit' : ''}`} data-testid="breakpoint-line">
          <span>{step.breakpoint?.label ?? 'Breakpoint'}</span>
        </div>
      )}
      <div
        className={classes}
        data-testid="step-row"
        data-step-id={step.id}
        data-status={status ?? 'idle'}
        data-execution={step.execution}
        data-action={step.action.type}
        draggable={!isPlaying}
        onDragStart={props.onDragStart}
        onDragOver={props.onDragOver}
        onDragEnd={props.onDragEnd}
        onDrop={props.onDrop}
      >
        <button
          type="button"
          className={`gutter ${breakpoint ? 'has-bp' : ''}`}
          aria-label={`${breakpoint ? 'Remove' : 'Add'} breakpoint before step ${index + 1}`}
          aria-pressed={breakpoint}
          title={breakpoint ? 'Remove breakpoint' : 'Add breakpoint before this step'}
          data-testid="gutter"
          onClick={() => actions.toggleBreakpoint(step.id)}
        >
          <span className="bp-dot" aria-hidden="true" />
          <span className="step-no">{index + 1}</span>
        </button>
        <button
          type="button"
          className="step-body"
          aria-expanded={isOpen}
          data-testid="step-open"
          onClick={props.onRowClick}
        >
          <span className="step-icon" title={actionLabel(step.action)}>
            <Icon name={appearance.icon} size={14} />
          </span>
          <span className="step-text">
            <span className="step-title">{stepTitle(step)}</span>
            {detail && !['navigate', 'urlChange', 'keyPress', 'wait', 'assert', 'dialog'].includes(step.action.type) && (
              <span className="step-detail mono">{detail}</span>
            )}
            {step.description && <span className="step-comment">{step.description}</span>}
          </span>
        </button>
        {step.execution !== 'required' && <span className={`exec-badge exec-badge-${step.execution}`}>{step.execution}</span>}
        {step.condition && <span className="exec-badge" title="Runs only when its condition is met">if</span>}
        <StatusMark status={status} />
        <span className="step-menu">
          <Menu label={`Actions for step ${index + 1}`} items={menu} />
        </span>
      </div>
      {props.children}
    </li>
  );
}

export function Timeline(props: TimelineProps) {
  const { recording, recordings, statuses, cursorStepId, pausedAtBreakpoint, mode, isPlaying, isRecording, openStepId, onOpenStep, selection, onSelectionChange, actions } = props;
  const blocks = useMemo(() => toBlocks(recording), [recording]);
  const [dropTarget, setDropTarget] = useState<string | 'end' | null>(null);
  const dragged = useRef<string[]>([]);
  const anchor = useRef<number | null>(null);
  const list = useRef<HTMLDivElement>(null);

  // Keep the action in view as a run moves down the list, or as steps are recorded.
  // A failure opens a panel above the list, which can push the step out of view, so this
  // also runs on mode changes, and waits for that layout.
  useEffect(() => {
    if (!cursorStepId) return undefined;
    const frame = requestAnimationFrame(() => {
      list.current?.querySelector(`[data-step-id="${CSS.escape(cursorStepId)}"]`)?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [cursorStepId, mode]);
  const stepCount = recording.steps.length;
  useEffect(() => {
    if (isRecording && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [isRecording, stepCount]);

  const onRowClick = (event: MouseEvent, step: Step, index: number) => {
    if (event.shiftKey && anchor.current !== null) {
      const [from, to] = [Math.min(anchor.current, index), Math.max(anchor.current, index)];
      onSelectionChange(new Set(recording.steps.slice(from, to + 1).map((item) => item.id)));
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      const next = new Set(selection);
      if (next.has(step.id)) next.delete(step.id);
      else next.add(step.id);
      onSelectionChange(next);
      anchor.current = index;
      return;
    }
    anchor.current = index;
    if (selection.size > 0) onSelectionChange(new Set());
    onOpenStep(openStepId === step.id ? null : step.id);
  };

  const dragHandlers = (step: Step) => ({
    onDragStart: (event: DragEvent) => {
      dragged.current = selection.has(step.id) ? recording.steps.filter((item) => selection.has(item.id)).map((item) => item.id) : [step.id];
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', step.id);
    },
    onDragOver: (event: DragEvent) => {
      if (dragged.current.length === 0) return;
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      const lowerHalf = event.clientY > rect.top + rect.height / 2;
      const index = recording.steps.findIndex((item) => item.id === step.id);
      setDropTarget(lowerHalf ? (recording.steps[index + 1]?.id ?? 'end') : step.id);
    },
    onDragEnd: () => {
      dragged.current = [];
      setDropTarget(null);
    },
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      if (dropTarget) actions.reorder(dragged.current, dropTarget === 'end' ? null : dropTarget);
      dragged.current = [];
      setDropTarget(null);
    },
  });

  const renderStep = ({ step, index }: { step: Step; index: number }) => (
    <StepRow
      key={step.id}
      step={step}
      index={index}
      recording={recording}
      statuses={statuses}
      cursorStepId={cursorStepId}
      pausedAtBreakpoint={pausedAtBreakpoint}
      isPlaying={isPlaying}
      actions={actions}
      isOpen={openStepId === step.id}
      isSelected={selection.has(step.id)}
      dropBefore={dropTarget === step.id}
      onRowClick={(event) => onRowClick(event, step, index)}
      {...dragHandlers(step)}
    >
      {openStepId === step.id && (
        <StepInspector
          step={step}
          index={index}
          stepCount={stepCount}
          recordingId={recording.id}
          recordings={recordings}
          onPatch={(mutate) => actions.patchStep(step.id, mutate)}
          onMove={(delta) => actions.moveStep(step.id, delta)}
        />
      )}
    </StepRow>
  );

  return (
    <div ref={list} className="timeline" data-testid="timeline">
      <ol className="step-list">
        {blocks.map((block) => {
          if (block.kind === 'step') return renderStep(block);
          const { group, items } = block;
          const first = items[0]!.index;
          const last = items.at(-1)!.index;
          const containsCursor = items.some((item) => item.step.id === cursorStepId);
          const hasFailure = items.some((item) => statuses[item.step.id] === 'failed');
          // A group can't stay collapsed around the step that needs attention.
          const collapsed = group.collapsed === true && !containsCursor && !hasFailure;
          return (
            <li key={`${group.id}-${first}`} className="group" data-testid="group">
              <div className="group-header">
                <IconButton
                  icon={collapsed ? 'chevronRight' : 'chevronDown'}
                  label={`${collapsed ? 'Expand' : 'Collapse'} group ${group.name}`}
                  aria-expanded={!collapsed}
                  data-testid="group-toggle"
                  onClick={() => actions.toggleGroup(group.id)}
                />
                <div className="group-name">
                  <CommitInput label="Group name" value={group.name} onCommit={(name) => name.trim() && actions.renameGroup(group.id, name.trim())} />
                </div>
                <span className="group-count">
                  {first + 1}{last > first ? `–${last + 1}` : ''}
                </span>
                <Menu
                  label={`Actions for group ${group.name}`}
                  items={[
                    { label: 'Play this group', icon: 'play', disabled: isPlaying, onSelect: () => actions.playRange(first, last) },
                    { label: 'Ungroup', icon: 'group', onSelect: () => actions.ungroup(group.id) },
                    {
                      label: 'Delete group and steps',
                      icon: 'trash',
                      danger: true,
                      separatorBefore: true,
                      onSelect: () => actions.deleteSteps(items.map((item) => item.step.id)),
                    },
                  ]}
                />
              </div>
              {!collapsed && <ol className="step-list group-steps">{items.map(renderStep)}</ol>}
            </li>
          );
        })}
      </ol>
      {dropTarget === 'end' && <div className="drop-line" />}
    </div>
  );
}
