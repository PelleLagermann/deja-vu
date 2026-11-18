const OVERLAY_ATTRIBUTE = 'data-dejavu-overlay';
const FLASH_MS = 450;

const FONT = 'font: 500 12px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif;';

/**
 * Everything the extension draws in a page. Styles are set through the CSSOM because
 * a page's Content-Security-Policy can block `<style>` elements but not this.
 */
export class Overlay {
  private host: HTMLElement | null = null;
  private root: ShadowRoot | null = null;
  private badge: HTMLElement | null = null;
  private box: HTMLElement | null = null;
  private label: HTMLElement | null = null;
  private tracked: Element | null = null;
  private trackTimer: ReturnType<typeof setInterval> | null = null;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;

  owns(element: Element): boolean {
    return this.host !== null && (element === this.host || this.host.contains(element));
  }

  /** Null this early in a page load, when there's nothing to attach to yet. */
  private ensureRoot(): ShadowRoot | null {
    if (this.root && this.host?.isConnected) return this.root;
    if (!document.documentElement) return null;
    const host = document.createElement('div');
    host.setAttribute(OVERLAY_ATTRIBUTE, '');
    host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;';
    this.root = host.attachShadow({ mode: 'closed' });
    document.documentElement.appendChild(host);
    this.host = host;
    this.badge = null;
    this.box = null;
    this.label = null;
    return this.root;
  }

  showBadge(text: string, color: string): void {
    const root = this.ensureRoot();
    if (!root) {
      document.addEventListener('DOMContentLoaded', () => this.showBadge(text, color), { once: true });
      return;
    }
    if (!this.badge) {
      this.badge = document.createElement('div');
      root.appendChild(this.badge);
    }
    this.badge.style.cssText = `position: fixed; right: 12px; bottom: 12px; padding: 6px 10px; border-radius: 6px;
      background: rgba(20, 22, 26, 0.92); color: #f2f3f5; ${FONT} box-shadow: 0 2px 10px rgba(0,0,0,.3);
      border-left: 3px solid ${color}; max-width: 320px;`;
    this.badge.textContent = text;
  }

  hideBadge(): void {
    this.badge?.remove();
    this.badge = null;
    this.removeIfEmpty();
  }

  private positionBox(element: Element): void {
    if (!this.box) return;
    const rect = element.getBoundingClientRect();
    Object.assign(this.box.style, {
      left: `${rect.left - 2}px`,
      top: `${rect.top - 2}px`,
      width: `${rect.width + 4}px`,
      height: `${rect.height + 4}px`,
    });
    if (this.label) {
      this.label.style.left = `${Math.max(rect.left - 2, 4)}px`;
      this.label.style.top = `${rect.top > 26 ? rect.top - 24 : rect.bottom + 4}px`;
    }
  }

  /** Outlines an element and keeps following it as the page moves. */
  highlight(element: Element, text?: string, color = '#3b9dff'): void {
    const root = this.ensureRoot();
    if (!root) return;
    if (!this.box) {
      this.box = document.createElement('div');
      root.appendChild(this.box);
    }
    this.box.style.cssText = `position: fixed; box-sizing: border-box; border: 2px solid ${color};
      background: ${color}22; border-radius: 3px; pointer-events: none;`;

    if (text) {
      if (!this.label) {
        this.label = document.createElement('div');
        root.appendChild(this.label);
      }
      this.label.style.cssText = `position: fixed; padding: 2px 6px; border-radius: 3px; background: ${color};
        color: #fff; ${FONT} white-space: nowrap; pointer-events: none;`;
      this.label.textContent = text;
    } else {
      this.label?.remove();
      this.label = null;
    }

    this.tracked = element;
    this.positionBox(element);
    if (!this.trackTimer) {
      this.trackTimer = setInterval(() => {
        if (this.tracked?.isConnected) this.positionBox(this.tracked);
      }, 100);
    }
  }

  /** A brief highlight, shown as playback acts on an element. */
  flash(element: Element): void {
    this.highlight(element);
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => this.clearHighlight(), FLASH_MS);
  }

  clearHighlight(): void {
    if (this.trackTimer) clearInterval(this.trackTimer);
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.trackTimer = null;
    this.flashTimer = null;
    this.tracked = null;
    this.box?.remove();
    this.label?.remove();
    this.box = null;
    this.label = null;
    this.removeIfEmpty();
  }

  private removeIfEmpty(): void {
    if (this.badge || this.box) return;
    this.host?.remove();
    this.host = null;
    this.root = null;
  }
}
