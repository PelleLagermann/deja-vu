import type { ActionType } from '@shared/model/step';
import type { IconName } from '../components/Icon';

type Category = 'nav' | 'pointer' | 'form' | 'check' | 'meta';

export const STEP_APPEARANCE: Record<ActionType, { icon: IconName; category: Category }> = {
  navigate: { icon: 'globe', category: 'nav' },
  reload: { icon: 'restart', category: 'nav' },
  history: { icon: 'chevronLeft', category: 'nav' },
  urlChange: { icon: 'link', category: 'nav' },
  click: { icon: 'cursor', category: 'pointer' },
  doubleClick: { icon: 'cursor', category: 'pointer' },
  contextMenu: { icon: 'cursor', category: 'pointer' },
  hover: { icon: 'target', category: 'pointer' },
  dragDrop: { icon: 'move', category: 'pointer' },
  scroll: { icon: 'scroll', category: 'pointer' },
  input: { icon: 'text', category: 'form' },
  select: { icon: 'chooser', category: 'form' },
  check: { icon: 'checkSquare', category: 'form' },
  keyPress: { icon: 'keyboard', category: 'form' },
  file: { icon: 'file', category: 'form' },
  dialog: { icon: 'dialog', category: 'meta' },
  wait: { icon: 'clock', category: 'check' },
  assert: { icon: 'shield', category: 'check' },
  runRecording: { icon: 'repeat', category: 'meta' },
};
