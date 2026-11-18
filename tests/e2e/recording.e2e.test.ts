import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Key, Origin, until } from 'selenium-webdriver';
import type { Step } from '@shared/model/step';
import { Browser } from './harness';

/**
 * Real user input, through WebDriver, into the real extension. Input events from
 * WebDriver are trusted, so the recorder treats them exactly like a person's.
 */
describe('recording in Firefox', () => {
  let browser: Browser;

  const actionsOf = (steps: Step[]) => steps.map((step) => step.action.type);

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
    await browser.goto('/form.html');
    await browser.toSidebar();
  });

  /** Runs `act` on the page during a recording and returns the steps, without the initial navigate. */
  async function record(act: () => Promise<void>): Promise<Step[]> {
    await browser.startRecording();
    await browser.toPage();
    await act();
    const recording = await browser.stopRecording();
    await (await browser.waitForTestId('back')).click();
    expect(recording.steps[0]?.action.type).toBe('navigate');
    return recording.steps.slice(1);
  }

  const click = async (selector: string) => (await browser.css(selector)).click();
  /** WebDriver actions don't scroll by themselves, unlike clicks on an element. */
  const inView = async (selector: string) => {
    const element = await browser.css(selector);
    await browser.driver.executeScript('arguments[0].scrollIntoView({ block: "center", behavior: "instant" })', element);
    return element;
  };
  const type = async (selector: string, text: string) => (await browser.css(selector)).sendKeys(text);

  it('records a click with several selector strategies', async () => {
    const steps = await record(() => click('#submit'));
    const step = steps[0]!;
    expect(step.action.type).toBe('click');
    expect(step.target?.summary).toBe('button "Save customer"');
    const kinds = step.target?.selectors.map((selector) => selector.kind);
    expect(kinds).toEqual(expect.arrayContaining(['testId', 'id', 'role', 'text', 'css', 'xpath', 'context']));
  });

  it('turns typing into one input step', async () => {
    const steps = await record(async () => {
      await type('#name', 'Ada Lovelace');
      await click('#notes');
    });
    expect(steps[0]!.action).toEqual({ type: 'input', value: 'Ada Lovelace' });
    expect(steps.filter((step) => step.action.type === 'input')).toHaveLength(1);
  });

  it('records checkboxes, radios and labels without duplicates', async () => {
    const steps = await record(async () => {
      await click('#agree');
      await click('#contact-phone');
      await click('#agree');
    });
    expect(steps.map((step) => step.action)).toEqual([
      { type: 'check', checked: true },
      { type: 'check', checked: true },
      { type: 'check', checked: false },
    ]);
  });

  it('records a select', async () => {
    const steps = await record(async () => {
      await type('#plan', 'Professional');
      await click('#notes');
    });
    const select = steps.find((step) => step.action.type === 'select');
    expect(select?.action).toEqual({ type: 'select', values: ['pro'], labels: ['Professional'] });
  });

  it('records a slider moved by keyboard as one step with the final value', async () => {
    const steps = await record(async () => {
      await (await browser.css('#seats')).sendKeys(Key.ARROW_RIGHT, Key.ARROW_RIGHT);
      await browser.driver.sleep(100);
    });
    expect(steps.map((step) => step.action)).toEqual([{ type: 'input', value: '3' }]);
  });

  it('records a date field', async () => {
    const steps = await record(async () => {
      await (await browser.css('#date')).sendKeys('2026-11-06');
      await click('#notes');
    });
    expect(steps.find((step) => step.action.type === 'input')?.action).toEqual({ type: 'input', value: '2026-11-06' });
  });

  it('records Space on a checkbox only as the change', async () => {
    const steps = await record(async () => {
      await (await browser.css('#agree')).sendKeys(Key.SPACE);
      await browser.driver.sleep(100);
    });
    expect(steps.map((step) => step.action)).toEqual([{ type: 'check', checked: true }]);
  });

  it('records a page load caused by a click as a wait, not a navigation', async () => {
    const steps = await record(async () => {
      await click('#submit');
      await browser.waitForText('#saved', 'Customer saved');
    });
    expect(actionsOf(steps)).toEqual(['click', 'urlChange']);
    expect(steps[1]!.action).toMatchObject({ type: 'urlChange', match: { value: '/next.html' } });
  });

  it('keeps recording on the new page after a navigation', async () => {
    const steps = await record(async () => {
      await click('#submit');
      await browser.waitForText('#saved', 'Customer saved');
      await click('#back-link');
      await browser.css('#customer-form');
      await type('#name', 'Grace');
      await click('#notes');
    });
    expect(actionsOf(steps).slice(0, 4)).toEqual(['click', 'urlChange', 'click', 'urlChange']);
    expect(steps.some((step) => step.action.type === 'input')).toBe(true);
  });

  it('records a navigation nothing on the page caused as explicit', async () => {
    await browser.startRecording();
    await new Promise((resolve) => setTimeout(resolve, 5_200));
    await browser.goto('/next.html');
    await browser.css('#saved');
    const recording = await browser.stopRecording();
    expect(recording.steps[1]?.action).toMatchObject({ type: 'navigate', url: expect.stringContaining('/next.html') });
  });

  it('records history.pushState navigation', async () => {
    const steps = await record(async () => {
      await click('#spa-link');
      await browser.waitForText('#route', 'details route');
    });
    expect(actionsOf(steps)).toEqual(['click', 'urlChange']);
    expect(steps[1]!.action).toMatchObject({ match: { value: '/spa/details' } });
  });

  it('records a hash change', async () => {
    const steps = await record(async () => {
      await click('#hash-link');
      await browser.driver.sleep(200);
    });
    expect(steps.at(-1)!.action).toMatchObject({ type: 'urlChange', match: { value: expect.stringContaining('#section-two') } });
  });

  it('records a double-click as one step', async () => {
    const steps = await record(async () => {
      await browser.driver.actions().doubleClick(await inView('#dblclick-target')).perform();
      await browser.waitForText('#dblclick-result', 'double');
    });
    expect(actionsOf(steps)).toEqual(['doubleClick']);
  });

  it('records a right-click', async () => {
    const steps = await record(async () => {
      await browser.driver.actions().contextClick(await inView('#context-target')).perform();
      await browser.waitForText('#context-result', 'context');
    });
    expect(actionsOf(steps)).toEqual(['contextMenu']);
  });

  it('records keyboard shortcuts and special keys', async () => {
    const steps = await record(async () => {
      await (await browser.css('#key-target')).sendKeys(Key.chord(Key.CONTROL, 'k'));
      await browser.waitForText('#key-result', 'shortcut fired');
      await (await browser.css('#key-target')).sendKeys(Key.ARROW_DOWN, Key.ESCAPE);
    });
    const keys = steps.filter((step) => step.action.type === 'keyPress').map((step) => (step.action as { key: string }).key);
    expect(keys).toEqual(expect.arrayContaining(['k', 'ArrowDown', 'Escape']));
  });

  it('records Enter in a field as a key step after the value', async () => {
    const steps = await record(async () => {
      await type('#name', 'Ada');
      await type('#name', Key.ENTER);
      await browser.waitForText('#saved', 'Customer saved');
    });
    expect(actionsOf(steps).slice(0, 3)).toEqual(['input', 'keyPress', 'urlChange']);
  });

  it('records a mouse drag', async () => {
    const steps = await record(async () => {
      const handle = await inView('#slider-handle');
      await browser.driver.actions().move({ origin: handle }).press().move({ origin: handle, x: 180, y: 0, duration: 100 }).release().perform();
      await browser.waitForText('#slider-result', 'moved far');
    });
    expect(actionsOf(steps)).toEqual(['dragDrop']);
    expect(steps[0]!.action).toMatchObject({ mode: 'pointer' });
  });

  it('records scrolling once, as optional', async () => {
    const steps = await record(async () => {
      // The published types don't include the wheel action yet.
      type WheelActions = { scroll(x: number, y: number, dx: number, dy: number, origin: string): { perform(): Promise<void> } };
      const wheel = () => browser.driver.actions() as unknown as WheelActions;
      await wheel().scroll(10, 10, 0, 600, Origin.VIEWPORT).perform();
      await wheel().scroll(10, 10, 0, 300, Origin.VIEWPORT).perform();
      await browser.driver.sleep(500);
    });
    expect(actionsOf(steps)).toEqual(['scroll']);
    expect(steps[0]!.execution).toBe('optional');
    expect((steps[0]!.action as { y: number }).y).toBeGreaterThan(100);
  });

  it('records inside an open shadow root', async () => {
    const steps = await record(async () => {
      const host = await browser.css('#open-host');
      const root = await host.getShadowRoot();
      await (await root.findElement({ css: '#open-inner' })).click();
      await browser.waitForText('#shadow-result', 'open clicked');
    });
    expect(steps[0]!.target?.fingerprint.testId).toBe('open-inner');
  });

  it('records inside a closed shadow root', async () => {
    const steps = await record(async () => {
      await browser.driver.actions().move({ origin: await inView('#closed-host') }).click().perform();
      await browser.waitForText('#shadow-result', 'closed clicked');
    });
    expect(steps[0]!.target?.fingerprint.id).toBe('closed-inner');
  });

  it('records inside a same-origin iframe, with its location', async () => {
    const steps = await record(async () => {
      await browser.driver.switchTo().frame(await browser.css('#same-frame'));
      await type('#frame-input', 'in the frame');
      await click('#frame-button');
      await browser.waitForText('#frame-result', 'frame got in the frame');
      await browser.driver.switchTo().defaultContent();
    });
    expect(actionsOf(steps)).toEqual(['input', 'click']);
    expect(steps[0]!.target?.frames).toEqual([{ url: expect.stringContaining('/frame.html'), index: 0 }]);
  });

  it('records inside a cross-origin iframe', async () => {
    const steps = await record(async () => {
      await browser.driver.switchTo().frame(await browser.css('#cross-frame'));
      await click('#frame-button');
      await browser.driver.switchTo().defaultContent();
    });
    expect(steps[0]!.target?.frames?.[0]?.url).toContain('127.0.0.1');
  });

  it('records the answer to a native confirm', async () => {
    const steps = await record(async () => {
      await click('#confirm-button');
      await browser.driver.wait(until.alertIsPresent(), 5000);
      await browser.driver.switchTo().alert().dismiss();
      await browser.waitForText('#dialog-result', 'declined');
    });
    expect(actionsOf(steps)).toEqual(['click', 'dialog']);
    expect(steps[1]!.action).toMatchObject({ kind: 'confirm', accept: false, message: 'Really delete?' });
  });

  it('records the answer to a native prompt', async () => {
    const steps = await record(async () => {
      await click('#prompt-button');
      await browser.driver.wait(until.alertIsPresent(), 5000);
      const alert = browser.driver.switchTo().alert();
      await alert.sendKeys('Hopper');
      await alert.accept();
      await browser.waitForText('#dialog-result', 'renamed to Hopper');
    });
    expect(steps[1]!.action).toMatchObject({ kind: 'prompt', accept: true, promptText: 'Hopper' });
  });

  it('records steps on dynamically added elements', async () => {
    const steps = await record(async () => {
      await click('#load-later');
      await click('#late-button');
      await browser.waitForText('#click-result', 'late clicked');
    });
    expect(steps[1]!.target?.fingerprint.id).toBe('late-button');
  });

  it('never stores what was typed into a password field', async () => {
    const secret = 'correct-horse-battery-staple';
    const steps = await record(async () => {
      await type('#password', secret);
      await click('#notes');
    });
    expect(steps[0]!.action).toEqual({ type: 'input', value: '', redacted: true });
    expect(JSON.stringify(await browser.recordings())).not.toContain(secret);
  });

  it('shows a notice in the page and the sidebar that values are being captured', async () => {
    await browser.startRecording();
    await browser.waitForTestId('recording-banner');
    expect(await (await browser.waitForTestId('recording-banner')).getText()).toContain('being stored');
    await browser.toPage();
    const hasOverlay = await browser.driver.executeScript<boolean>(() => document.querySelector('[data-dejavu-overlay]') !== null);
    expect(hasOverlay).toBe(true);
    await browser.stopRecording();
    await browser.toPage();
    const stillThere = await browser.driver.executeScript<boolean>(() => document.querySelector('[data-dejavu-overlay]') !== null);
    expect(stillThere).toBe(false);
  });

  it('appends to an existing recording', async () => {
    const first = await record(() => click('#agree'));
    expect(first).toHaveLength(1);
    await (await browser.css('[data-testid="recording-row"]')).click();
    await browser.clickTestId('record-more');
    await browser.waitForMode('recording');
    await browser.toPage();
    await click('#contact-mail');
    const recording = await browser.stopRecording();
    expect(actionsOf(recording.steps)).toEqual(['navigate', 'check', 'check']);
  });
});
