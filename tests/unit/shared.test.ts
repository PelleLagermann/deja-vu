import { describe, expect, it } from 'vitest';
import type { Recording } from '@shared/model/recording';
import { changeSetupType, newSetupStep, setupTitle, setupUrl, setupUrls } from '@shared/setup';
import { newRecording, newStep, stepTitle } from '@shared/steps';
import { matchesText, originPattern, redactUrl, urlToMatch, isInjectableUrl } from '@shared/util';
import { builtinVariables, resolveSetupVariables, resolveStepVariables, substitute, variablesToPrompt } from '@shared/variables';
import { classifyNavigation } from '../../src/background/recording-session';

describe('urlToMatch', () => {
  const urlMatches = (recorded: string, actual: string) => matchesText(actual, urlToMatch(recorded));

  it('matches on the path, ignoring query strings', () => {
    expect(urlMatches('https://a.test/customers?page=2', 'https://a.test/customers?page=3')).toBe(true);
  });

  it('generalizes numeric IDs', () => {
    expect(urlMatches('https://a.test/orders/1042/edit', 'https://a.test/orders/9/edit')).toBe(true);
    expect(urlMatches('https://a.test/orders/1042/edit', 'https://a.test/orders/9/view')).toBe(false);
  });

  it('generalizes UUIDs', () => {
    const recorded = 'https://a.test/u/550e8400-e29b-41d4-a716-446655440000';
    expect(urlMatches(recorded, 'https://a.test/u/123e4567-e89b-12d3-a456-426614174000')).toBe(true);
  });

  it('includes the hash, for hash-routed apps', () => {
    expect(urlMatches('https://a.test/#/settings', 'https://a.test/#/settings')).toBe(true);
    expect(urlMatches('https://a.test/#/settings', 'https://a.test/#/home')).toBe(false);
  });
});

describe('redactUrl', () => {
  it('hides credentials, and leaves other parameters', () => {
    const url = redactUrl('https://a.test/cb?token=abc&page=2&api_key=xyz');
    expect(url).not.toContain('abc');
    expect(url).not.toContain('xyz');
    expect(url).toContain('page=2');
  });

  it('does not mistake ordinary parameters for credentials', () => {
    const url = 'https://a.test/?zipcode=12345&passenger=2&authors=x';
    expect(redactUrl(url).includes('zipcode=12345')).toBe(true);
    expect(redactUrl(url).includes('passenger=2')).toBe(true);
  });

  it('leaves clean URLs exactly as they were', () => {
    expect(redactUrl('https://a.test/a?b=c#d')).toBe('https://a.test/a?b=c#d');
  });
});

describe('access helpers', () => {
  it('builds origin patterns', () => {
    expect(originPattern('http://localhost:3000/x')).toBe('*://localhost/*');
    expect(originPattern('file:///c:/a.html')).toBe('file:///*');
    expect(originPattern('about:blank')).toBeNull();
  });

  it('knows which pages can be scripted', () => {
    expect(isInjectableUrl('https://example.test/')).toBe(true);
    expect(isInjectableUrl('about:debugging')).toBe(false);
    expect(isInjectableUrl('moz-extension://x/y')).toBe(false);
    expect(isInjectableUrl('https://addons.mozilla.org/')).toBe(false);
  });
});

describe('classifyNavigation', () => {
  const state = { history: ['https://a.test/1', 'https://a.test/2'], historyIndex: 1, lastInteractionAt: 1000 };
  const nav = (url: string, transitionType: string, transitionQualifiers: string[] = []) => ({ url, transitionType, transitionQualifiers });

  it('treats typed URLs as explicit navigation', () => {
    expect(classifyNavigation(nav('https://a.test/x', 'typed'), state, 1500)).toEqual({ type: 'navigate', url: 'https://a.test/x' });
  });

  it('treats address-bar navigation as explicit, whatever its type', () => {
    expect(classifyNavigation(nav('https://a.test/x', 'link', ['from_address_bar']), state, 1500)?.type).toBe('navigate');
  });

  it('turns navigation caused by a recent step into a wait', () => {
    expect(classifyNavigation(nav('https://a.test/x', 'link'), state, 1500)?.type).toBe('urlChange');
    expect(classifyNavigation(nav('https://a.test/x', 'form_submit'), state, 1500)?.type).toBe('urlChange');
  });

  it('treats navigation with no recent step as explicit', () => {
    expect(classifyNavigation(nav('https://a.test/x', 'link'), state, 60_000)?.type).toBe('navigate');
  });

  it('turns redirects into waits, however old the last step is', () => {
    expect(classifyNavigation(nav('https://a.test/x', 'link', ['client_redirect']), state, 60_000)?.type).toBe('urlChange');
  });

  it('recognizes reload', () => {
    expect(classifyNavigation(nav('https://a.test/2', 'reload'), state, 1500)).toEqual({ type: 'reload' });
  });

  it('works out the direction of back and forward', () => {
    expect(classifyNavigation(nav('https://a.test/1', 'link', ['forward_back']), state, 1500)).toEqual({ type: 'history', direction: 'back' });
    expect(
      classifyNavigation(nav('https://a.test/2', 'link', ['forward_back']), { ...state, historyIndex: 0 }, 1500),
    ).toEqual({ type: 'history', direction: 'forward' });
  });

  it('ignores a repeat of the current URL', () => {
    expect(classifyNavigation(nav('https://a.test/2', 'link'), state, 1500)).toBeNull();
  });
});

