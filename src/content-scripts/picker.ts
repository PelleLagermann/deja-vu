import type { ElementTarget } from '@shared/model/selector';
import { captureTarget, deepElementFromPoint } from '../selector-engine';
import type { Overlay } from './overlay';

const PICK_COLOR = '#e8a13c';

/** Lets the user choose an element by clicking it. Nothing in the page sees those clicks. */
export class ElementPicker {
  private cancelCurrent: (() => void) | null = null;

  constructor(private readonly overlay: Overlay) {}

  get active(): boolean {
    return this.cancelCurrent !== null;
  }

  cancel(): void {
    this.cancelCurrent?.();
  }

  pick(testIdAttributes: string[]): Promise<ElementTarget | null> {
    this.cancel();
    return new Promise((resolve) => {
      const controller = new AbortController();
      const options = { capture: true, signal: controller.signal };
      let hovered: Element | null = null;

      const finish = (result: ElementTarget | null) => {
        controller.abort();
        this.cancelCurrent = null;
        this.overlay.clearHighlight();
        this.overlay.hideBadge();
        resolve(result);
      };
      this.cancelCurrent = () => finish(null);

      const swallow = (event: Event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
      };

      this.overlay.showBadge('Click an element to select it. Esc cancels.', PICK_COLOR);

      window.addEventListener(
        'mousemove',
        (event) => {
          const element = deepElementFromPoint(event.clientX, event.clientY);
          if (!element || element === hovered) return;
          hovered = element;
          this.overlay.highlight(element, element.tagName.toLowerCase(), PICK_COLOR);
        },
        options,
      );
      window.addEventListener('mousedown', swallow, options);
      window.addEventListener('mouseup', swallow, options);
      window.addEventListener(
        'click',
        (event) => {
          swallow(event);
          const element = deepElementFromPoint(event.clientX, event.clientY);
          finish(element ? captureTarget(element, { testIdAttributes }) : null);
        },
        options,
      );
      window.addEventListener(
        'keydown',
        (event) => {
          if (event.key !== 'Escape') return;
          swallow(event);
          finish(null);
        },
        options,
      );
    });
  }
}
