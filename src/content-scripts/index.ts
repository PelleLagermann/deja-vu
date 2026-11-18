import type {
  ContentEvent,
  ContentMode,
  ContentRequest,
  StrategyTestResult,
  TargetTestResult,
} from '@shared/messages';
import type { ElementTarget } from '@shared/model/selector';
import type { NativeDialogKind } from '@shared/model/step';
import { DomExecutor } from '../playback-engine/dom/executor';
import { Recorder, type RecorderOutput } from '../recording-engine/recorder';
import { resolveTarget, testStrategy } from '../selector-engine';
import { patchNativeDialogs, type DialogCall } from './native-dialogs';
import { Overlay } from './overlay';
import { ElementPicker } from './picker';

const HEARTBEAT_MS = 10_000;
const RECORD_COLOR = '#f0524f';

interface ArmedDialog {
  kind: NativeDialogKind;
  accept: boolean;
  promptText?: string;
}

function send(event: ContentEvent): Promise<unknown> {
  return browser.runtime.sendMessage(event);
}

/** All of a frame's runtime state. It exists once per document. */
class ContentAgent {
  private readonly overlay = new Overlay();
  private readonly picker = new ElementPicker(this.overlay);
  private recorder: Recorder | null = null;
  private executor: DomExecutor | null = null;
  private testIdAttributes: string[] = [];
  private armedDialog: ArmedDialog | null = null;
  private restoreDialogs: (() => void) | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  async start(): Promise<void> {
    // Going through a promise turns a synchronous throw into a rejection the sender can see.
    browser.runtime.onMessage.addListener((message: ContentRequest) => Promise.resolve().then(() => this.handle(message)));
    const state = (await send({ type: 'hello', url: location.href })) as ContentMode | undefined;
    if (state) this.setMode(state);
  }

  private handle(message: ContentRequest): Promise<unknown> | undefined {
    switch (message.type) {
      case 'mode':
        this.setMode(message.state);
        return Promise.resolve(true);
      case 'prepare':
        return this.executorOrThrow().prepare(message);
      case 'perform':
        return this.executorOrThrow().perform(message.token);
      case 'cancel':
        this.executor?.cancel();
        return Promise.resolve(true);
      case 'evalCondition':
        return Promise.resolve(this.executorOrThrow().evaluateCondition(message.condition));
      case 'armDialog':
        this.armedDialog = {
          kind: message.kind,
          accept: message.accept,
          ...(message.promptText === undefined ? {} : { promptText: message.promptText }),
        };
        return Promise.resolve(true);
      case 'highlight':
        return Promise.resolve(this.highlight(message.target, message.testIdAttributes));
      case 'clearHighlight':
        this.overlay.clearHighlight();
        return Promise.resolve(true);
      case 'testTarget':
        return Promise.resolve(this.testTarget(message.target));
      case 'pick':
        return this.picker.pick(message.testIdAttributes);
      case 'cancelPick':
        this.picker.cancel();
        return Promise.resolve(true);
    }
  }

  private executorOrThrow(): DomExecutor {
    if (!this.executor) throw new Error('This frame is not in playback mode');
    return this.executor;
  }

  private setMode(state: ContentMode): void {
    this.stopCurrentMode();
    if (state.mode === 'idle') return;
    this.startHeartbeat();

    if (state.mode === 'recording') {
      this.testIdAttributes = state.config.testIdAttributes;
      const recorder = new Recorder({
        config: state.config,
        emit: (output) => this.forward(output),
        isOwnElement: (element) => this.picker.active || this.overlay.owns(element),
      });
      recorder.start();
      this.recorder = recorder;
      this.restoreDialogs = patchNativeDialogs((call) => this.recordDialog(call));
      if (window === window.top) {
        const values = state.config.captureFormValues ? 'Form values are being captured' : 'Form values are not captured';
        this.overlay.showBadge(`● Recording. ${values}.`, RECORD_COLOR);
      }
      return;
    }

    this.testIdAttributes = state.config.testIdAttributes;
    this.executor = new DomExecutor(state.config, { flash: (element) => this.overlay.flash(element) });
    this.restoreDialogs = patchNativeDialogs((call) => this.answerDialog(call));
  }

  private stopCurrentMode(): void {
    this.recorder?.stop();
    this.recorder = null;
    this.executor?.cancel();
    this.executor = null;
    this.armedDialog = null;
    this.restoreDialogs?.();
    this.restoreDialogs = null;
    this.overlay.hideBadge();
    this.overlay.clearHighlight();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  /** Keeps the event page alive during a session, even if the sidebar is closed. */
  private startHeartbeat(): void {
    if (window !== window.top) return;
    this.heartbeat = setInterval(() => void send({ type: 'heartbeat' }).catch(() => undefined), HEARTBEAT_MS);
  }

  private forward(output: RecorderOutput): void {
    const event: ContentEvent =
      output.kind === 'step'
        ? { type: 'recorder/step', draft: output.draft }
        : { type: 'recorder/replace', count: output.count, draft: output.draft };
    void send(event).catch(() => undefined);
  }

  private recordDialog(call: DialogCall): unknown {
    const result = call.showNative();
    const accept = call.kind === 'alert' || (call.kind === 'confirm' ? result === true : result !== null);
    this.recorder?.recordDialog({
      type: 'dialog',
      kind: call.kind,
      accept,
      message: call.message,
      ...(call.kind === 'prompt' && typeof result === 'string' ? { promptText: result } : {}),
    });
    return result;
  }

  private answerDialog(call: DialogCall): unknown {
    const armed = this.armedDialog;
    // An unexpected dialog is shown for real: answering for the user could do damage.
    if (armed?.kind !== call.kind) return call.showNative();
    this.armedDialog = null;
    void send({ type: 'dialog/handled', kind: call.kind }).catch(() => undefined);
    if (call.kind === 'confirm') return armed.accept;
    if (call.kind === 'prompt') return armed.accept ? (armed.promptText ?? '') : null;
    return undefined;
  }

  private highlight(target: ElementTarget, testIdAttributes: string[]): boolean {
    const { element } = resolveTarget(target, { testIdAttributes });
    if (!element) return false;
    element.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    this.overlay.highlight(element, target.summary);
    return true;
  }

  private testTarget(target: ElementTarget): TargetTestResult {
    const { attempts, resolvedBy } = resolveTarget(target, { testIdAttributes: this.testIdAttributes });
    const results: StrategyTestResult[] = attempts.map((attempt) => ({
      strategy: attempt.strategy,
      verdict: attempt.verdict,
      matchCount: attempt.verdict === 'not-tried' ? testStrategy(attempt.strategy) : attempt.matchCount,
    }));
    return { resolvedBy, attempts: results };
  }
}

const loaded = globalThis as typeof globalThis & { __dejavuLoaded?: boolean };
if (!loaded.__dejavuLoaded) {
  loaded.__dejavuLoaded = true;
  new ContentAgent().start().catch(() => undefined);
}
