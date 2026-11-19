import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { download } from 'geckodriver';
import { Builder, By, until, type WebDriver, type WebElement } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox';
import type { Recording } from '@shared/model/recording';

export const PORT = 4599;
export const ORIGIN = `http://localhost:${PORT}`;
const ROOT = resolve(import.meta.dirname, '../..');
const FIXTURES = join(ROOT, 'tests/e2e/fixtures');
export const FIXTURE_BUILD = join(ROOT, 'tests/e2e/.build');

const ADDON_ID = 'deja-vu@lagermann';
/** Fixed so that the sidebar's address is known, and stable across restarts. */
const ADDON_UUID = '7c6f2a10-5c4e-4e0a-9a61-0d3f1f2b8e11';
export const SIDEBAR_URL = `moz-extension://${ADDON_UUID}/sidebar/index.html`;

const FIREFOX_PATHS = [
  process.env['FIREFOX_BINARY'],
  'C:\\Program Files\\Firefox Developer Edition\\firefox.exe',
  'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
  '/usr/bin/firefox',
  '/Applications/Firefox.app/Contents/MacOS/firefox',
];

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

export function startServer(): Promise<Server> {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', ORIGIN).pathname;
    // The SPA route is what the fixture's pushState points at.
    const name = path.startsWith('/spa/') ? 'form.html' : path.slice(1) || 'form.html';
    const file = [join(FIXTURE_BUILD, name), join(FIXTURES, name)].find(existsSync);
    if (!file || name.includes('..')) {
      response.writeHead(404).end('Not found');
      return;
    }
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'text/plain' });
    response.end(readFileSync(file));
  });
  return new Promise((resolvePromise) => server.listen(PORT, () => resolvePromise(server)));
}

export interface LaunchOptions {
  prefs?: Record<string, string | number | boolean>;
  /** Reuses this profile directory, which is how a restart is simulated. */
  profileDir?: string;
}

const BASE_PREFS: Record<string, string | number | boolean> = {
  // Grants optional permissions without showing the doorhanger, which WebDriver can't click.
  'extensions.webextOptionalPermissionPrompts': false,
  'extensions.webextensions.uuids': JSON.stringify({ [ADDON_ID]: ADDON_UUID }),
  'xpinstall.signatures.required': false,
  'extensions.autoDisableScopes': 0,
  'browser.download.folderList': 2,
  'browser.download.useDownloadDir': true,
  'browser.download.always_ask_before_handling_new_types': false,
  'browser.shell.checkDefaultBrowser': false,
  'datareporting.policy.dataSubmissionEnabled': false,
};

export const DOWNLOADS = join(tmpdir(), 'dejavu-e2e-downloads');

export class Browser {
  sidebar = '';
  page = '';

  private constructor(readonly driver: WebDriver) {}