describe('variables', () => {
  it('replaces known names and leaves unknown ones visible', () => {
    expect(substitute('{{a}}-{{ b }}-{{c}}', { a: '1', b: '2' })).toBe('1-2-{{c}}');
  });

  it('has built-ins that hold still during a run', () => {
    const values = builtinVariables(0);
    expect(values['$date']).toBe('1970-01-01');
    expect(values['$timestamp']).toBe('0');
    expect(substitute('{{$timestamp}}{{$timestamp}}', values)).toBe('00');
  });

  it('reaches into assertions and URLs', () => {
    const assertion = newStep({ type: 'assert', assertion: { kind: 'text', match: { mode: 'contains', value: 'Hi {{name}}' } } });
    expect(resolveStepVariables(assertion, { name: 'Ada' }).action).toMatchObject({ assertion: { match: { value: 'Hi Ada' } } });
    const navigate = newStep({ type: 'navigate', url: '{{base}}/x' });
    expect(resolveStepVariables(navigate, { base: 'https://a.test' }).action).toEqual({ type: 'navigate', url: 'https://a.test/x' });
  });

  it('prompts for secrets and undefined names, not for defaults and built-ins', () => {
    const recording: Recording = newRecording({
      variables: [
        { name: 'known', defaultValue: 'x' },
        { name: 'pw', defaultValue: '', secret: true },
      ],
      steps: [newStep({ type: 'input', value: '{{known}} {{pw}} {{missing}} {{$uuid}}' })],
    });
    expect(variablesToPrompt(recording).map((field) => field.name)).toEqual(['pw', 'missing']);
  });

  it('asks for names used in enabled setup steps, but not disabled ones', () => {
    const recording = newRecording({
      setup: [
        newSetupStep({ type: 'setCookie', name: 'token', value: '{{token}}', url: '{{site}}/' }),
        { ...newSetupStep({ type: 'deleteCookie', name: '{{unused}}' }), enabled: false },
      ],
    });
    expect(variablesToPrompt(recording).map((field) => field.name)).toEqual(['token', 'site']);
  });

  it('resolves every text field of a setup action', () => {
    const action = resolveSetupVariables(
      { type: 'setCookie', name: 'n-{{a}}', value: 'v-{{a}}', url: 'https://{{a}}.test/', domain: '.{{a}}.test', path: '/{{a}}' },
      { a: 'x' },
    );
    expect(action).toEqual({ type: 'setCookie', name: 'n-x', value: 'v-x', url: 'https://x.test/', domain: '.x.test', path: '/x' });
  });
});

describe('setup helpers', () => {
  it('falls back to the starting URL for the site', () => {
    expect(setupUrl({ type: 'clearCookies' }, 'https://start.test/a')).toBe('https://start.test/a');
    expect(setupUrl({ type: 'clearCookies', url: ' https://other.test ' }, 'https://start.test/a')).toBe('https://other.test');
  });

  it('asks for access to a shared cookie domain as well as the site', () => {
    const urls = setupUrls({ type: 'setCookie', name: 'a', value: '', domain: '.example.test' }, 'https://app.example.test/');
    expect(urls).toEqual(['https://app.example.test/', 'https://example.test/']);
  });

  it('keeps name and site when the kind of action changes', () => {
    const changed = changeSetupType({ type: 'setCookie', name: 'a', value: 'b', url: 'https://x.test' }, 'deleteCookie');
    expect(changed).toEqual({ type: 'deleteCookie', name: 'a', url: 'https://x.test' });
    expect(changeSetupType(changed, 'clearCookies')).toEqual({ type: 'clearCookies', url: 'https://x.test' });
  });

  it('titles setup steps', () => {
    expect(setupTitle({ type: 'setCookie', name: 'consent', value: '1' })).toBe('Set cookie consent');
    expect(setupTitle({ type: 'clearCookies' })).toBe('Delete all cookies');
  });
});

describe('stepTitle', () => {
  it('prefers the given name', () => {
    expect(stepTitle(newStep({ type: 'reload' }, { name: 'Refresh' }))).toBe('Refresh');
  });

  it('builds a readable default', () => {
    const step = newStep({ type: 'check', checked: false }, {
      target: { selectors: [], fingerprint: { tag: 'input' }, summary: 'checkbox "Agree"' },
    });
    expect(stepTitle(step)).toBe('Uncheck "Agree"');
  });
});
