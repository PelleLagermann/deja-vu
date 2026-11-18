export type CookieSameSite = 'no_restriction' | 'lax' | 'strict';

/**
 * Something done to the browser before the first step of a run. Unlike steps, these
 * act on the browser itself rather than on a page.
 */
export type SetupAction =
  | {
      type: 'setCookie';
      name: string;
      value: string;
      /** The site the cookie belongs to. Empty means the recording's starting URL. */
      url?: string;
      /** Empty gives a cookie for this host only. `.example.com` shares it with subdomains. */
      domain?: string;
      path?: string;
      secure?: boolean;
      httpOnly?: boolean;
      sameSite?: CookieSameSite;
      /** Days until it expires. Absent means a session cookie. */
      expiresInDays?: number;
    }
  /** Deletes every cookie with this name that the site receives, whatever its path. */
  | { type: 'deleteCookie'; name: string; url?: string }
  /** Deletes every cookie the site receives. */
  | { type: 'clearCookies'; url?: string };

export type SetupActionType = SetupAction['type'];

export interface SetupStep {
  id: string;
  /** Disabled setup steps stay in the recording but don't run. */
  enabled: boolean;
  action: SetupAction;
}
