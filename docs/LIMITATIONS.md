# Known limitations

These are constraints of Firefox's extension APIs or deliberate scope decisions.
Where an alternative exists, it's noted.

## Caused by the browser

**Playback events are synthetic.** Extensions can't produce trusted input in Firefox: there's
no equivalent of `chrome.debugger`. Every replayed event has `isTrusted === false`.
- Pages that check `isTrusted`, some CAPTCHAs and some anti-bot scripts won't respond. CAPTCHAs
  are out of scope: pause with a breakpoint and solve them by hand.
- Browser behaviour that only trusted input triggers is emulated for common cases: Tab, Shift+Tab,
  Enter, Space, Escape on `<dialog>`, and arrow keys on `<select>`. Other defaults, such as
  arrow keys moving a text cursor or Ctrl+A selecting text, are not.
- Calls that need a user gesture may be refused during replay, including `requestFullscreen`,
  clipboard access and popups from `window.open`.

**File inputs can't be filled.** The file picker can't be scripted. Recording keeps only the file
names, and playback pauses so you can choose the file, then Resume.

**Browser UI isn't recorded.** Extensions can't see toolbar buttons, bookmarks, permission
prompts, `<select>` dropdown popups, or autofill menus. Their results (a navigation, a value
change) are recorded when the page can see them.

**Restricted pages.** Firefox blocks extensions on `about:` pages, `addons.mozilla.org` and
PDF viewer pages, among others. Recording is disabled there.

**Permission prompts need a click.** `permissions.request` only works directly inside a user
gesture. If a recording moves to a new origin, the sidebar shows an Allow button rather than
asking by itself. Steps that happen before you press it aren't recorded. To avoid this,
choose *Allow all sites* in Settings.

**The sidebar is per window.** Sessions follow a single tab, and the sidebar in another window
shows the same session.

## Scope decisions

**One tab per session.** Pop-ups and `target="_blank"` links aren't followed, so flows that move
to a new tab, such as OAuth pop-ups, need to be split up or done by hand at a breakpoint.

**Native dialogs need the step to be right after what opens them.** `alert`, `confirm` and
`prompt` are answered by the `dialog` step that immediately follows the triggering step.
- A dialog with no matching step is shown for real, and playback reports the page as
  unresponsive until you answer it.
- Dialogs fired during page load, or two in a row from one action, can't be armed in time.
- `beforeunload` prompts are not handled.
- A page that saved its own reference to `window.confirm` before the extension attached
  bypasses the patch.

**Timing-sensitive pointer gestures are approximate.** Pointer drags replay as a straight line in
six moves. Long-press, multi-touch, and drawing on `<canvas>` paths aren't reproduced.

**Canvas and WebGL.** Clicks replay at the recorded relative position, but there's no element
inside a canvas to verify against.

**Iframes are identified by URL.** A frame whose URL changes on each load (a random token in the path) can't
be found again. Frames with the same URL are told apart by their order. `srcdoc` and `about:blank`
frames aren't injected into.

**Shadow DOM.** Open and closed roots both work, through Firefox's `openOrClosedShadowRoot`. XPath
strategies aren't captured for shadow content, since XPath can't cross shadow boundaries.
Keyboard events in closed roots are attributed to the focused element.

**The recorder attaches just after a page starts loading.** Interactions in the first few
milliseconds of a new document can be missed.

**`keyPress` selection in text.** Editing keys in text fields (Backspace, arrows, Ctrl+A) aren't
recorded, because the field's final value is what's stored.

**A redirect through a blocked origin** stops being recorded until access is granted.

**Run logs are capped** at the 20 most recent runs per recording.
