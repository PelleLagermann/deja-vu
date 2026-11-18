import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Key, type WebElement } from 'selenium-webdriver';
import type { Recording } from '@shared/model/recording';
import type { Step } from '@shared/model/step';
import { newRecording, newStep } from '@shared/steps';
import { Browser, ORIGIN } from './harness';

function button(selector: string, partial: Partial<Step> = {}): Step {
  return newStep(
    { type: 'click' },
    { target: { selectors: [{ kind: 'css', value: selector }], fingerprint: { tag: 'button' }, summary: selector }, ...partial },
  );
}

describe('sidebar workflows', () => {
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

  async function menuItem(label: string): Promise<void> {
    await browser.css('.menu-item');
    for (const item of await browser.cssAll('.menu-item')) {
      if ((await item.getText()) === label) {
        await item.click();
        return;
      }
    }
    throw new Error(`No menu item ${label}`);
  }

  async function rowMenu(row: WebElement, label: string): Promise<void> {
    await browser.driver.actions().move({ origin: row }).perform();
    await (await row.findElement({ css: '.rec-actions button' })).click();
    await menuItem(label);
  }

  async function stored(id: string): Promise<Recording> {
    await browser.driver.sleep(150);
    const recording = (await browser.recordings()).find((item) => item.id === id);
    if (!recording) throw new Error('Recording not stored');
    return recording;
  }

  async function openStep(index: number): Promise<void> {
    await (await browser.stepRows())[index]!.findElement({ css: '[data-testid="step-open"]' }).click();
    await browser.waitForTestId('inspector');
  }

  async function seeded(steps: Step[], partial: Partial<Recording> = {}): Promise<Recording> {
    const recording = newRecording({ name: 'Seeded', steps, ...partial });
    await browser.seed(recording);
    await browser.openRecording('Seeded');
    return recording;
  }

  async function fieldValue(label: string, text: string): Promise<void> {
    const input = await browser.css(`[aria-label="${label}"]`);
    await input.clear();
    await input.sendKeys(text, Key.TAB);
  }

  describe('recording list', () => {
    it('shows a useful empty state', async () => {
      expect(await browser.text('.empty h3')).toBe('Nothing recorded yet');
      await browser.screenshot('empty');
    });

    it('shows metadata and finds recordings by name, description and tag', async () => {
      await browser.seed(newRecording({ name: 'Checkout flow', description: 'Buys a thing', tags: ['smoke'], steps: [button('#a'), button('#b')] }));
      await browser.seed(newRecording({ name: 'Signup', tags: ['auth'] }));

      const row = await browser.css('[data-testid="recording-row"]');
      await browser.driver.wait(async () => (await browser.cssAll('[data-testid="recording-row"]')).length === 2, 5000);
      const all = await Promise.all((await browser.cssAll('[data-testid="recording-row"]')).map((item) => item.getText()));
      expect(all.join('\n')).toContain('2 steps');
      expect(all.join('\n')).toContain('Buys a thing');
      expect(all.join('\n')).toContain('smoke');
      expect(row).toBeDefined();

      const search = await browser.css('input[type=search]');
      for (const [query, expected] of [['check', 1], ['buys', 1], ['auth', 1], ['nothing here', 0]] as const) {
        await search.clear();
        await search.sendKeys(query);
        await browser.driver.wait(async () => (await browser.cssAll('[data-testid="recording-row"]')).length === expected, 3000, query);
      }
    });

    it('creates an empty recording, then deletes it after confirming', async () => {
      await (await browser.css('[aria-label="More"]')).click();
      await menuItem('New empty recording');
      await browser.waitForTestId('transport');
      expect(await browser.text('.empty h3')).toBe('No steps yet');
      await browser.clickTestId('back');

      await rowMenu(await browser.css('[data-testid="recording-row"]'), 'Delete');
      await browser.waitForText('.modal-title', 'Delete recording?');
      await (await browser.css('.modal .btn-default')).click();
      expect(await browser.recordings()).toHaveLength(1);

      await rowMenu(await browser.css('[data-testid="recording-row"]'), 'Delete');
      await (await browser.css('.modal .btn-danger')).click();
      await browser.waitForText('.empty h3', 'Nothing recorded yet');
      expect(await browser.recordings()).toHaveLength(0);
    });

    it('renames and duplicates', async () => {
      await browser.seed(newRecording({ name: 'Original', steps: [button('#a')] }));
      await rowMenu(await browser.css('[data-testid="recording-row"]'), 'Duplicate');
      await browser.driver.wait(async () => (await browser.cssAll('[data-testid="recording-row"]')).length === 2, 5000);
      const names = (await browser.recordings()).map((recording) => recording.name).sort();
      expect(names).toEqual(['Original', 'Original (copy)']);

      const rows = await browser.cssAll('[data-testid="recording-row"]');
      await rowMenu(rows[0]!, 'Rename');
      const input = await browser.css('.modal input');
      await input.clear();
      await input.sendKeys('Renamed', Key.TAB);
      await browser.driver.sleep(150);
      expect((await browser.recordings()).map((recording) => recording.name)).toContain('Renamed');
    });
  });

  describe('collections', () => {
    it('groups recordings, and keeps them when deleted', async () => {
      await browser.seed(newRecording({ name: 'Member' }));
      await browser.clickTestId('nav-collections');
      await browser.clickTestId('new-collection');
      await (await browser.css('.modal input')).sendKeys('Regression', Key.ENTER);
      await browser.waitForText('.rec-name', 'Regression');

      await (await browser.css('.rec-row')).click();
      await (await browser.css('[aria-label="Add recording"]')).click();
      await menuItem('Member');
      await browser.waitForTestId('recording-row');
      expect((await browser.recordings())[0]!.collectionId).not.toBeNull();

      await (await browser.css('[aria-label="Collection actions"]')).click();
      await menuItem('Delete collection');
      await (await browser.css('.modal .btn-danger')).click();
      await browser.waitForText('.empty h3', 'No collections');
      const [member] = await browser.recordings();
      expect(member!.name).toBe('Member');
      expect(member!.collectionId).toBeNull();
    });
  });

  describe('editing steps', () => {
    it('saves a name, comment and value', async () => {
      const recording = await seeded([newStep({ type: 'input', value: 'old' })]);
      await openStep(0);
      await fieldValue('Step name', 'Enter the name');
      await fieldValue('Step comment', 'Explains why');
      await fieldValue('Value', 'new value');
      const [step] = (await stored(recording.id)).steps;
      expect(step).toMatchObject({ name: 'Enter the name', description: 'Explains why', action: { type: 'input', value: 'new value' } });
      expect(await (await browser.stepRows())[0]!.getText()).toContain('Enter the name');
    });

    it('edits the timeout', async () => {
      const recording = await seeded([button('#a')]);
      await openStep(0);
      await (await browser.css('.inspector-more summary')).click();
      await fieldValue('Timeout in milliseconds', '1234');
      expect((await stored(recording.id)).steps[0]!.wait.timeoutMs).toBe(1234);
    });

    it('edits a selector and adds another', async () => {
      const recording = await seeded([button('#a')]);
      await openStep(0);
      await (await browser.css('details.selectors summary')).click();
      await fieldValue('css value', '#b');
      expect((await stored(recording.id)).steps[0]!.target?.selectors[0]?.value).toBe('#b');
      await (await browser.css('[aria-label="Add selector"]')).click();
      await menuItem('XPath');
      await browser.css('[data-kind="xpath"]');
      await fieldValue('xpath value', '//button');
      expect((await stored(recording.id)).steps[0]!.target?.selectors.map((selector) => selector.kind)).toEqual(['css', 'xpath']);
    });

    it('reorders with the move buttons', async () => {
      const recording = await seeded([button('#a', { name: 'A' }), button('#b', { name: 'B' })]);
      await openStep(0);
      await (await browser.css('[aria-label="Move step down"]')).click();
      await browser.driver.wait(async () => (await stored(recording.id)).steps[0]!.name === 'B', 3000);
    });

    it('reorders by dragging', async () => {
      const recording = await seeded(['A', 'B', 'C'].map((name) => button(`#${name}`, { name })));
      await browser.driver.executeScript(() => {
        const rows = document.querySelectorAll('[data-testid="step-row"]');
        const source = rows[2]!;
        const target = rows[0]!;
        const rect = target.getBoundingClientRect();
        const init = { bubbles: true, cancelable: true, dataTransfer: new DataTransfer(), clientY: rect.top + 1 };
        source.dispatchEvent(new DragEvent('dragstart', init));
        target.dispatchEvent(new DragEvent('dragover', init));
      });
      await browser.driver.sleep(50);
      await browser.driver.executeScript(() => {
        const target = document.querySelectorAll('[data-testid="step-row"]')[0]!;
        target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
      });
      await browser.driver.wait(async () => (await stored(recording.id)).steps[0]!.name === 'C', 3000);
      expect((await stored(recording.id)).steps.map((step) => step.name)).toEqual(['C', 'A', 'B']);
    });

    it('duplicates and deletes a step, asking first', async () => {
      const recording = await seeded([button('#a', { name: 'A' })]);
      const row = (await browser.stepRows())[0]!;
      await browser.driver.actions().move({ origin: row }).perform();
      await (await row.findElement({ css: '.step-menu button' })).click();
      await menuItem('Duplicate');
      await browser.driver.wait(async () => (await browser.stepRows()).length === 2, 3000);
      const [first, second] = (await stored(recording.id)).steps;
      expect(first!.id).not.toBe(second!.id);

      const again = (await browser.stepRows())[1]!;
      await browser.driver.actions().move({ origin: again }).perform();
      await (await again.findElement({ css: '.step-menu button' })).click();
      await menuItem('Delete');
      await (await browser.css('.modal .btn-danger')).click();
      await browser.driver.wait(async () => (await browser.stepRows()).length === 1, 3000);
    });

    it('selects several steps and changes them at once', async () => {
      const recording = await seeded(['A', 'B', 'C'].map((name) => button(`#${name}`, { name })));
      const rows = await browser.stepRows();
      const open = async (index: number) => rows[index]!.findElement({ css: '[data-testid="step-open"]' });
      await browser.driver.actions().keyDown(Key.CONTROL).click(await open(0)).click(await open(1)).keyUp(Key.CONTROL).perform();
      await browser.waitForTestId('bulk-bar');
      await (await browser.css('[aria-label="Set execution type"]')).click();
      await menuItem('Skip');
      await browser.driver.wait(async () => (await stored(recording.id)).steps[1]!.execution === 'skip', 3000);
      expect((await stored(recording.id)).steps.map((step) => step.execution)).toEqual(['skip', 'skip', 'required']);
    });

    it('groups selected steps, and collapses and renames the group', async () => {
      const recording = await seeded(['A', 'B', 'C'].map((name) => button(`#${name}`, { name })));
      const rows = await browser.stepRows();
      const open = async (index: number) => rows[index]!.findElement({ css: '[data-testid="step-open"]' });
      await browser.driver.actions().keyDown(Key.CONTROL).click(await open(0)).click(await open(1)).keyUp(Key.CONTROL).perform();
      await browser.clickTestId('group-selection');
      await (await browser.css('.modal input')).sendKeys('Fill details', Key.ENTER);
      await browser.waitForTestId('group');

      const saved = await stored(recording.id);
      expect(saved.groups.map((group) => group.name)).toEqual(['Fill details']);
      expect(saved.steps.map((step) => Boolean(step.groupId))).toEqual([true, true, false]);

      await browser.clickTestId('group-toggle');
      await browser.driver.wait(async () => (await browser.stepRows()).length === 1, 3000);
      await browser.screenshot('groups');
      expect((await stored(recording.id)).groups[0]!.collapsed).toBe(true);

      await fieldValue('Group name', 'Details');
      expect((await stored(recording.id)).groups[0]!.name).toBe('Details');
    });

    it('builds an assertion by picking an element in the page', async () => {
      await browser.goto('/form.html');
      const recording = await seeded([newStep({ type: 'navigate', url: `${ORIGIN}/form.html` })]);
      await (await browser.css('[aria-label="Add step"]')).click();
      await menuItem('Assertion');
      await browser.driver.wait(async () => (await browser.stepRows()).length === 2, 3000);
      await browser.clickTestId('pick-element');
      await browser.driver.sleep(300);

      await browser.toPage();
      await (await browser.css('#title')).click();
      await browser.toSidebar();
      await browser.driver.wait(async () => (await stored(recording.id)).steps[1]!.target !== undefined, 5000);
      expect((await stored(recording.id)).steps[1]!.target?.fingerprint.id).toBe('title');

      await browser.play();
      await browser.waitForMode('completed');
    });

    it('keeps edits after reopening', async () => {
      const recording = await seeded([button('#a')]);
      await (await browser.css('[data-testid="gutter"]')).click();
      await browser.waitForTestId('breakpoint-line');
      await browser.reloadSidebar();
      await browser.openRecording('Seeded');
      await browser.waitForTestId('breakpoint-line');
      expect((await stored(recording.id)).steps[0]!.breakpoint?.enabled).toBe(true);
    });
  });

  describe('settings', () => {
    it('switches theme and persists it', async () => {
      await browser.clickTestId('nav-settings');
      await (await browser.css('[data-value="light"]')).click();
      await browser.driver.wait(async () => (await (await browser.css('html')).getAttribute('data-theme')) === 'light', 3000);
      await browser.screenshot('settings-light');
      await browser.reloadSidebar();
      await browser.driver.wait(async () => (await (await browser.css('html')).getAttribute('data-theme')) === 'light', 3000);
      await browser.clickTestId('nav-settings');
      await (await browser.css('[data-value="system"]')).click();
    });

    it('stops recording elements on the exclusion list', async () => {
      await browser.clickTestId('nav-settings');
      const box = await browser.css('.settings textarea[spellcheck]');
      expect(box).toBeDefined();
      const areas = await browser.cssAll('.settings textarea');
      await areas[1]!.sendKeys('#dynamic', Key.TAB);
      await browser.driver.sleep(200);
      await browser.clickTestId('nav-recordings');
      await browser.goto('/form.html');
      await browser.startRecording();
      await browser.toPage();
      await (await browser.css('#load-later')).click();
      await (await browser.css('#agree')).click();
      const recording = await browser.stopRecording();
      expect(recording.steps.map((step) => step.action.type)).toEqual(['navigate', 'check']);

      await browser.clickTestId('back');
      await browser.clickTestId('nav-settings');
      const again = await browser.cssAll('.settings textarea');
      await again[1]!.clear();
      await again[1]!.sendKeys(Key.TAB);
      await browser.driver.sleep(200);
      await browser.clickTestId('nav-recordings');
    });
  });
});