  static async launch({ prefs = {}, profileDir }: LaunchOptions = {}): Promise<Browser> {
    const binary = FIREFOX_PATHS.find((path) => path && existsSync(path));
    if (!binary) throw new Error('Firefox not found. Set FIREFOX_BINARY to its path.');
    const geckodriver = await download();
    mkdirSync(DOWNLOADS, { recursive: true });

    const allPrefs = { ...BASE_PREFS, 'browser.download.dir': DOWNLOADS, ...prefs };
    const options = new firefox.Options().setBinary(binary);
    if (process.env['HEADED'] !== '1') options.addArguments('-headless');
    options.addArguments('--width=1100', '--height=900');

    if (profileDir) {
      // geckodriver doesn't apply prefs to a profile it didn't create.
      mkdirSync(profileDir, { recursive: true });
      const lines = Object.entries({ ...allPrefs, 'marionette.port': 0 }).map(
        ([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`,
      );
      writeFileSync(join(profileDir, 'user.js'), lines.join('\n'));
      options.addArguments('-profile', profileDir);
    } else {
      for (const [key, value] of Object.entries(allPrefs)) options.setPreference(key, value);
    }

    const driver = await new Builder()
      .forBrowser('firefox')
      .setFirefoxOptions(options)
      .setFirefoxService(new firefox.ServiceBuilder(geckodriver).addArguments('--allow-system-access'))
      .build();
    const browser = new Browser(driver);
    browser.page = await driver.getWindowHandle();
    return browser;
  }

  /** Installs the built extension. Permanent installs survive a restart. */
  async install({ temporary = true }: { temporary?: boolean } = {}): Promise<void> {
    const firefoxDriver = this.driver as unknown as { installAddon(path: string, temporary: boolean): Promise<string> };
    await firefoxDriver.installAddon(join(ROOT, 'dist'), temporary);
  }

  /** Opens the sidebar UI in a window of its own. The page keeps its window, so stays foreground. */
  async open(): Promise<void> {
    const before = await this.driver.getAllWindowHandles();
    // WebDriver refuses to navigate to extension pages, but the browser itself can open one.
    await this.inChrome(
      `Services.wm.getMostRecentWindow('navigator:browser').openTrustedLinkIn(arguments[0], 'window');`,
      SIDEBAR_URL,
    );
    await this.driver.wait(async () => (await this.driver.getAllWindowHandles()).length > before.length, 10_000);
    const handles = await this.driver.getAllWindowHandles();
    this.sidebar = handles.find((handle) => !before.includes(handle))!;
    await this.driver.switchTo().window(this.sidebar);
    await this.waitForTestId('nav-recordings');
  }

  /** Runs privileged script in the browser UI itself. */
  async inChrome<T>(script: string, ...args: unknown[]): Promise<T> {
    const driver = this.driver as WebDriver & { setContext(context: string): Promise<void> };
    await driver.setContext(firefox.Context.CHROME);
    try {
      return await driver.executeScript<T>(script, ...args);
    } finally {
      await driver.setContext(firefox.Context.CONTENT);
    }
  }

  async toSidebar(): Promise<void> {
    await this.driver.switchTo().window(this.sidebar);
  }

  async toPage(): Promise<void> {
    await this.driver.switchTo().window(this.page);
  }

  async goto(path: string): Promise<void> {
    await this.toPage();
    await this.driver.get(`${ORIGIN}${path}`);
  }

  css(selector: string): Promise<WebElement> {
    return this.driver.wait(until.elementLocated(By.css(selector)), 10_000, `No element ${selector}`);
  }

  async cssAll(selector: string): Promise<WebElement[]> {
    return this.driver.findElements(By.css(selector));
  }

  waitForTestId(id: string): Promise<WebElement> {
    return this.css(`[data-testid="${id}"]`);
  }

  async clickTestId(id: string): Promise<void> {
    await (await this.waitForTestId(id)).click();
  }

  async text(selector: string): Promise<string> {
    return (await this.css(selector)).getText();
  }

  async waitForText(selector: string, expected: string | RegExp, timeoutMs = 10_000): Promise<void> {
    let actual = '';
    try {
      await this.driver.wait(async () => {
        const elements = await this.cssAll(selector);
        actual = elements[0] ? await elements[0].getText() : '<missing>';
        return typeof expected === 'string' ? actual === expected : expected.test(actual);
      }, timeoutMs);
    } catch {
      throw new Error(`${selector} should be ${String(expected)}, but is "${actual}"`);
    }
  }

  async mode(): Promise<string> {
    return (await (await this.waitForTestId('transport')).getAttribute('data-mode')) ?? '';
  }

  async waitForMode(expected: string, timeoutMs = 30_000): Promise<void> {
    let actual = '';
    try {
      await this.driver.wait(async () => {
        actual = await this.mode();
        return actual === expected;
      }, timeoutMs);
    } catch {
      const status = await this.text('[data-testid="status"]').catch(() => '');
      const failure = (await this.cssAll('[data-testid="failure"]'))[0];
      throw new Error(`Mode should be ${expected}, but is ${actual}. ${status}. ${failure ? await failure.getText() : ''}`);
    }
  }

  /* ---------- Sidebar workflows ---------- */

  async allowAllSites(): Promise<void> {
    await this.toSidebar();
    await this.clickTestId('nav-settings');
    await this.clickTestId('grant-all-sites');
    await this.waitForText('[data-testid="site-access-summary"]', /all websites/);
    await this.clickTestId('nav-recordings');
  }

  async reloadSidebar(): Promise<void> {
    await this.toSidebar();
    await this.driver.navigate().refresh();
    await this.waitForTestId('nav-recordings');
  }

  async startRecording(): Promise<void> {
    await this.toSidebar();
    await this.clickTestId('start-recording');
    await this.waitForMode('recording');
  }

  /** Stops the recording and returns it as stored. */
  async stopRecording(): Promise<Recording> {
    await this.toSidebar();
    await this.clickTestId('stop-recording');
    await this.waitForMode('idle');
    const latest = (await this.recordings())[0];
    if (!latest) throw new Error('No recording was saved');
    return latest;
  }

  async openRecording(name: string): Promise<void> {
    await this.toSidebar();
    await this.driver.wait(async () => {
      for (const row of await this.cssAll('[data-testid="recording-row"]')) {
        if ((await row.getText()).includes(name)) {
          await row.click();
          return true;
        }
      }
      return false;
    }, 10_000, `No recording named ${name}`);
    await this.waitForTestId('transport');
  }

  /** Opens the open recording's actions menu and picks an item by its text. */
  async recordingMenu(label: string): Promise<void> {
    await this.toSidebar();
    await (await this.css('[aria-label="Recording actions"]')).click();
    await this.driver.wait(async () => {
      for (const item of await this.cssAll('.menu-item')) {
        if ((await item.getText()) === label) {
          await item.click();
          return true;
        }
      }
      return false;
    }, 5_000, `No menu item ${label}`);
  }

  async play(): Promise<void> {
    await this.toSidebar();
    await this.clickTestId('play');
  }

  async stepRows(): Promise<WebElement[]> {
    return this.cssAll('[data-testid="step-row"]');
  }

  async stepAttribute(index: number, attribute: string): Promise<string | null> {
    const row = (await this.stepRows())[index];
    if (!row) throw new Error(`No step ${index}`);
    return row.getAttribute(attribute);
  }

  async waitForStepStatus(index: number, status: string): Promise<void> {
    await this.driver.wait(async () => (await this.stepAttribute(index, 'data-status')) === status, 15_000, `Step ${index} should be ${status}`);
  }

  async screenshot(name: string): Promise<string> {
    const directory = join(ROOT, 'tests/e2e/.screenshots');
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${name}.png`);
    writeFileSync(path, await this.driver.takeScreenshot(), 'base64');
    return path;
  }

  /* ---------- Direct database access, for setup and for checking what was stored ---------- */

  /** Runs a script in the sidebar page, with `db` open. It must call `done(json)`. */
  private async withDatabase<T>(body: string, argument: string = ''): Promise<T> {
    await this.toSidebar();
    const result = await this.driver.executeAsyncScript<string>(
      `const done = arguments[arguments.length - 1];
       const argument = arguments[0];
       const request = indexedDB.open('deja-vu');
       request.onerror = () => done(JSON.stringify({ error: String(request.error) }));
       request.onsuccess = () => {
         const db = request.result;
         const finish = (value) => { db.close(); done(JSON.stringify({ value: value ?? null })); };
         ${body}
       };`,
      argument,
    );
    const parsed = JSON.parse(result) as { error?: string; value: T };
    if (parsed.error) throw new Error(parsed.error);
    return parsed.value;
  }

  /** All recordings, newest first, with their steps. */
  async recordings(): Promise<Recording[]> {
    const rows = await this.withDatabase<{ meta: Recording[]; content: Pick<Recording, 'id' | 'steps' | 'groups' | 'variables' | 'setup'>[] }>(`
      const tx = db.transaction(['recordings', 'recordingContent']);
      const meta = tx.objectStore('recordings').getAll();
      const content = tx.objectStore('recordingContent').getAll();
      tx.oncomplete = () => finish({ meta: meta.result, content: content.result });
    `);
    return rows.meta
      .map((meta) => ({ ...meta, ...rows.content.find((item) => item.id === meta.id)! }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async seed(recording: Recording): Promise<void> {
    await this.withDatabase(
      `const { steps, groups, variables, setup, ...meta } = JSON.parse(argument);
       const tx = db.transaction(['recordings', 'recordingContent'], 'readwrite');
       tx.objectStore('recordings').put({ ...meta, stepCount: steps.length });
       tx.objectStore('recordingContent').put({ id: meta.id, steps, groups, variables, setup });
       tx.oncomplete = () => finish();`,
      JSON.stringify(recording),
    );
    await this.reloadSidebar();
  }

  /** Leaves no session running and nothing stored, however the previous test ended. */
  async reset(): Promise<void> {
    await this.toSidebar();
    await this.driver.navigate().refresh();
    await this.driver.sleep(150);
    const stopRecording = (await this.cssAll('[data-testid="stop-recording"]'))[0];
    if (stopRecording) await stopRecording.click();
    const stop = (await this.cssAll('[data-testid="stop"]'))[0];
    if (stop && (await stop.isEnabled())) await stop.click();
    await this.driver.sleep(100);
    const back = (await this.cssAll('[data-testid="back"]'))[0];
    if (back) await back.click();
    await this.clearRecordings();
  }

  async clearRecordings(): Promise<void> {
    await this.withDatabase(`
      const stores = ['recordings', 'recordingContent', 'runs', 'collections'];
      const tx = db.transaction(stores, 'readwrite');
      for (const store of stores) tx.objectStore(store).clear();
      tx.oncomplete = () => finish();
    `);
    await this.reloadSidebar();
  }

  async quit(): Promise<void> {
    await this.driver.quit();
  }
}

export function cleanDirectory(path: string): void {
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
}
