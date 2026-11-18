import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '@shared/model/recording';
import { newRecording, newStep } from '@shared/steps';
import { Browser, ORIGIN, cleanDirectory } from './harness';

const clickLoadLater = () =>
  newStep(
    { type: 'click' },
    { target: { selectors: [{ kind: 'css', value: '#load-later' }], fingerprint: { tag: 'button' }, summary: 'Load later' } },
  );

describe('browser lifecycle', () => {
  let browser: Browser | undefined;

  afterEach(async () => {
    await browser?.quit().catch(() => undefined);
    browser = undefined;
  });

  async function start(prefs: Record<string, number> = {}): Promise<Browser> {
    browser = await Browser.launch({ prefs });
    await browser.install();
    await browser.goto('/form.html');
    await browser.open();
    await browser.allowAllSites();
    return browser;
  }

  it('keeps recordings across a full browser restart', async () => {
    const profileDir = join(tmpdir(), 'dejavu-e2e-profile');
    cleanDirectory(profileDir);

    let first: Browser | undefined = await Browser.launch({ profileDir });
    browser = first;
    await first.install({ temporary: false });
    await first.goto('/form.html');
    await first.open();
    await first.allowAllSites();

    await first.startRecording();
    await first.toPage();
    await (await first.css('#name')).sendKeys('Survivor');
    await (await first.css('#agree')).click();
    const saved = await first.stopRecording();
    await first.quit();
    first = undefined;
    browser = undefined;

    const second = await Browser.launch({ profileDir });
    browser = second;
    await second.goto('/form.html');
    await second.open();
    const reloaded = (await second.recordings()).find((recording) => recording.id === saved.id);
    expect(reloaded?.steps).toEqual(saved.steps);

    // It has to be able to run too, not just exist.
    await second.openRecording(saved.name);
    await second.play();
    await second.waitForMode('completed');
    await second.toPage();
    expect(await (await second.css('#name')).getAttribute('value')).toBe('Survivor');

    await second.quit();
    browser = undefined;
    rmSync(profileDir, { recursive: true, force: true });
  });

  it('keeps a recording going when Firefox suspends the event page', async () => {
    const session = await start({ 'extensions.background.idle.timeout': 1 });
    await session.startRecording();
    await session.toPage();
    await (await session.css('#agree')).click();
    await session.driver.sleep(4_000);
    await (await session.css('#contact-mail')).click();
    await session.driver.sleep(4_000);
    await (await session.css('#contact-phone')).click();
    const recording = await session.stopRecording();
    expect(recording.steps.map((step) => step.action.type)).toEqual(['navigate', 'check', 'check', 'check']);
  });

  it('holds a paused run for longer than the idle timeout', async () => {
    // In milliseconds. Heartbeats arrive every 10 to 15 seconds, so this has to be longer than that.
    const session = await start({ 'extensions.background.idle.timeout': 16_000 });
    await session.seed(
      newRecording({
        name: 'Long pause',
        steps: [
          newStep({ type: 'navigate', url: `${ORIGIN}/form.html` }),
          { ...clickLoadLater(), breakpoint: { enabled: true } },
        ],
      }),
    );
    await session.openRecording('Long pause');
    await session.play();
    await session.waitForMode('paused');
    await session.driver.sleep(40_000);
    await session.clickTestId('play');
    await session.waitForMode('completed');
  }, 100_000);

  /** A first-time user: nothing granted in advance, and Settings never opened. */
  async function startWithoutAccess(): Promise<Browser> {
    browser = await Browser.launch();
    await browser.install();
    await browser.goto('/form.html');
    await browser.open();
    return browser;
  }

  const grantedOrigins = async (session: Browser) =>
    session.inChrome<string[]>(`
      const { WebExtensionPolicy } = Cu.getGlobalForObject(Services);
      return WebExtensionPolicy.getByID('deja-vu@recorder.local').allowedOrigins.patterns.map((pattern) => pattern.pattern);
    `);

  it('asks for access to just the current site when recording starts', async () => {
    const session = await startWithoutAccess();
    expect((await grantedOrigins(session)).filter((origin) => origin.includes('localhost'))).toEqual([]);
    await session.startRecording();
    expect(await grantedOrigins(session)).toContain('*://localhost/*');
    expect(await grantedOrigins(session)).not.toContain('*://*/*');
    await session.toPage();
    await (await session.css('#agree')).click();
    const recording = await session.stopRecording();
    expect(recording.steps.map((step) => step.action.type)).toEqual(['navigate', 'check']);
  });

  it('offers access when a recording moves to a site it cannot reach', async () => {
    const session = await startWithoutAccess();
    await session.startRecording();
    await session.driver.sleep(300);
    await session.toPage();
    await session.driver.get('http://127.0.0.1:4599/form.html');
    await session.toSidebar();
    await session.waitForText('.banner-danger .banner-text', /no access/);
    await (await session.css('.banner-danger button')).click();
    await session.driver.wait(async () => (await session.cssAll('.banner-danger')).length === 0, 5000);

    await session.toPage();
    await (await session.css('#agree')).click();
    const recording = await session.stopRecording();
    expect(recording.steps.at(-1)?.action.type).toBe('check');
  });

it('offers access when playback reaches a site it cannot reach', async () => {
    const session = await startWithoutAccess();
    const target = (selector: string, tag: string) => ({
      selectors: [{ kind: 'css' as const, value: selector }],
      fingerprint: { tag },
      summary: selector,
    });
    await session.seed(
      newRecording({
        name: 'Two sites',
        startUrl: `${ORIGIN}/form.html`,
        steps: [
          newStep({ type: 'navigate', url: `${ORIGIN}/form.html` }),
          // A link leads to the other origin, so it can't be requested when Play is pressed.
          newStep({ type: 'click' }, { target: target('#other-origin', 'a') }),
          newStep({ type: 'assert', assertion: { kind: 'exists' } }, { target: target('#saved', 'h1') }),
        ],
      }),
    );
    await session.openRecording('Two sites');
    await session.play();
    await session.waitForMode('failed');
    const panel = await session.waitForTestId('failure');
    expect(await panel.getAttribute('data-code')).toBe('no-page-access');
    await session.clickTestId('allow-and-retry');
    await session.waitForMode('completed');
  });

  it('runs in the real Firefox sidebar', async () => {
    const session = await start();
    const opened = await session.inChrome<string>(`
      const win = Services.wm.getMostRecentBrowserWindow();
      return win.SidebarController.show('deja-vu_recorder_local-sidebar-action').then(() => win.SidebarController.currentID);
    `);
    expect(opened).toBe('deja-vu_recorder_local-sidebar-action');
  });

  it('toggles the sidebar from the toolbar button', async () => {
    const session = await start();
    const clickToolbarButton = () =>
      session.inChrome<void>(`
        const win = Services.wm.getMostRecentBrowserWindow();
        const { CustomizableUI } = win;
        const widget = CustomizableUI.getWidget('deja-vu_recorder_local-browser-action').forWindow(win);
        const button = widget.node.querySelector('.unified-extensions-item-action-button') ?? widget.node;
        button.click();
      `);
    const isOpen = () =>
      session.inChrome<boolean>(`
        const { SidebarController } = Services.wm.getMostRecentBrowserWindow();
        return SidebarController.isOpen && SidebarController.currentID === 'deja-vu_recorder_local-sidebar-action';
      `);

    await session.toPage();
    await session.inChrome(`
      const win = Services.wm.getMostRecentBrowserWindow();
      win.CustomizableUI.addWidgetToArea('deja-vu_recorder_local-browser-action', 'nav-bar');
    `);
    expect(await isOpen()).toBe(false);
    await clickToolbarButton();
    await session.driver.wait(isOpen, 5000, 'The toolbar button should open the sidebar');
    await clickToolbarButton();
    await session.driver.wait(async () => !(await isOpen()), 5000, 'The toolbar button should close the sidebar');
  });

  it('exports a recording to a file, and imports it back', async () => {
    const session = await start();
    const downloads = join(tmpdir(), 'dejavu-e2e-downloads');
    cleanDirectory(downloads);

    await session.seed(newRecording({ name: 'Round trip', steps: [clickLoadLater()], tags: ['one'] }));
    await session.openRecording('Round trip');

    const menu = await session.css('[aria-label="Recording actions"]');
    await menu.click();
    for (const item of await session.cssAll('.menu-item')) {
      if ((await item.getText()) === 'Export') {
        await item.click();
        break;
      }
    }
    await session.clickTestId('export-confirm');

    await session.driver.wait(() => readdirSync(downloads).some((name) => name.endsWith('.json')), 10_000, 'No file was downloaded');
    const name = readdirSync(downloads).find((file) => file.endsWith('.json'))!;
    expect(name).toBe('round-trip.dejavu.json');
    const exported = JSON.parse(readFileSync(join(downloads, name), 'utf8'));
    expect(exported).toMatchObject({ format: 'deja-vu-export', schemaVersion: SCHEMA_VERSION, kind: 'recording' });
    expect(exported.recordings[0].name).toBe('Round trip');

    await session.clickTestId('back');
    await session.driver.executeScript(() => {
      // A real click here would open the native file picker, which WebDriver can't answer.
      HTMLInputElement.prototype.click = function stubbed(this: HTMLInputElement) {
        this.style.display = 'block';
      };
    });
    await (await session.css('[aria-label="More"]')).click();
    for (const item of await session.cssAll('.menu-item')) {
      if ((await item.getText()) === 'Import from file') {
        await item.click();
        break;
      }
    }
    await (await session.css('input[type=file]')).sendKeys(join(downloads, name));
    await session.driver.wait(async () => (await session.cssAll('[data-testid="recording-row"]')).length === 2, 10_000);
    const recordings = await session.recordings();
    expect(recordings.map((recording) => recording.name)).toEqual(['Round trip', 'Round trip']);
    expect(new Set(recordings.map((recording) => recording.id)).size).toBe(2);
  });
});
