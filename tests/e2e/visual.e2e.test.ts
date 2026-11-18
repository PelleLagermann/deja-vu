import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, it } from 'vitest';
import type { Step } from '@shared/model/step';
import { newRecording, newStep } from '@shared/steps';
import { Browser, ORIGIN } from './harness';

/**
 * Not assertions: produces pictures of the real Firefox sidebar, for looking at.
 * The sidebar joins a session that's driven from the UI in the other window.
 */
const SHOTS = join(import.meta.dirname, '.screenshots');
let browser: Browser;

const target = (selector: string, tag: string, summary: string) => ({
  selectors: [
    { kind: 'testId' as const, attr: 'data-testid', value: selector.slice(1) },
    { kind: 'css' as const, value: selector },
  ],
  fingerprint: { tag },
  summary,
});

const steps = (): Step[] => [
  newStep({ type: 'navigate', url: `${ORIGIN}/form.html?banner=1` }),
  newStep({ type: 'click' }, { target: target('#accept-cookies', 'button', 'button "Accept"'), execution: 'optional', groupId: 'g1' }),
  newStep({ type: 'input', value: 'Ada Lovelace' }, { target: target('#name', 'input', 'textbox "Name"'), groupId: 'g2' }),
  newStep({ type: 'input', value: 'ada@example.test' }, { target: target('#email', 'input', 'textbox "Email"'), groupId: 'g2' }),
  newStep({ type: 'input', value: '', redacted: true }, { target: target('#password', 'input', 'textbox "Password"'), groupId: 'g2', execution: 'skip' }),
  newStep({ type: 'select', values: ['pro'], labels: ['Professional'] }, { target: target('#plan', 'select', 'combobox "Plan"'), groupId: 'g2', breakpoint: { enabled: true, label: 'Before the plan' } }),
  newStep({ type: 'check', checked: true }, { target: target('#agree', 'input', 'checkbox "I agree"'), groupId: 'g2' }),
  newStep({ type: 'assert', assertion: { kind: 'value', match: { mode: 'exact', value: 'Ada Lovelace' } } }, { target: target('#name', 'input', 'textbox "Name"'), groupId: 'g3' }),
  newStep({ type: 'click' }, { target: target('#missing-button', 'button', 'button "Save customer"'), groupId: 'g3', wait: { timeoutMs: 400 } }),
  newStep({ type: 'urlChange', match: { mode: 'contains', value: '/next.html' } }, { groupId: 'g3' }),
];

async function shot(name: string): Promise<void> {
  await browser.driver.sleep(500);
  const driver = browser.driver as typeof browser.driver & { setContext(context: string): Promise<void> };
  await driver.setContext('chrome');
  const image = await driver.takeScreenshot();
  await driver.setContext('content');
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(join(SHOTS, `${name}.png`), image, 'base64');
}

beforeAll(async () => {
  browser = await Browser.launch();
  await browser.install();
  await browser.goto('/form.html');
  await browser.open();
  await browser.allowAllSites();
});
afterAll(async () => browser?.quit());

it('captures the sidebar', async () => {
  await browser.seed(
    newRecording({
      name: 'Create customer',
      description: 'Fills the customer form and saves it',
      tags: ['smoke', 'customers'],
      startUrl: `${ORIGIN}/form.html`,
      steps: steps(),
      groups: [
        { id: 'g1', name: 'Cookie banner' },
        { id: 'g2', name: 'Fill customer details' },
        { id: 'g3', name: 'Submit' },
      ],
    }),
  );

  await browser.toPage();
  await browser.inChrome(`
    const win = Services.wm.getMostRecentBrowserWindow();
    return win.SidebarController.show('deja-vu_recorder_local-sidebar-action');
  `);
  await shot('sidebar-list');

  await browser.openRecording('Create customer');
  await browser.play();
  await browser.waitForMode('paused');
  await browser.toPage();
  await shot('sidebar-breakpoint');

  await browser.toSidebar();
  await browser.clickTestId('play');
  await browser.waitForMode('failed');
  await browser.toPage();
  await shot('sidebar-failure');
}, 60_000);
