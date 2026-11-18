import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Key } from 'selenium-webdriver';
import type { Recording } from '@shared/model/recording';
import type { ElementTarget, SelectorKind } from '@shared/model/selector';
import type { Step, StepAction } from '@shared/model/step';
import { newRecording, newStep } from '@shared/steps';
import { Browser, ORIGIN } from './harness';

/** Builds a target from CSS only, or with whatever strategies a test wants. */
function target(selector: string, tag = 'button', extra: Partial<ElementTarget> = {}): ElementTarget {
  return { selectors: [{ kind: 'css', value: selector }], fingerprint: { tag }, summary: selector, ...extra };
}

function clickOn(selector: string, partial: Partial<Step> = {}): Step {
  return newStep({ type: 'click' }, { target: target(selector), ...partial });
}

function fill(selector: string, value: string, partial: Partial<Step> = {}): Step {
  return newStep({ type: 'input', value }, { target: target(selector, 'input'), ...partial });
}

function go(path: string): Step {
  return newStep({ type: 'navigate', url: `${ORIGIN}${path}` });
}

function assertStep(action: Extract<StepAction, { type: 'assert' }>['assertion'], selector?: string, tag = 'div', partial: Partial<Step> = {}): Step {
  return newStep({ type: 'assert', assertion: action }, { ...(selector ? { target: target(selector, tag) } : {}), wait: { timeoutMs: 800 }, ...partial });
}

