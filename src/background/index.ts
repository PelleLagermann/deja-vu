import { SIDEBAR_PORT, type Command, type CommandResult, type ContentEvent } from '@shared/messages';
import { errorMessage } from '@shared/util';
import { Storage } from '../storage-engine';
import { SessionController } from './session-controller';

/*
 * This is an event page: Firefox unloads it when idle and reloads it when something
 * happens. Every listener must therefore be registered synchronously, right here.
 */

const controller = new SessionController(new Storage());

browser.action.onClicked.addListener(() => {
  void browser.sidebarAction.toggle();
});

browser.runtime.onConnect.addListener((port) => {
  if (port.name === SIDEBAR_PORT) controller.connectPort(port);
});

function isCommand(message: { type: string }): message is Command {
  return /^(recording\/(start|stop|addStep)|playback\/|inspect\/|session\/)/.test(message.type);
}

browser.runtime.onMessage.addListener((message: Command | ContentEvent, sender) => {
  if (sender.id !== browser.runtime.id) return undefined;
  if (sender.tab && !sender.url?.startsWith('moz-extension:')) {
    return controller.handleContentEvent(message as ContentEvent, sender);
  }
  if (!isCommand(message)) return undefined;
  return controller.handleCommand(message).then(
    (value): CommandResult => ({ ok: true, value: value ?? null }),
    (error: unknown): CommandResult => ({ ok: false, error: errorMessage(error) }),
  );
});

browser.webNavigation.onBeforeNavigate.addListener((details) => void controller.onBeforeNavigate(details));
browser.webNavigation.onCommitted.addListener((details) => void controller.onCommitted(details));
browser.webNavigation.onDOMContentLoaded.addListener((details) => void controller.onDomContentLoaded(details));
browser.webNavigation.onCompleted.addListener((details) => void controller.onCompleted(details));
browser.webNavigation.onErrorOccurred.addListener((details) => void controller.onNavigationError(details));
browser.webNavigation.onHistoryStateUpdated.addListener((details) => void controller.onSameDocumentNavigation(details));
browser.webNavigation.onReferenceFragmentUpdated.addListener((details) => void controller.onSameDocumentNavigation(details));
browser.tabs.onRemoved.addListener((tabId) => void controller.onTabRemoved(tabId));
browser.permissions.onAdded.addListener(() => void controller.onPermissionsAdded());
