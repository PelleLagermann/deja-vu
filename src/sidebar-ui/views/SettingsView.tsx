import { useEffect, useState } from 'react';
import type { Settings } from '@shared/model/recording';
import { useApp } from '../App';
import { requestAccess, requestOrigins, send, storage } from '../api';
import { Button, CommitInput, Field, NumberInput, Segmented, Toggle, useToast } from '../components/ui';
import type { ElementTarget } from '@shared/model/selector';

const ALL_SITES = ['*://*/*'];

function linesToList(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter(Boolean);
}

function SiteAccess() {
  const toast = useToast();
  const [origins, setOrigins] = useState<string[] | null>(null);

  useEffect(() => {
    const refresh = () => void browser.permissions.getAll().then((all) => setOrigins(all.origins ?? []));
    refresh();
    browser.permissions.onAdded.addListener(refresh);
    browser.permissions.onRemoved.addListener(refresh);
    return () => {
      browser.permissions.onAdded.removeListener(refresh);
      browser.permissions.onRemoved.removeListener(refresh);
    };
  }, []);

  const allSites = origins?.includes('*://*/*') ?? false;
  return (
    <>
      <div className="field-hint" data-testid="site-access-summary">
        {allSites
          ? 'Déjà Vu can run on all websites during a session.'
          : origins?.length
            ? `Allowed on: ${origins.join(', ')}`
            : 'No sites allowed yet. You get asked when you first record or play on a site.'}
      </div>
      <div className="settings-actions">
        {!allSites && (
          <Button
            data-testid="grant-all-sites"
            onClick={() => {
              requestOrigins(ALL_SITES).catch(toast.error);
            }}
          >
            Allow all sites
          </Button>
        )}
        {origins && origins.length > 0 && (
          <Button onClick={() => void browser.permissions.remove({ origins }).catch(toast.error)}>Revoke access</Button>
        )}
      </div>
    </>
  );
}

export function SettingsView() {
  const { settings, targetUrl } = useApp();
  const toast = useToast();

  const patch = (change: Partial<Settings>) => {
    storage.saveSettings({ ...settings, ...change }).catch(toast.error);
  };

  const pickExclusion = () => {
    requestAccess([targetUrl])
      .then(() => send<ElementTarget | null>({ type: 'inspect/pick' }))
      .then((target) => {
        const css = target?.selectors.find((selector) => selector.kind === 'css')?.value;
        if (css) patch({ excludedSelectors: [...settings.excludedSelectors, css] });
      })
      .catch(toast.error);
  };

  return (
    <div className="view">
      <div className="view-scroll">
        <div className="section-title">Appearance</div>
        <div className="settings">
          <Field label="Theme">
            <Segmented
              label="Theme"
              value={settings.theme}
              onChange={(theme) => patch({ theme })}
              options={[
                { value: 'system', label: 'System' },
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
              ]}
            />
          </Field>
        </div>

        <div className="section-title">Playback</div>
        <div className="settings">
          <div className="field-row">
            <Field label="Timeout (ms)">
              <NumberInput
                label="Default timeout in milliseconds"
                value={settings.defaultTimeoutMs}
                onCommit={(value) => value && patch({ defaultTimeoutMs: value })}
              />
            </Field>
            <Field label="Optional timeout (ms)">
              <NumberInput
                label="Timeout for optional steps in milliseconds"
                value={settings.optionalTimeoutMs}
                onCommit={(value) => value && patch({ optionalTimeoutMs: value })}
              />
            </Field>
            <Field label="Step delay (ms)">
              <NumberInput
                label="Delay between steps in milliseconds"
                value={settings.stepDelayMs}
                onCommit={(value) => patch({ stepDelayMs: value ?? 0 })}
              />
            </Field>
          </div>
          <Toggle
            label="Highlight elements as they're used"
            checked={settings.highlightDuringPlayback}
            onChange={(highlightDuringPlayback) => patch({ highlightDuringPlayback })}
          />
          <Field label="Loading indicators" hint="One CSS selector per line. Playback waits for visible matches to disappear before each step.">
            <CommitInput
              multiline
              mono
              rows={3}
              value={settings.loadingSelectors.join('\n')}
              onCommit={(text) => patch({ loadingSelectors: linesToList(text) })}
            />
          </Field>
        </div>

        <div className="section-title">Recording</div>
        <div className="settings">
          <Toggle
            label="Capture typed values"
            hint="When off, typed text isn't stored and playback asks for it. Passwords and card numbers are never stored either way."
            checked={settings.captureFormValues}
            onChange={(captureFormValues) => patch({ captureFormValues })}
          />
          <Toggle label="Record scrolling" checked={settings.recordScroll} onChange={(recordScroll) => patch({ recordScroll })} />
          <Toggle
            label="Hide credentials in URLs"
            hint="Replaces query parameters that look like tokens or passwords."
            checked={settings.redactUrlParams}
            onChange={(redactUrlParams) => patch({ redactUrlParams })}
          />
          <Field label="Excluded elements" hint="One CSS selector per line. Interactions with these are never recorded. You can also add data-dejavu-ignore to any element.">
            <CommitInput
              multiline
              mono
              rows={3}
              value={settings.excludedSelectors.join('\n')}
              onCommit={(text) => patch({ excludedSelectors: linesToList(text) })}
            />
          </Field>
          <div className="settings-actions">
            <Button icon="target" onClick={pickExclusion}>Pick element to exclude</Button>
          </div>
          <Field label="Test ID attributes" hint="One per line, most preferred first.">
            <CommitInput
              multiline
              mono
              rows={3}
              value={settings.testIdAttributes.join('\n')}
              onCommit={(text) => patch({ testIdAttributes: linesToList(text) })}
            />
          </Field>
        </div>

        <div className="section-title">Site access</div>
        <div className="settings">
          <SiteAccess />
        </div>

        <div className="section-title">Privacy</div>
        <div className="settings">
          <p className="field-hint">
            Recordings are stored in this browser profile and are never sent anywhere. Déjà Vu runs in a page only while
            you're recording, playing or inspecting.
          </p>
        </div>
      </div>
    </div>
  );
}