describe('playback in Firefox', () => {
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
  });

  async function open(steps: Step[], partial: Partial<Recording> = {}): Promise<Recording> {
    const recording = newRecording({ name: 'Seeded', startUrl: `${ORIGIN}/form.html`, steps, ...partial });
    await browser.seed(recording);
    await browser.openRecording('Seeded');
    return recording;
  }

  async function run(steps: Step[], partial: Partial<Recording> = {}): Promise<Recording> {
    const recording = await open(steps, partial);
    await browser.play();
    return recording;
  }

  async function runToCompletion(steps: Step[]): Promise<void> {
    await run(steps);
    await browser.waitForMode('completed');
    await browser.toPage();
  }

  describe('form controls', () => {
    it('fills every kind of control', async () => {
      await runToCompletion([
        go('/form.html'),
        fill('#name', 'Ada'),
        newStep({ type: 'input', value: 'A long note' }, { target: target('#notes', 'textarea') }),
        newStep({ type: 'select', values: ['pro'], labels: ['Professional'] }, { target: target('#plan', 'select') }),
        newStep({ type: 'check', checked: true }, { target: target('#agree', 'input') }),
        newStep({ type: 'check', checked: true }, { target: target('#contact-phone', 'input') }),
        fill('#date', '2026-11-06'),
        fill('#seats', '7'),
        clickOn('#submit'),
        newStep({ type: 'urlChange', match: { mode: 'contains', value: '/next.html' } }),
      ]);
      const query = await browser.text('#query');
      for (const part of ['customer_name=Ada', 'plan=pro', 'agree=on', 'contact=phone', 'date=2026-11-06', 'seats=7']) {
        expect(query).toContain(part);
      }
    });

    it('runs blur validation even though the sidebar has focus', async () => {
      await runToCompletion([go('/form.html'), fill('#email', 'not-an-email'), clickOn('#agree', { target: target('#agree', 'input') })]);
      await browser.waitForText('#blur-state', 'invalid');
    });

    it('drives React controlled components', async () => {
      const testId = (value: string, tag: string) => target(`[data-testid="${value}"]`, tag);
      await runToCompletion([
        go('/react.html'),
        newStep({ type: 'input', value: 'Grace' }, { target: testId('react-name', 'input') }),
        newStep({ type: 'check', checked: true }, { target: testId('react-agree', 'input') }),
        newStep({ type: 'select', values: ['pro'], labels: [] }, { target: testId('react-plan', 'select') }),
        newStep({ type: 'click' }, { target: testId('react-submit', 'button') }),
      ]);
      await browser.waitForText('[data-testid="react-mirror"]', 'Grace');
      await browser.waitForText('[data-testid="react-items"]', 'Grace/pro/true');
    });

    it('types key by key when asked to', async () => {
      await runToCompletion([
        go('/react.html'),
        newStep({ type: 'input', value: 'Slow', typing: 'keystrokes' }, { target: target('[data-testid="react-name"]', 'input') }),
      ]);
      await browser.waitForText('[data-testid="react-mirror"]', 'Slow');
    });

    it('submits a form with Enter, as a browser would', async () => {
      await runToCompletion([
        go('/form.html'),
        fill('#name', 'Ada'),
        newStep({ type: 'keyPress', key: 'Enter', code: 'Enter' }, { target: target('#name', 'input') }),
        newStep({ type: 'urlChange', match: { mode: 'contains', value: '/next.html' } }),
      ]);
      await browser.waitForText('#saved', 'Customer saved');
    });

    it('moves focus with Tab', async () => {
      await runToCompletion([
        go('/form.html'),
        clickOn('#name', { target: target('#name', 'input') }),
        newStep({ type: 'keyPress', key: 'Tab', code: 'Tab' }),
      ]);
      const focused = await browser.driver.executeScript<string>(() => document.activeElement?.id);
      expect(focused).toBe('email');
    });

    it('fires keyboard shortcuts and closes a dialog element with Escape', async () => {
      await runToCompletion([
        go('/form.html'),
        newStep({ type: 'keyPress', key: 'k', code: 'KeyK', modifiers: { ctrl: true } }, { target: target('#key-target') }),
        clickOn('#open-dialog'),
        newStep({ type: 'keyPress', key: 'Escape', code: 'Escape' }),
      ]);
      await browser.waitForText('#key-result', 'shortcut fired');
      expect(await browser.driver.executeScript(() => (document.querySelector('#native-dialog') as HTMLDialogElement).open)).toBe(false);
    });

    it('double-clicks and right-clicks', async () => {
      await runToCompletion([
        go('/form.html'),
        newStep({ type: 'doubleClick' }, { target: target('#dblclick-target', 'div') }),
        newStep({ type: 'contextMenu' }, { target: target('#context-target', 'div') }),
      ]);
      await browser.waitForText('#dblclick-result', 'double');
      await browser.waitForText('#context-result', 'context');
    });

    it('performs HTML5 drag and drop, including its data', async () => {
      await runToCompletion([
        go('/form.html'),
        newStep(
          { type: 'dragDrop', mode: 'html5', destination: target('#drop-target', 'div') },
          { target: target('#drag-source', 'div') },
        ),
      ]);
      await browser.waitForText('#drop-result', 'dropped payload');
    });

    it('performs a mouse drag', async () => {
      await runToCompletion([
        go('/form.html'),
        newStep(
          { type: 'dragDrop', mode: 'pointer', destination: target('#slider-track', 'div'), toOffset: { x: 0.9, y: 0.5 } },
          { target: target('#slider-handle', 'div') },
        ),
      ]);
      await browser.waitForText('#slider-result', 'moved far');
    });

    it('scrolls', async () => {
      await runToCompletion([go('/form.html'), newStep({ type: 'scroll', x: 0, y: 700 })]);
      expect(await browser.driver.executeScript(() => window.scrollY)).toBe(700);
    });

    it('scrolls to off-screen targets by itself', async () => {
      await runToCompletion([go('/form.html'), clickOn('#context-target', { action: { type: 'contextMenu' }, target: target('#context-target', 'div') })]);
      await browser.waitForText('#context-result', 'context');
    });
  });

  describe('shadow DOM and frames', () => {
    it('clicks inside open and closed shadow roots', async () => {
      const inner = (id: string): ElementTarget => ({
        selectors: [{ kind: 'id', value: id }],
        fingerprint: { tag: 'button', id },
        summary: id,
      });
      await run([go('/form.html'), newStep({ type: 'click' }, { target: inner('open-inner') })]);
      await browser.waitForMode('completed');
      await browser.toPage();
      await browser.waitForText('#shadow-result', 'open clicked');

      await browser.toSidebar();
      await browser.clickTestId('back');
      await browser.clearRecordings();
      await run([go('/form.html'), newStep({ type: 'click' }, { target: inner('closed-inner') })]);
      await browser.waitForMode('completed');
      await browser.toPage();
      await browser.waitForText('#shadow-result', 'closed clicked');
    });

    it('acts inside same-origin and cross-origin frames', async () => {
      const frames = (host: string) => [{ url: `http://${host}:4599/frame.html`, index: 0 }];
      const inFrame = (selector: string, tag: string, host: string) => target(selector, tag, { frames: frames(host) });
      await runToCompletion([
        go('/form.html'),
        newStep({ type: 'input', value: 'same' }, { target: inFrame('#frame-input', 'input', 'localhost') }),
        newStep({ type: 'click' }, { target: inFrame('#frame-button', 'button', 'localhost') }),
        newStep({ type: 'input', value: 'cross' }, { target: inFrame('#frame-input', 'input', '127.0.0.1') }),
        newStep({ type: 'click' }, { target: inFrame('#frame-button', 'button', '127.0.0.1') }),
      ]);
      await browser.driver.switchTo().frame(await browser.css('#same-frame'));
      await browser.waitForText('#frame-result', 'frame got same');
      await browser.driver.switchTo().defaultContent();
      await browser.driver.switchTo().frame(await browser.css('#cross-frame'));
      await browser.waitForText('#frame-result', 'frame got cross');
      await browser.driver.switchTo().defaultContent();
    });
  });

  describe('native dialogs', () => {
    it('answers a recorded confirm without freezing', async () => {
      await runToCompletion([
        go('/form.html'),
        clickOn('#confirm-button'),
        newStep({ type: 'dialog', kind: 'confirm', accept: true, message: 'Really delete?' }),
      ]);
      await browser.waitForText('#dialog-result', 'confirmed');
    });

    it('answers a recorded prompt', async () => {
      await runToCompletion([
        go('/form.html'),
        clickOn('#prompt-button'),
        newStep({ type: 'dialog', kind: 'prompt', accept: true, message: 'New name?', promptText: 'Hopper' }),
      ]);
      await browser.waitForText('#dialog-result', 'renamed to Hopper');
    });
  });

  describe('intelligent waits', () => {
    it('waits for an element that appears later', async () => {
      await runToCompletion([go('/form.html'), clickOn('#load-later'), clickOn('#late-button')]);
      await browser.waitForText('#click-result', 'late clicked');
    });

    it('waits for a disabled element to become enabled', async () => {
      await runToCompletion([go('/form.html'), clickOn('#enable-it'), clickOn('#disabled-then-enabled')]);
      await browser.waitForText('#click-result', 'enabled clicked');
    });

    it('waits for something covering the target to go away', async () => {
      await runToCompletion([go('/form.html'), clickOn('#spinner-button'), clickOn('#load-later'), clickOn('#late-button')]);
      await browser.waitForText('#click-result', 'late clicked');
    });

    it('supports explicit wait steps', async () => {
      await runToCompletion([
        go('/form.html'),
        clickOn('#load-later'),
        newStep({ type: 'wait', condition: { kind: 'visible' } }, { target: target('#late-button') }),
        clickOn('#spinner-button'),
        newStep({ type: 'wait', condition: { kind: 'loadingGone', selector: '#overlay' } }),
        newStep({ type: 'wait', condition: { kind: 'text', match: { mode: 'contains', value: 'I arrived late' } } }),
        newStep({ type: 'wait', condition: { kind: 'delay', ms: 50 } }),
      ]);
    });

    it('waits for an element to disappear before acting', async () => {
      await runToCompletion([
        go('/form.html'),
        clickOn('#spinner-button'),
        newStep({ type: 'check', checked: true }, { target: target('#agree', 'input'), wait: { waitForGone: '#overlay' } }),
      ]);
    });

    it('times out with an explanation', async () => {
      await run([
        go('/form.html'),
        newStep({ type: 'wait', condition: { kind: 'visible' } }, { target: target('#never'), wait: { timeoutMs: 400 } }),
      ]);
      await browser.waitForMode('failed');
      expect(await browser.text('[data-testid="failure"]')).toContain('Timed out after 400 ms');
    });

    it('goes back, forward and reloads', async () => {
      await runToCompletion([
        go('/form.html'),
        go('/next.html'),
        newStep({ type: 'history', direction: 'back' }),
        assertStep({ kind: 'url', match: { mode: 'contains', value: '/form.html' } }),
        newStep({ type: 'history', direction: 'forward' }),
        assertStep({ kind: 'url', match: { mode: 'contains', value: '/next.html' } }),
        newStep({ type: 'reload' }),
        assertStep({ kind: 'exists' }, '#saved', 'h1'),
      ]);
    });

    it('explains what is covering a target', async () => {
      await run([
        go('/form.html'),
        clickOn('#spinner-button'),
        clickOn('#load-later', { wait: { timeoutMs: 300 } }),
      ]);
      await browser.waitForMode('failed');
      expect(await browser.text('[data-testid="failure"]')).toMatch(/covered by <div#overlay>/);
      await browser.clickTestId('retry');
      await browser.waitForMode('completed');
    });
  });

  describe('debugger controls', () => {
    const fourClicks = () => [go('/form.html'), clickOn('#load-later'), clickOn('#enable-it'), clickOn('#spinner-button')];

    it('pauses at a breakpoint set in the gutter, then resumes', async () => {
      await open(fourClicks());
      await (await browser.stepRows())[2]!.findElement({ css: '[data-testid="gutter"]' }).click();
      await browser.waitForTestId('breakpoint-line');
      await browser.play();
      await browser.waitForMode('paused');
      expect(await browser.text('[data-testid="breakpoint-banner"]')).toContain('Breakpoint before step 3');
      expect(await browser.stepAttribute(1, 'data-status')).toBe('passed');
      expect(await browser.stepAttribute(2, 'data-status')).toBe('pending');
      await browser.screenshot('breakpoint');

      await browser.clickTestId('play');
      await browser.waitForMode('completed');
      expect(await browser.stepAttribute(3, 'data-status')).toBe('passed');
    });

    it('removes a breakpoint when the gutter is clicked again', async () => {
      await open([go('/form.html'), clickOn('#load-later', { breakpoint: { enabled: true } })]);
      await (await browser.stepRows())[1]!.findElement({ css: '[data-testid="gutter"]' }).click();
      await browser.driver.wait(async () => (await browser.cssAll('[data-testid="breakpoint-line"]')).length === 0, 5000);
      await browser.play();
      await browser.waitForMode('completed');
    });

    it('steps one at a time', async () => {
      await open(fourClicks());
      await browser.clickTestId('step');
      await browser.waitForStepStatus(0, 'passed');
      await browser.waitForMode('paused');
      expect(await browser.stepAttribute(1, 'data-status')).toBe('pending');

      await browser.clickTestId('step');
      await browser.waitForStepStatus(1, 'passed');
      await browser.waitForMode('paused');
      expect(await browser.stepAttribute(2, 'data-status')).toBe('pending');
      await browser.clickTestId('stop');
      await browser.waitForMode('idle');
    });

    it('pauses and resumes a running playback', async () => {
      await open([
        go('/form.html'),
        newStep({ type: 'wait', condition: { kind: 'delay', ms: 700 } }),
        clickOn('#load-later'),
      ]);
      await browser.play();
      await browser.waitForStepStatus(1, 'running');
      await browser.clickTestId('play');
      await browser.waitForMode('paused');
      expect(await browser.stepAttribute(1, 'data-status')).toBe('passed');
      expect(await browser.stepAttribute(2, 'data-status')).toBe('pending');
      await browser.clickTestId('play');
      await browser.waitForMode('completed');
    });

    it('stops at once, even in the middle of a long wait', async () => {
      await open([go('/form.html'), clickOn('#never', { wait: { timeoutMs: 30_000 } })]);
      await browser.play();
      await browser.waitForStepStatus(1, 'running');
      const started = Date.now();
      await browser.clickTestId('stop');
      await browser.waitForMode('idle');
      expect(Date.now() - started).toBeLessThan(3000);
    });

    it('restarts from the first step', async () => {
      await open(fourClicks());
      await browser.play();
      await browser.waitForMode('completed');
      await browser.clickTestId('restart');
      await browser.waitForMode('playing').catch(() => undefined);
      await browser.waitForMode('completed');
      await browser.clickTestId('tab-log');
      const rows = await browser.cssAll('[data-testid="log-row"][data-event="completed"]');
      expect(rows).toHaveLength(4);
    });

    it('plays a range chosen in the transport bar', async () => {
      await browser.goto('/form.html');
      await open(fourClicks());
      await browser.clickTestId('range-toggle');
      await (await browser.css('[aria-label="First step"]')).sendKeys('2', Key.TAB);
      await (await browser.css('[aria-label="Last step"]')).sendKeys('3', Key.TAB);
      await browser.play();
      await browser.waitForMode('completed');
      expect(await browser.stepAttribute(0, 'data-status')).toBe('idle');
      expect(await browser.stepAttribute(1, 'data-status')).toBe('passed');
      expect(await browser.stepAttribute(2, 'data-status')).toBe('passed');
      expect(await browser.stepAttribute(3, 'data-status')).toBe('idle');
    });

    async function chooseFromStepMenu(index: number, label: string): Promise<void> {
      const row = (await browser.stepRows())[index]!;
      await browser.driver.actions().move({ origin: row }).perform();
      await (await row.findElement({ css: '.step-menu button' })).click();
      for (const item of await browser.cssAll('.menu-item')) {
        if ((await item.getText()) === label) {
          await item.click();
          return;
        }
      }
      throw new Error(`No menu item ${label}`);
    }

    it('plays from a selected step', async () => {
      await browser.goto('/form.html');
      await open(fourClicks());
      await chooseFromStepMenu(2, 'Play from here');
      await browser.waitForMode('completed');
      expect(await browser.stepAttribute(1, 'data-status')).toBe('idle');
      expect(await browser.stepAttribute(3, 'data-status')).toBe('passed');
    });

    it('plays until a selected step', async () => {
      await open(fourClicks());
      await chooseFromStepMenu(1, 'Play until here');
      await browser.waitForMode('completed');
      expect(await browser.stepAttribute(1, 'data-status')).toBe('passed');
      expect(await browser.stepAttribute(2, 'data-status')).toBe('idle');
    });

    it('plays only a selected step', async () => {
      await browser.goto('/form.html');
      await open(fourClicks());
      await chooseFromStepMenu(1, 'Play only this step');
      await browser.waitForMode('completed');
      expect(await browser.stepAttribute(0, 'data-status')).toBe('idle');
      expect(await browser.stepAttribute(1, 'data-status')).toBe('passed');
      expect(await browser.stepAttribute(2, 'data-status')).toBe('idle');
    });
  });

  describe('execution types', () => {
    it('skips an optional step for a cookie banner that is not there', async () => {
      await run([go('/form.html'), clickOn('#accept-cookies', { execution: 'optional' }), clickOn('#load-later')]);
      await browser.waitForMode('completed');
      expect(await browser.stepAttribute(1, 'data-status')).toBe('skipped');
      expect(await browser.stepAttribute(2, 'data-status')).toBe('passed');
    });

    it('performs the same optional step when the banner is there', async () => {
      await run([go('/form.html?banner=1'), clickOn('#accept-cookies', { execution: 'optional' })]);
      await browser.waitForMode('completed');
      expect(await browser.stepAttribute(1, 'data-status')).toBe('passed');
      await browser.toPage();
      expect(await browser.cssAll('#banner')).toHaveLength(0);
    });

    it('never runs a skip step', async () => {
      await runToCompletion([go('/form.html'), newStep({ type: 'check', checked: true }, { target: target('#agree', 'input'), execution: 'skip' })]);
      expect(await (await browser.css('#agree')).isSelected()).toBe(false);
    });

    it('changes execution type from the inspector', async () => {
      await open([go('/form.html'), clickOn('#never', { wait: { timeoutMs: 300 } })]);
      await (await browser.stepRows())[1]!.findElement({ css: '[data-testid="step-open"]' }).click();
      await (await browser.css('[data-testid="inspector"] [data-value="optional"]')).click();
      await browser.driver.wait(async () => (await browser.stepAttribute(1, 'data-execution')) === 'optional', 5000);
      await browser.play();
      await browser.waitForMode('completed');
      expect(await browser.stepAttribute(1, 'data-status')).toBe('skipped');
    });
  });

  describe('failures', () => {
    const missing = (): ElementTarget => ({
      selectors: [
        { kind: 'testId', attr: 'data-testid', value: 'missing' },
        { kind: 'id', value: 'missing-too' },
        { kind: 'css', value: '#nope > .nothing' },
      ],
      fingerprint: { tag: 'button' },
      summary: 'button "Ghost"',
    });

    it('stops and reports what was tried', async () => {
      await run([go('/form.html'), newStep({ type: 'click' }, { target: missing(), wait: { timeoutMs: 400 } }), clickOn('#load-later')]);
      await browser.waitForMode('failed');
      const panel = await browser.waitForTestId('failure');
      expect(await panel.getAttribute('data-code')).toBe('element-not-found');
      const text = await panel.getText();
      expect(text).toContain('Step 2 failed');
      expect(text).toContain('button "Ghost"');
      expect(text).toContain('Selectors tried (3)');
      expect(await browser.stepAttribute(1, 'data-status')).toBe('failed');
      expect(await browser.stepAttribute(2, 'data-status')).toBe('pending');
      await (await panel.findElement({ css: 'summary' })).click();
      await browser.screenshot('failure');
      const attempts = await panel.getText();
      expect(attempts).toContain('testId');
      expect(attempts).toContain('no match');
    });

    it('retries after the page catches up', async () => {
      await run([go('/form.html'), clickOn('#late-button', { wait: { timeoutMs: 300 } })]);
      await browser.waitForMode('failed');
      await browser.toPage();
      await (await browser.css('#load-later')).click();
      await browser.css('#late-button');
      await browser.toSidebar();
      await browser.clickTestId('retry');
      await browser.waitForMode('completed');
    });

    it('continues past a failed step on request', async () => {
      await run([go('/form.html'), clickOn('#never', { wait: { timeoutMs: 300 } }), clickOn('#load-later')]);
      await browser.waitForMode('failed');
      await browser.clickTestId('skip-failed');
      await browser.waitForMode('completed');
      expect(await browser.stepAttribute(1, 'data-status')).toBe('skipped');
      expect(await browser.stepAttribute(2, 'data-status')).toBe('passed');
    });

    it('accepts a selector fix while failed, then retries', async () => {
      await run([go('/form.html'), clickOn('#wrong-id', { wait: { timeoutMs: 300 } })]);
      await browser.waitForMode('failed');
      await (await browser.stepRows())[1]!.findElement({ css: '[data-testid="step-open"]' }).click();
      await (await browser.css('details.selectors summary')).click();
      const input = await browser.css('[data-kind="css"] input.input');
      await input.clear();
      await input.sendKeys('#load-later');
      // Straight to Retry, with no pause: leaving the field is what saves it.
      await browser.clickTestId('retry');
      await browser.waitForMode('completed');
    });

    it('links a log entry to its step', async () => {
      await run([go('/form.html'), clickOn('#never', { wait: { timeoutMs: 300 } })]);
      await browser.waitForMode('failed');
      await browser.clickTestId('tab-log');
      const failed = await browser.css('[data-testid="log-row"][data-event="failed"]');
      expect(await failed.getText()).toContain("Couldn't find");
      await (await failed.findElement({ css: '.log-step' })).click();
      await browser.waitForTestId('inspector');
    });

    it('explains a navigation failure', async () => {
      await run([newStep({ type: 'navigate', url: 'http://localhost:1/nothing' })]);
      await browser.waitForMode('failed');
      expect(await browser.text('[data-testid="failure"]')).toContain('Check that the server is running');
    });
  });

  describe('selector resolution', () => {
    /** Records against the real page, so that the selectors are real. */
    async function captured(): Promise<{ name: ElementTarget; submit: ElementTarget }> {
      await browser.goto('/form.html');
      await browser.toSidebar();
      await browser.startRecording();
      await browser.toPage();
      await (await browser.css('#name')).sendKeys('Ada');
      await (await browser.css('#submit')).click();
      await browser.waitForText('#saved', 'Customer saved');
      const recording = await browser.stopRecording();
      await browser.clickTestId('back');
      await browser.clearRecordings();
      return { name: recording.steps[1]!.target!, submit: recording.steps[2]!.target! };
    }

    it('survives renamed IDs and test IDs by falling back', async () => {
      const { name, submit } = await captured();
      await run([
        go('/form.html?variant=renamed'),
        newStep({ type: 'input', value: 'Fallback' }, { target: name }),
        newStep({ type: 'click' }, { target: submit }),
        newStep({ type: 'urlChange', match: { mode: 'contains', value: '/next.html' } }),
      ]);
      await browser.waitForMode('completed');
      await browser.toPage();
      await browser.waitForText('#query', /customer_name=Fallback/);
    });

    it('fails instead of clicking something else when the element is gone', async () => {
      const { submit } = await captured();
      await run([go('/form.html?variant=gone'), newStep({ type: 'click' }, { target: submit, wait: { timeoutMs: 500 } })]);
      await browser.waitForMode('failed');
      await browser.toPage();
      expect(await browser.driver.getCurrentUrl()).toContain('form.html');
    });

    it('refuses to act on an ambiguous match', async () => {
      const ambiguous: ElementTarget = {
        selectors: [{ kind: 'css', value: 'section button' }],
        fingerprint: { tag: 'button' },
        summary: 'some button',
      };
      await run([go('/form.html'), newStep({ type: 'click' }, { target: ambiguous, wait: { timeoutMs: 300 } })]);
      await browser.waitForMode('failed');
      const panel = await browser.waitForTestId('failure');
      expect(await panel.getAttribute('data-code')).toBe('element-ambiguous');
    });

    it('tests selectors against the live page from the inspector', async () => {
      const { submit } = await captured();
      await browser.goto('/form.html');
      await open([newStep({ type: 'click' }, { target: submit })]);
      await (await browser.stepRows())[0]!.findElement({ css: '[data-testid="step-open"]' }).click();
      await (await browser.css('details.selectors summary')).click();
      await browser.clickTestId('test-selectors');
      await browser.waitForText('[data-kind="testId"] .selector-result', 'matched');
    });

    it('highlights the element in the page', async () => {
      const { submit } = await captured();
      await browser.goto('/form.html');
      await open([newStep({ type: 'click' }, { target: submit })]);
      await (await browser.stepRows())[0]!.findElement({ css: '[data-testid="step-open"]' }).click();
      await browser.clickTestId('highlight');
      await browser.driver.wait(async () => (await (await browser.waitForTestId('highlight')).getAttribute('aria-pressed')) === 'true', 5000);
      await browser.toPage();
      expect(await browser.driver.executeScript(() => document.querySelector('[data-dejavu-overlay]') !== null)).toBe(true);
    });
  });

  describe('assertions', () => {
    const passing = (): Step[] => [
      go('/form.html'),
      fill('#name', 'Ada'),
      newStep({ type: 'check', checked: true }, { target: target('#agree', 'input') }),
      assertStep({ kind: 'exists' }, '#title', 'h1'),
      assertStep({ kind: 'visible' }, '#title', 'h1'),
      assertStep({ kind: 'notExists' }, '#never'),
      assertStep({ kind: 'text', match: { mode: 'contains', value: 'customer' } }, '#title', 'h1'),
      assertStep({ kind: 'text', match: { mode: 'contains', value: 'Double-click' } }),
      assertStep({ kind: 'value', match: { mode: 'exact', value: 'Ada' } }, '#name', 'input'),
      assertStep({ kind: 'checked' }, '#agree', 'input'),
      assertStep({ kind: 'unchecked' }, '#contact-mail', 'input'),
      assertStep({ kind: 'url', match: { mode: 'contains', value: '/form.html' } }),
      assertStep({ kind: 'title', match: { mode: 'exact', value: 'Fixture form' } }),
      assertStep({ kind: 'count', expected: 2, selector: 'iframe' }),
    ];

    it('passes when the page matches', async () => {
      await run(passing());
      await browser.waitForMode('completed');
    });

    it('fails a required assertion with expected and actual', async () => {
      await run([go('/form.html'), fill('#name', 'Ada'), assertStep({ kind: 'value', match: { mode: 'exact', value: 'Grace' } }, '#name', 'input')]);
      await browser.waitForMode('failed');
      const text = await browser.text('[data-testid="failure"]');
      expect(text).toContain('expected value equal to "Grace"');
      expect(text).toContain('Ada');
    });

    it('lets an optional assertion fail quietly', async () => {
      await run([go('/form.html'), assertStep({ kind: 'visible' }, '#never', 'div', { execution: 'optional' }), clickOn('#load-later')]);
      await browser.waitForMode('completed');
      expect(await browser.stepAttribute(1, 'data-status')).toBe('skipped');
    });
  });

  describe('steps that need a person', () => {
    it('pauses for a password, then continues', async () => {
      await open([go('/form.html'), newStep({ type: 'input', value: '', redacted: true }, { target: target('#password', 'input') }), clickOn('#load-later')]);
      await browser.play();
      await browser.waitForMode('paused');
      expect(await browser.text('[data-testid="manual-banner"]')).toContain("wasn't recorded");
      await browser.clickTestId('play');
      await browser.waitForMode('completed');
    });
  });

  describe('advanced features', () => {
    it('substitutes variables, built-ins and asks for secrets', async () => {
      await open(
        [go('/form.html'), fill('#name', '{{prefix}}-{{$date}}'), fill('#password', '{{pw}}'), assertStep({ kind: 'value', match: { mode: 'contains', value: 'pre-20' } }, '#name', 'input')],
        { variables: [{ name: 'prefix', defaultValue: 'pre' }, { name: 'pw', defaultValue: '', secret: true }] },
      );
      await browser.play();
      await (await browser.css('.modal input')).sendKeys('s3cret');
      await browser.clickTestId('prompt-run');
      await browser.waitForMode('completed');
      await browser.toPage();
      expect(await (await browser.css('#password')).getAttribute('value')).toBe('s3cret');
      expect(JSON.stringify(await browser.recordings())).not.toContain('s3cret');
    });

    it('runs another recording as a reusable step', async () => {
      const shared = newRecording({ name: 'Shared login', steps: [go('/form.html'), fill('#name', 'From shared')] });
      await browser.seed(shared);
      await run([newStep({ type: 'runRecording', recordingId: shared.id }), assertStep({ kind: 'value', match: { mode: 'exact', value: 'From shared' } }, '#name', 'input')]);
      await browser.waitForMode('completed');
      expect(await browser.stepAttribute(0, 'data-status')).toBe('passed');
    });

    it('skips a step whose condition is not met', async () => {
      await run([
        go('/form.html'),
        clickOn('#accept-cookies', { condition: { kind: 'elementExists', selector: '#banner' } }),
        clickOn('#load-later', { condition: { kind: 'elementExists', selector: '#title' } }),
      ]);
      await browser.waitForMode('completed');
      expect(await browser.stepAttribute(1, 'data-status')).toBe('skipped');
      expect(await browser.stepAttribute(2, 'data-status')).toBe('passed');
    });

    it('collapses groups and opens them when playback reaches them', async () => {
      const groupId = 'grp_1';
      await open(
        [go('/form.html'), clickOn('#load-later', { groupId }), clickOn('#enable-it', { groupId, breakpoint: { enabled: true } })],
        { groups: [{ id: groupId, name: 'Inside', collapsed: true }] },
      );
      expect(await browser.stepRows()).toHaveLength(1);
      await browser.play();
      await browser.waitForMode('paused');
      expect(await browser.stepRows()).toHaveLength(3);
      await browser.clickTestId('stop');
      await browser.waitForMode('idle');
    });

    it('records a run in the log', async () => {
      await run([go('/form.html'), clickOn('#never', { execution: 'optional' }), clickOn('#load-later', { execution: 'skip' })]);
      await browser.waitForMode('completed');
      await browser.clickTestId('tab-log');
      await browser.driver.wait(async () => (await browser.cssAll('[data-testid="log-row"]')).length > 3, 5000);
      expect(await browser.cssAll('[data-testid="log-row"][data-event="started"]')).toHaveLength(2);
      expect(await browser.cssAll('[data-testid="log-row"][data-event="skipped"]')).toHaveLength(2);
      await browser.screenshot('log');
    });
  });
});
