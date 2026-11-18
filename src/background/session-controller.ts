import type {
  Command,
  ContentEvent,
  ContentMode,
  PlaybackRange,
  SidebarEvent,
  TargetTestResult,
} from '@shared/messages';
import { IDLE_SNAPSHOT, type RunRecord, type SessionSnapshot } from '@shared/model/execution';
import { DEFAULT_SETTINGS, type Recording, type Settings } from '@shared/model/recording';
import type { ElementTarget } from '@shared/model/selector';
import type { SetupStep } from '@shared/model/setup';
import { setupUrl } from '@shared/setup';
import { newRecording, newStep } from '@shared/steps';
import { errorMessage, isInjectableUrl, originPattern, redactUrl } from '@shared/util';
import { builtinVariables } from '@shared/variables';
import { PlaybackEngine } from '../playback-engine/engine';
import { buildPlan, type PlanRange } from '../playback-engine/plan';
import type { Storage } from '../storage-engine';
import { BrowserDriver } from './browser-driver';
import { NavigationTracker } from './navigation-tracker';
import { RecordingSession, type RecordingSessionState } from './recording-session';
import {
  findFrame,
  frameChain,
  frameIds,
  injectContentScript,
  pickTargetTab,
  sendToAllFrames,
  sendToFrame,
} from './tabs';

const SESSION_KEY = 'activeSession';

type PersistedSession =
  | { kind: 'recording'; state: RecordingSessionState }
  | { kind: 'playback'; tabId: number };

interface PlaybackSession {
  engine: PlaybackEngine;
  driver: BrowserDriver;
  recordingId: string;
  tabId: number;
  range: PlanRange;
}

/** The status Firefox reports for a load that was cancelled, usually to be restarted. */
const NS_BINDING_ABORTED = '2152398850';

function describeErrorPage(url: string): string {
  const params = new URLSearchParams(url.slice(url.indexOf('?')));
  return `Firefox showed an error page (${params.get('e') ?? 'unknown error'}) for ${params.get('u') ?? 'this address'}`;
}

