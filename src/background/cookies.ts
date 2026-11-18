import type { SetupAction } from '@shared/model/setup';
import { errorMessage } from '@shared/util';
import { StepError } from '../playback-engine/engine';

const DAY_SECONDS = 86_400;

function siteHost(url: string): string {
  const parsed = URL.parse(url);
  if (!parsed || !/^https?:$/.test(parsed.protocol) || !parsed.hostname) {
    throw new StepError({
      code: 'invalid-step',
      message: `Setup needs a web address to work on, but got "${url}".`,
      hint: "Enter an http or https address under Site, or set the recording's starting URL in Details.",
    });
  }
  return parsed.hostname;
}

function requireName(name: string): string {
  if (!name.trim()) {
    throw new StepError({ code: 'invalid-step', message: 'This setup step has no cookie name.', hint: 'Enter the name of the cookie.' });
  }
  return name.trim();
}

/** Turns the browser's refusal into something the user can act on. */
function cookieError(action: string, error: unknown, url: string): StepError {
  if (error instanceof StepError) return error;
  const message = errorMessage(error);
  if (/permission/i.test(message)) {
    return new StepError({
      code: 'no-page-access',
      message: `Couldn't ${action}: Déjà Vu has no access to ${url}. (${message})`,
    });
  }
  return new StepError({
    code: 'action-failed',
    message: `Couldn't ${action}: ${message}`,
    hint: 'Secure cookies need an https site, and SameSite None needs Secure. A domain must be the site itself or one of its parents.',
  });
}

/** Whether a browser on `host` sends this cookie, on some path. */
function reaches(cookie: browser.cookies.Cookie, host: string): boolean {
  const domain = cookie.domain.replace(/^\./, '');
  return domain === host || (!cookie.hostOnly && host.endsWith(`.${domain}`));
}

/**
 * Every cookie the site receives, on any path. A cookie set for `.example.com` reaches
 * `app.example.com` too, so each parent domain is asked as well.
 */
async function cookiesFor(url: string, storeId: string | undefined, name?: string): Promise<browser.cookies.Cookie[]> {
  const host = siteHost(url);
  const labels = host.split('.');
  // Stops short of the top-level domain, which would list every cookie under it.
  const domains = labels.length === 1 ? [host] : labels.slice(0, -1).map((_, index) => labels.slice(index).join('.'));
  const lists = await Promise.all(
    domains.map((domain) => browser.cookies.getAll({ domain, ...(storeId ? { storeId } : {}), ...(name ? { name } : {}) })),
  );
  const unique = new Map<string, browser.cookies.Cookie>();
  for (const cookie of lists.flat()) {
    if (reaches(cookie, host)) unique.set(`${cookie.domain}|${cookie.path}|${cookie.name}|${cookie.firstPartyDomain}`, cookie);
  }
  return [...unique.values()];
}

async function removeCookie(cookie: browser.cookies.Cookie): Promise<void> {
  const host = cookie.domain.replace(/^\./, '');
  await browser.cookies.remove({
    url: `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path}`,
    name: cookie.name,
    storeId: cookie.storeId,
    ...(cookie.firstPartyDomain ? { firstPartyDomain: cookie.firstPartyDomain } : {}),
    ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}),
  });
}

/**
 * Carries out a setup action in the cookie store of the tab being played in, so that
 * containers and private windows get their own cookies, as the page would.
 */
export async function runCookieSetup(action: SetupAction, storeId: string | undefined): Promise<void> {
  const url = action.url ?? '';
  const store = storeId ? { storeId } : {};
  switch (action.type) {
    case 'setCookie': {
      const name = requireName(action.name);
      siteHost(url);
      try {
        await browser.cookies.set({
          url,
          name,
          value: action.value,
          path: action.path?.trim() || '/',
          ...store,
          ...(action.domain?.trim() ? { domain: action.domain.trim() } : {}),
          ...(action.secure !== undefined ? { secure: action.secure } : {}),
          ...(action.httpOnly !== undefined ? { httpOnly: action.httpOnly } : {}),
          ...(action.sameSite ? { sameSite: action.sameSite } : {}),
          ...(action.expiresInDays !== undefined
            ? { expirationDate: Math.floor(Date.now() / 1000) + action.expiresInDays * DAY_SECONDS }
            : {}),
        });
      } catch (error) {
        throw cookieError(`set the cookie ${name}`, error, url);
      }
      return;
    }
    case 'deleteCookie': {
      const name = requireName(action.name);
      try {
        for (const cookie of await cookiesFor(url, storeId, name)) await removeCookie(cookie);
      } catch (error) {
        throw cookieError(`delete the cookie ${name}`, error, url);
      }
      return;
    }
    case 'clearCookies': {
      try {
        for (const cookie of await cookiesFor(url, storeId)) await removeCookie(cookie);
      } catch (error) {
        throw cookieError('delete the cookies', error, url);
      }
      return;
    }
  }
}
