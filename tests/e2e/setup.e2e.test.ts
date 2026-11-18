import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Recording } from '@shared/model/recording';
import type { SetupAction } from '@shared/model/setup';
import type { Step } from '@shared/model/step';
import { newSetupStep } from '@shared/setup';
import { newRecording, newStep } from '@shared/steps';
import { Browser, ORIGIN } from './harness';

const go = (path: string): Step => newStep({ type: 'navigate', url: `${ORIGIN}${path}` });

/** Checks the cookies the fixture page can see, as one line such as `a=1 b=2`. */
const cookiesAre = (expected: string): Step =>
  newStep(
    { type: 'assert', assertion: { kind: 'text', match: { mode: 'exact', value: expected } } },
    { target: { selectors: [{ kind: 'css', value: '#cookies' }], fingerprint: { tag: 'pre' }, summary: '#cookies' }, wait: { timeoutMs: 1500 } },
  );

describe('setup steps in Firefox', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await Browser.launch();
    await browser.install();
    await browser.goto('/form.html');
    await browser.open();
    await browser.allowAllSites();
  });

  afterAll(async () => {
    await browser?.quit();
  });

  beforeEach(async () => {
    await browser.reset();
    await browser.goto('/cookies.html?clear');
  });

  async function run(setup: SetupAction[], steps: Step[], partial: Partial<Recording> = {}): Promise<void> {
    const recording = newRecording({
      name: 'With setup',
      startUrl: `${ORIGIN}/form.html`,
      setup: setup.map(newSetupStep),
      steps,
      ...partial,
    });
    await browser.seed(recording);
    await browser.openRecording('With setup');
    await browser.play();
  }

  it('sets a cookie before the first step, for the starting URL by default', async () => {
    await run([{ type: 'setCookie', name: 'flag', value: 'on' }], [go('/cookies.html'), cookiesAre('flag=on')]);
    await browser.waitForMode('completed');
    await browser.toSidebar();
    await browser.waitForText('[data-testid="setup-summary"]', /Setup\s+Set cookie flag/);
  });

  it('fills variables into cookie values', async () => {
    await run(
      [{ type: 'setCookie', name: 'user', value: 'id-{{who}}' }],
      [go('/cookies.html'), cookiesAre('user=id-ada')],
      { variables: [{ name: 'who', defaultValue: 'ada' }] },
    );
    await browser.waitForMode('completed');
  });

  it('deletes one cookie and leaves the others', async () => {
    await browser.goto('/cookies.html?set=old=1&set=keep=1');
    await run([{ type: 'deleteCookie', name: 'old' }], [go('/cookies.html'), cookiesAre('keep=1')]);
    await browser.waitForMode('completed');
  });

  it('deletes every cookie of the site, then sets a fresh one', async () => {
    await browser.goto('/cookies.html?set=a=1&set=b=2');
    await run(
      [{ type: 'clearCookies' }, { type: 'setCookie', name: 'fresh', value: 'yes' }],
      [go('/cookies.html'), cookiesAre('fresh=yes')],
    );
    await browser.waitForMode('completed');
  });

  it('stops before the steps when a setup step fails, and says which', async () => {
    await run([{ type: 'setCookie', name: '', value: 'x' }], [go('/cookies.html')]);
    await browser.waitForMode('failed');
    const failure = await browser.css('[data-testid="failure"]');
    expect(await failure.getAttribute('data-code')).toBe('invalid-step');
    expect(await failure.getText()).toContain('Setup step 1 failed');
    expect(await browser.stepAttribute(0, 'data-status')).not.toBe('passed');
  });

  it('adds and edits setup steps from the recording menu', async () => {
    await browser.seed(newRecording({ name: 'Edit setup', startUrl: `${ORIGIN}/form.html`, steps: [go('/cookies.html')] }));
    await browser.openRecording('Edit setup');
    await browser.recordingMenu('Setup');

    await (await browser.css('.modal [aria-label="Add setup step"]')).click();
    for (const item of await browser.cssAll('.menu-item')) {
      if ((await item.getText()) === 'Set cookie') {
        await item.click();
        break;
      }
    }
    const name = await browser.css('[data-testid="setup-row"] [aria-label="Cookie name"]');
    await name.sendKeys('consent');
    const value = await browser.css('[data-testid="setup-row"] [aria-label="Cookie value"]');
    await value.click();
    await value.sendKeys('granted');
    await name.click();

    await browser.driver.wait(async () => {
      const [stored] = await browser.recordings();
      const action = stored?.setup[0]?.action;
      return action?.type === 'setCookie' && action.name === 'consent' && action.value === 'granted';
    }, 5_000, 'The setup step was not saved');

    await (await browser.css('.setup-options > summary')).click();
    await browser.screenshot('setup-modal');
    await (await browser.css('.modal-footer .btn')).click();
    await browser.waitForText('[data-testid="setup-summary"]', /Set cookie consent/);
    await browser.screenshot('setup-summary');
  });
});