/** The setup steps that run, each with its site filled in. */
function setupForRun(recording: Recording): SetupStep[] {
  return recording.setup
    .filter((item) => item.enabled)
    .map((item) => ({ ...item, action: { ...item.action, url: setupUrl(item.action, recording.startUrl) } }));
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

/** The single owner of what's going on right now: one recording or one playback, in one tab. */
export class SessionController {
  private settings: Settings = DEFAULT_SETTINGS;
  private recording: RecordingSession | null = null;
  private playback: PlaybackSession | null = null;
  private readonly navigation = new NavigationTracker();
  private blockedOrigin: string | null = null;
  private notice: string | null = null;
  private readonly ports = new Set<browser.runtime.Port>();
  private readonly ready: Promise<void>;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly storage: Storage) {
    this.ready = this.restore();
    storage.subscribe((change) => {
      if (change.entity === 'settings') void this.loadSettings();
      if (change.entity === 'recording' && change.id === this.playback?.recordingId) this.scheduleRefresh();
    });
  }

  private async loadSettings(): Promise<void> {
    this.settings = await this.storage.getSettings();
  }

  /** Picks up where things were if the event page was suspended during a session. */
  private async restore(): Promise<void> {
    await this.loadSettings();
    const stored = (await browser.storage.session.get(SESSION_KEY))[SESSION_KEY] as PersistedSession | undefined;
    if (stored?.kind === 'recording') {
      this.recording = this.createRecordingSession(stored.state);
    } else if (stored?.kind === 'playback') {
      this.notice = 'Playback was interrupted because the browser suspended the extension.';
      await this.persist(null);
      await sendToAllFrames(stored.tabId, { type: 'mode', state: { mode: 'idle' } }).catch(() => undefined);
    }
  }

  private async persist(session: PersistedSession | null): Promise<void> {
    if (session) await browser.storage.session.set({ [SESSION_KEY]: session });
    else await browser.storage.session.remove(SESSION_KEY);
  }

  private createRecordingSession(state: RecordingSessionState): RecordingSession {
    const session: RecordingSession = new RecordingSession(
      state,
      this.storage,
      () => this.settings,
      () => this.broadcast(),
      () => void this.persist({ kind: 'recording', state: session.state }),
    );
    return session;
  }

  /* ---------- UI connection ---------- */

  connectPort(port: browser.runtime.Port): void {
    this.ports.add(port);
    port.onDisconnect.addListener(() => this.ports.delete(port));
    // Incoming pings need no reply. Receiving them is what keeps the event page alive.
    port.onMessage.addListener(() => undefined);
    void this.ready.then(() => this.post(port));
  }

  private post(port: browser.runtime.Port): void {
    const event: SidebarEvent = { type: 'session', snapshot: this.snapshot() };
    try {
      port.postMessage(event);
    } catch {
      this.ports.delete(port);
    }
  }

  private broadcast(): void {
    for (const port of this.ports) this.post(port);
  }

  snapshot(): SessionSnapshot {
    if (this.recording) {
      return {
        ...IDLE_SNAPSHOT,
        mode: 'recording',
        tabId: this.recording.state.tabId,
        recording: {
          recordingId: this.recording.state.recordingId,
          stepCount: this.recording.state.stepCount,
          blockedOrigin: this.blockedOrigin,
          capturesValues: this.settings.captureFormValues,
        },
        notice: this.notice,
      };
    }
    if (this.playback) {
      return {
        ...IDLE_SNAPSHOT,
        mode: this.playback.engine.mode,
        tabId: this.playback.tabId,
        playback: this.playback.engine.snapshot(),
        notice: this.notice,
      };
    }
    return { ...IDLE_SNAPSHOT, notice: this.notice };
  }

  /* ---------- Commands from the sidebar ---------- */

  async handleCommand(command: Command): Promise<unknown> {
    await this.ready;
    switch (command.type) {
      case 'session/get':
        return this.snapshot();
      case 'recording/start':
        return this.startRecording(command.tabId, command.recordingId, command.insertAt);
      case 'recording/stop':
        return this.stopRecording();
      case 'recording/addStep':
        return this.recording?.addStep(command.step);
      case 'playback/start':
        return this.startPlayback(command);
      case 'playback/pause':
        return this.playback?.engine.pause();
      case 'playback/resume':
        await this.clearHighlight();
        await this.refreshPlan();
        return this.playback?.engine.resume();
      case 'playback/step':
        await this.clearHighlight();
        await this.refreshPlan();
        return this.playback?.engine.step();
      case 'playback/retry':
        await this.refreshPlan();
        return this.playback?.engine.retry();
      case 'playback/skip':
        return this.playback?.engine.skipFailed();
      case 'playback/restart':
        return this.restartPlayback();
      case 'playback/stop':
        return this.stopPlayback();
      case 'playback/dismiss':
        return this.dismissPlayback();
      case 'playback/speed':
        return this.playback?.engine.setSpeed(command.speed);
      case 'inspect/highlight':
        return this.highlight(command.target);
      case 'inspect/clear':
        return this.clearHighlight();
      case 'inspect/test':
        return this.testTarget(command.target);
      case 'inspect/pick':
        return this.pick();
      case 'inspect/cancelPick':
        return this.cancelPick();
    }
  }

  private async activeTabId(): Promise<number> {
    if (this.recording) return this.recording.state.tabId;
    if (this.playback) return this.playback.tabId;
    const tab = await pickTargetTab();
    if (tab?.id === undefined) throw new Error('There is no tab to work with.');
    return tab.id;
  }

  private assertNoActiveSession(): void {
    if (this.recording) throw new Error('A recording is in progress. Stop it first.');
    const mode = this.playback?.engine.mode;
    if (mode === 'playing' || mode === 'paused') throw new Error('Playback is in progress. Stop it first.');
  }

  private async prepareTab(tabId: number, state: ContentMode): Promise<void> {
    await injectContentScript(tabId);
    await sendToAllFrames(tabId, { type: 'mode', state });
  }

  private contentMode(): ContentMode {
    const { captureFormValues, recordScroll, excludedSelectors, testIdAttributes, highlightDuringPlayback, loadingSelectors } = this.settings;
    if (this.recording) {
      return { mode: 'recording', config: { captureFormValues, recordScroll, excludedSelectors, testIdAttributes } };
    }
    if (this.playback) {
      return { mode: 'playback', config: { highlight: highlightDuringPlayback, loadingSelectors, testIdAttributes } };
    }
    return { mode: 'idle' };
  }

  /* ---------- Recording ---------- */

  private async startRecording(tabId: number | undefined, recordingId?: string, insertAt?: number): Promise<string> {
    this.assertNoActiveSession();
    await this.endFinishedPlayback();
    const tab = tabId === undefined ? await pickTargetTab() : await browser.tabs.get(tabId);
    if (tab?.id === undefined || !isInjectableUrl(tab.url)) {
      throw new Error("This page can't be recorded. Open a website in the current tab, then try again.");
    }
    const url = this.settings.redactUrlParams ? redactUrl(tab.url!) : tab.url!;

    let recording: Recording | undefined;
    if (recordingId) {
      recording = await this.storage.getRecording(recordingId);
      if (!recording) throw new Error('That recording no longer exists.');
    } else {
      recording = newRecording({
        name: `${hostOf(url)} ${new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`,
        startUrl: url,
        steps: [newStep({ type: 'navigate', url })],
      });
      await this.storage.saveRecording(recording);
    }

    this.notice = null;
    this.blockedOrigin = null;
    const state: RecordingSessionState = {
      recordingId: recording.id,
      tabId: tab.id,
      insertAt: insertAt ?? null,
      stepCount: recording.steps.length,
      history: [url],
      historyIndex: 0,
      lastInteractionAt: 0,
    };
    this.recording = this.createRecordingSession(state);
    try {
      await this.prepareTab(tab.id, this.contentMode());
    } catch (error) {
      this.recording = null;
      throw new Error(`Couldn't start recording on this page: ${errorMessage(error)}`);
    }
    await this.persist({ kind: 'recording', state });
    this.broadcast();
    return recording.id;
  }

  private async stopRecording(): Promise<void> {
    const session = this.recording;
    if (!session) return;
    // Frames flush anything pending when they go idle, and those steps have to land first.
    await sendToAllFrames(session.state.tabId, { type: 'mode', state: { mode: 'idle' } }).catch(() => undefined);
    await session.drain();
    this.recording = null;
    this.blockedOrigin = null;
    await this.persist(null);
    this.broadcast();
  }

  /* ---------- Playback ---------- */

  private rangeToPlan(recording: Recording, range: PlaybackRange | undefined): PlanRange {
    const from = range?.from === undefined ? undefined : recording.steps[range.from]?.id;
    const to = range?.to === undefined ? undefined : recording.steps[range.to]?.id;
    return { ...(from ? { fromStepId: from } : {}), ...(to ? { toStepId: to } : {}) };
  }

  private async startPlayback(command: Extract<Command, { type: 'playback/start' }>): Promise<void> {
    this.assertNoActiveSession();
    await this.endFinishedPlayback();
    const recording = await this.storage.getRecording(command.recordingId);
    if (!recording) throw new Error('That recording no longer exists.');
    if (recording.steps.length === 0) throw new Error('This recording has no steps yet.');

    const tab = command.tabId === undefined ? await pickTargetTab() : await browser.tabs.get(command.tabId);
    if (tab?.id === undefined) throw new Error('There is no tab to play in.');
    const tabId = tab.id;

    const range = this.rangeToPlan(recording, command.range);
    const plan = await buildPlan(recording, range, (id) => this.storage.getRecording(id));
    if (plan.length === 0) throw new Error('There are no steps in that range.');

    const variables: Record<string, string> = { ...builtinVariables() };
    for (const definition of recording.variables) variables[definition.name] = definition.defaultValue;
    Object.assign(variables, command.variables);

    const driver = new BrowserDriver(tabId, this.navigation, () => this.settings);
    const engine = new PlaybackEngine({
      recordingId: recording.id,
      driver,
      plan,
      setup: setupForRun(recording),
      variables,
      speed: command.speed ?? this.settings.defaultSpeed,
      timings: {
        defaultTimeoutMs: this.settings.defaultTimeoutMs,
        optionalTimeoutMs: this.settings.optionalTimeoutMs,
        stepDelayMs: this.settings.stepDelayMs,
      },
      onChange: () => this.onPlaybackChange(),
      onFinish: (outcome) => void this.onPlaybackFinished(engine, recording.id, outcome),
    });

    this.notice = null;
    this.playback = { engine, driver, recordingId: recording.id, tabId, range };
    await this.persist({ kind: 'playback', tabId });
    if (isInjectableUrl(tab.url)) {
      // The first step may navigate away from a page we can't touch, so a failure here isn't fatal.
      await this.prepareTab(tabId, this.contentMode()).catch(() => undefined);
    }
    engine.start({ paused: command.paused ?? false });
  }

  private onPlaybackChange(): void {
    this.broadcast();
  }

  private async onPlaybackFinished(
    engine: PlaybackEngine,
    recordingId: string,
    outcome: 'completed' | 'failed' | 'stopped',
  ): Promise<void> {
    const progress = engine.snapshot();
    const run: RunRecord = {
      id: progress.runId,
      recordingId,
      startedAt: progress.startedAt,
      finishedAt: progress.finishedAt ?? Date.now(),
      outcome,
      log: progress.log,
    };
    await this.storage.saveRun(run).catch((error: unknown) => console.error('Déjà Vu: failed to save the run log', error));
    // A failed run stays attached to the page so that Retry works.
    if (outcome !== 'failed' && this.playback?.engine === engine) {
      const { tabId } = this.playback;
      await this.persist(null);
      await sendToAllFrames(tabId, { type: 'mode', state: { mode: 'idle' } }).catch(() => undefined);
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refreshPlan(), 50);
  }

  /** Lets edits made while paused or failed apply to what's left of the run. */
  private async refreshPlan(): Promise<void> {
    const session = this.playback;
    if (!session) return;
    const recording = await this.storage.getRecording(session.recordingId);
    if (!recording) return;
    try {
      const plan = await buildPlan(recording, session.range, (id) => this.storage.getRecording(id));
      session.engine.updatePlan(plan);
      session.engine.updateSetup(setupForRun(recording));
    } catch (error) {
      this.notice = errorMessage(error);
      this.broadcast();
    }
  }

  private async restartPlayback(): Promise<void> {
    const session = this.playback;
    if (!session) return;
    await this.persist({ kind: 'playback', tabId: session.tabId });
    await this.prepareTab(session.tabId, this.contentMode()).catch(() => undefined);
    session.engine.restart();
  }

  private async stopPlayback(): Promise<void> {
    const session = this.playback;
    if (!session) return;
    await sendToAllFrames(session.tabId, { type: 'cancel' }).catch(() => undefined);
    session.engine.stop();
    await this.dismissPlayback();
  }

  /** Clears a finished run's results from the UI. */
  private async dismissPlayback(): Promise<void> {
    const session = this.playback;
    if (!session) return;
    const { mode } = session.engine;
    if (mode === 'playing' || mode === 'paused') return;
    this.playback = null;
    await this.persist(null);
    await sendToAllFrames(session.tabId, { type: 'mode', state: { mode: 'idle' } }).catch(() => undefined);
    this.broadcast();
  }

  private async endFinishedPlayback(): Promise<void> {
    if (this.playback) {
      this.playback.engine.stop();
      await this.dismissPlayback();
    }
  }

  /* ---------- Inspecting ---------- */

  private async frameForTarget(tabId: number, target: ElementTarget): Promise<number | undefined> {
    return target.frames?.length ? findFrame(tabId, target.frames) : 0;
  }

  private async highlight(target: ElementTarget): Promise<boolean> {
    const tabId = await this.activeTabId();
    await injectContentScript(tabId).catch(() => undefined);
    const frameId = await this.frameForTarget(tabId, target);
    if (frameId === undefined) return false;
    return sendToFrame<boolean>(tabId, frameId, {
      type: 'highlight',
      target,
      testIdAttributes: this.settings.testIdAttributes,
    });
  }

  private async clearHighlight(): Promise<void> {
    const tabId = await this.activeTabId().catch(() => null);
    if (tabId !== null) await sendToAllFrames(tabId, { type: 'clearHighlight' }).catch(() => undefined);
  }

  private async testTarget(target: ElementTarget): Promise<TargetTestResult> {
    const tabId = await this.activeTabId();
    await injectContentScript(tabId);
    const frameId = await this.frameForTarget(tabId, target);
    if (frameId === undefined) {
      return { resolvedBy: null, attempts: [], error: "The element's frame isn't in the current page." };
    }
    return sendToFrame<TargetTestResult>(tabId, frameId, { type: 'testTarget', target });
  }

  /** Lets the user click an element in the page. Resolves with null if they cancel. */
  private async pick(): Promise<ElementTarget | null> {
    const tabId = await this.activeTabId();
    await injectContentScript(tabId);
    const ids = await frameIds(tabId);
    // Every frame listens for the click. The first to report one wins, and if all of
    // them come back empty then the user cancelled.
    const picked = await new Promise<{ target: ElementTarget; frameId: number } | null>((resolve) => {
      let remaining = ids.length;
      for (const frameId of ids) {
        sendToFrame<ElementTarget | null>(tabId, frameId, { type: 'pick', testIdAttributes: this.settings.testIdAttributes })
          .catch(() => null)
          .then((target) => {
            remaining--;
            if (target) resolve({ target, frameId });
            else if (remaining === 0) resolve(null);
          });
      }
    });
    await sendToAllFrames(tabId, { type: 'cancelPick' });
    if (!picked) return null;
    if (picked.frameId === 0) return picked.target;
    return { ...picked.target, frames: await frameChain(tabId, picked.frameId) };
  }

  private async cancelPick(): Promise<void> {
    const tabId = await this.activeTabId();
    await sendToAllFrames(tabId, { type: 'cancelPick' });
  }

  /* ---------- Events from content scripts ---------- */

  async handleContentEvent(event: ContentEvent, sender: browser.runtime.MessageSender): Promise<unknown> {
    await this.ready;
    const tabId = sender.tab?.id;
    const frameId = sender.frameId ?? 0;
    const inSession = tabId !== undefined && tabId === (this.recording?.state.tabId ?? this.playback?.tabId);
    switch (event.type) {
      case 'hello':
        return inSession ? this.contentMode() : ({ mode: 'idle' } satisfies ContentMode);
      case 'recorder/step':
        if (inSession) await this.recording?.addDraft(event.draft, frameId);
        return undefined;
      case 'recorder/replace':
        if (inSession) await this.recording?.replaceLast(event.count, event.draft, frameId);
        return undefined;
      case 'dialog/handled':
        if (inSession) this.playback?.driver.onDialogHandled();
        return undefined;
      case 'heartbeat':
        return undefined;
    }
  }

  /* ---------- Browser events ---------- */

  private sessionTab(): number | undefined {
    return this.recording?.state.tabId ?? this.playback?.tabId;
  }

  /** The new document needs a content script before the user can do anything in it. */
  private async attach(tabId: number, frameId: number, url: string): Promise<void> {
    if (!isInjectableUrl(url)) return;
    try {
      await injectContentScript(tabId, frameId);
      if (frameId === 0 && this.blockedOrigin) {
        this.blockedOrigin = null;
        this.broadcast();
      }
    } catch (error) {
      if (frameId === 0 && this.recording && /permission/i.test(errorMessage(error))) {
        this.blockedOrigin = originPattern(url);
        this.broadcast();
      }
    }
  }

  async onBeforeNavigate(details: { tabId: number; frameId: number }): Promise<void> {
    await this.ready;
    if (details.tabId === this.sessionTab() && details.frameId === 0) this.navigation.onBeforeNavigate();
  }

  async onCommitted(details: browser.webNavigation._OnCommittedDetails): Promise<void> {
    await this.ready;
    if (details.tabId !== this.sessionTab()) return;
    void this.attach(details.tabId, details.frameId, details.url);
    if (details.frameId === 0) {
      void this.recording?.onCommitted({
        url: details.url,
        transitionType: details.transitionType,
        transitionQualifiers: details.transitionQualifiers,
      });
    }
  }

  async onDomContentLoaded(details: { tabId: number; frameId: number; url: string }): Promise<void> {
    await this.ready;
    if (details.tabId !== this.sessionTab()) return;
    // Catches documents the early injection was too soon for. Injecting twice is harmless.
    await this.attach(details.tabId, details.frameId, details.url);
    if (details.frameId !== 0) return;
    // Firefox's error pages load like any other document.
    if (/^about:(neterror|certerror)/.test(details.url)) this.navigation.onError(describeErrorPage(details.url));
    else this.navigation.onLoaded();
  }

  /** A backstop for documents restored from the back/forward cache. */
  async onCompleted(details: { tabId: number; frameId: number; url: string }): Promise<void> {
    await this.ready;
    if (details.tabId !== this.sessionTab() || details.frameId !== 0) return;
    if (!details.url.startsWith('about:neterror') && !details.url.startsWith('about:certerror')) this.navigation.onLoaded();
  }

  async onSameDocumentNavigation(details: {
    tabId: number;
    frameId: number;
    url: string;
    transitionQualifiers: string[];
  }): Promise<void> {
    await this.ready;
    if (details.tabId !== this.sessionTab() || details.frameId !== 0) return;
    this.navigation.onSameDocument();
    void this.recording?.onSameDocumentNavigation(details.url, details.transitionQualifiers);
  }

  async onNavigationError(details: { tabId: number; frameId: number; error?: string; url: string }): Promise<void> {
    await this.ready;
    if (details.tabId !== this.sessionTab() || details.frameId !== 0) return;
    if (details.error?.includes(NS_BINDING_ABORTED)) this.navigation.onAborted();
    else this.navigation.onError(`${details.error ?? 'Navigation failed'} (${details.url})`);
  }

  async onTabRemoved(tabId: number): Promise<void> {
    await this.ready;
    if (tabId === this.recording?.state.tabId) {
      await this.recording.drain();
      this.recording = null;
      this.notice = 'Recording stopped because its tab was closed.';
      await this.persist(null);
      this.broadcast();
    } else if (tabId === this.playback?.tabId) {
      this.playback.engine.stop();
      this.playback = null;
      this.notice = 'Playback stopped because its tab was closed.';
      await this.persist(null);
      this.broadcast();
    }
  }

  /** Access was just granted, so a page that was blocked can be picked up. */
  async onPermissionsAdded(): Promise<void> {
    await this.ready;
    const tabId = this.sessionTab();
    if (tabId === undefined) return;
    const tab = await browser.tabs.get(tabId);
    await injectContentScript(tabId).catch(() => undefined);
    await sendToAllFrames(tabId, { type: 'mode', state: this.contentMode() }).catch(() => undefined);
    if (isInjectableUrl(tab.url)) {
      this.blockedOrigin = null;
      this.broadcast();
    }
  }
}
