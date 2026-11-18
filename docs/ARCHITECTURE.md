# Déjà Vu architecture

Déjà Vu records browser interactions on a page, stores them locally, and replays
them from a Firefox sidebar. This document is the design that the code follows.
User-facing setup is in the [README](../README.md); known gaps are in
[LIMITATIONS.md](./LIMITATIONS.md).

## Requirements, reduced

The product is three loops that must each be dependable:

1. **Capture**: turn a noisy DOM event stream into a short list of logical steps.
2. **Find**: locate the same element later, or refuse loudly if that's impossible.
3. **Drive**: run steps with debugger-like control (pause, step, breakpoints,
   ranges) and survive page navigations.

Everything else (editor, collections, import/export) is a CRUD layer over one
versioned data model.

## Runtime topology

```
┌─────────────── Firefox window ────────────────────────────────┐
│  Sidebar (React)              Tab                             │
│  sidebar-ui                   ┌────────────────────────────┐  │
│   │  commands (sendMessage)   │ content script, per frame  │  │
│   │  state    (Port)          │  recording-engine          │  │
│   ▼                           │  playback-engine/dom       │  │
│  Background event page ◄────► │  selector-engine           │  │
│   session controller          │  overlay (badge, highlight)│  │
│   playback-engine/engine      └────────────────────────────┘  │
│   webNavigation tracking                                      │
│            │                                                  │
│            ▼                                                  │
│  IndexedDB (storage-engine)  ◄── sidebar reads/writes directly │
└────────────────────────────────────────────────────────────────┘
```

| Module | Runs in | Responsibility |
| --- | --- | --- |
| `shared` | everywhere | Data model, message protocol, pure utilities. No DOM, no `browser.*`. |
| `selector-engine` | content | Element → strategies; strategies → exactly one element, or a diagnosis. |
| `recording-engine` | content | DOM events → logical steps, privacy filtering. |
| `playback-engine/engine` | background | Pure state machine. Talks to a `PlaybackDriver` interface. |
| `playback-engine/dom` | content | Actionability checks, event synthesis, waits, assertions. |
| `storage-engine` | background, sidebar | IndexedDB repositories, import/export, schema migrations. |
| `background` | event page | Session lifecycle, script injection, navigation tracking, the real driver. |
| `content-scripts` | every frame | Bootstraps the engines, routes messages, draws the page overlay. |
| `sidebar-ui` | sidebar | All interface. |

The engines don't import each other. `playback-engine/engine` has no dependency on
`browser.*`, so its whole state machine is unit tested with a fake driver.

## Firefox constraints that shaped the design

**Background is an event page, not a service worker, and it gets suspended.**
Firefox MV3 runs `background.scripts` as a non-persistent page, idle-suspended after
about 30 seconds. A paused playback session is held in memory, so two things protect it:

- During a session, the sidebar and the top-frame content script each send a heartbeat.
- Session identity is mirrored to `storage.session`, and recorded steps are written to
  IndexedDB as they arrive, so a recording resumes correctly if the page does get suspended.

All listeners are registered synchronously at top level, as event pages require.

**No trusted input.** Firefox has no `chrome.debugger`/CDP equivalent for extensions,
so playback uses synthetic events with `isTrusted === false`. Consequences:

- Browser default actions that aren't triggered by synthetic events are emulated:
  Tab moves focus, Enter submits the form, Escape closes `<dialog>`, arrows change `<select>`.
- Pages that explicitly reject untrusted events can't be driven.
- It does give the recorder a clean filter: only `isTrusted` events are recorded, which
  excludes playback and page-generated events by construction.

**Focus goes to the sidebar.** When the user clicks Play, the tab's document doesn't
have focus, and Gecko then skips `focus`/`blur` events on `element.focus()`. On-blur
validation would silently not fire, so playback detects this and dispatches those
events itself.

**`permissions.request` must run synchronously in a user gesture.** The sidebar
therefore tracks the active tab's URL and requests access inside the click handler,
before any `await`.

**Host access is optional.** Nothing is requested at install. The user grants the
origin being recorded, or all sites from Settings. Scripts are injected only during a
session (`scripting.executeScript` driven by `webNavigation`), so an idle extension
has no presence in any page.

**Xray vision.** A content script sees native DOM, so `el.value = x` bypasses React's
per-instance value tracker. This means controlled inputs see a real change, which
would otherwise need the prototype setter trick. Native dialogs are patched through
`exportFunction` into the page realm.

**Closed shadow roots.** Firefox exposes `Element.openOrClosedShadowRoot` to extensions,
so both open and closed roots can be traversed.

**Messages die with the page.** A click may navigate before its response arrives.
Each step is therefore split in two:

- `prepare`: find the element and wait until it's actionable. Has no side effects, so
  it's safe to retry across navigations.
- `perform`: act. Never retried. If the channel drops here, the action happened and
  the page navigated.

This is what prevents double submissions.

**Not every load error is an error.** Firefox cancels and restarts a load when it moves a page
to another process, which reports `NS_BINDING_ABORTED`. That's ignored, and a real problem surfaces as
a timeout. Conversely, connection failures load an `about:neterror` document that fires
`DOMContentLoaded`, so those are checked for explicitly. A navigation step only accepts a load
that began after it asked for one.

**Crossing realms.** Arrays and objects from a content script can't be read by page code. Calling a
page function with `apply(page, args)` throws, so arguments are passed individually as primitives.

## Data model

Defined in `src/shared/model/`. Summary:

```ts
interface Recording {
  id; name; description; tags; collectionId; createdAt; updatedAt;
  startUrl; schemaVersion;
  steps: Step[];            // order is the array order
  groups: StepGroup[];
  variables: VariableDef[];
  setup: SetupStep[];       // runs before the first step of every run
}

interface SetupStep {
  id; enabled;
  action: SetupAction;      // setCookie | deleteCookie | clearCookies
}

interface Step {
  id; name?; description?;
  action: StepAction;       // discriminated union on `type`
  execution: 'required' | 'optional' | 'skip';
  target?: ElementTarget;   // selectors + fingerprint + frame path
  wait: WaitConfig;
  breakpoint?: BreakpointConfig;
  groupId?: string;
  condition?: StepCondition;
}
```

`storage-engine` splits a `Recording` into a metadata row and a steps row, so listing
never loads step data. The UI only sees `Recording`; the row layout isn't visible to it.

`StepAction` includes `runRecording`, which expands inline when a run starts. This is how
reusable sequences work without changing the format.

Setup steps aren't part of the plan. They act on the browser rather than a page, so the engine
runs them through `PlaybackDriver.runSetup` before the first plan item, and keeps its own cursor
for them. Retry and Skip after a setup failure work on that cursor, and Restart runs setup again.
The background driver uses the `cookies` API in the cookie store of the tab being played in, so
containers and private windows each get their own cookies. Nested recordings' setup doesn't run;
only the recording that was started has its setup run.

## Selector resolution

Recording stores every strategy that applies, in priority order:

`testId → id → name → aria → role → label → placeholder → attribute → text → css → xpath → context`

Generated-looking values (`:r1:`, `ember123`, hashes, UUIDs, CSS-in-JS classes) are
dropped or demoted during capture.

At playback each strategy gets one of these verdicts, all kept for diagnostics:

| Matches | Handling |
| --- | --- |
| 0 | `no-match`, try the next strategy |
| 1 | Validate against the fingerprint. `resolved` if it agrees, else `mismatch` and continue |
| many | Score by fingerprint. A clear winner is `disambiguated`, otherwise `ambiguous` and continue |

If no strategy resolves, the step fails with the attempt table. It never picks an
arbitrary element.

`context` is the last resort: it scores all elements of the same tag against the
fingerprint and needs both a high score and a margin over the runner-up.

## Playback state machine

```
idle ─start→ playing ─pause/breakpoint/step done→ paused ─resume→ playing
                │                                    │
                ├─required step fails→ failed ─retry/skip→ playing
                ├─end of range→ completed
                └─stop (from any state)→ idle
```

- Breakpoints fire *before* their step, and not for the step a run or resume starts on.
- Pause takes effect at the next step boundary. Stop aborts the current wait immediately.
- A required failure leaves the cursor on the failed step, so Retry and Skip both work.
- Step edits made while paused or failed are picked up on the next step, so the
  fix-selector-then-retry loop needs no restart. Retry waits for the sidebar's save to land
  and rebuilds the plan first, because pressing Retry is what saves the field you were editing.

## Implementation phases

| Phase | Scope |
| --- | --- |
| 1 | Extension shell, sidebar, recording, IndexedDB, editor, sequential playback, execution modes, breakpoints, pause/resume/stop, stepping, JSON import/export |
| 2 | Multi-strategy selectors, intelligent waits, structured errors, ranges, assertions, execution log, highlighting, dynamic content |
| 3 | Collections, groups, variables, reusable sequences, conditional execution, debugging tools (selector tester, element picker) |

The data model covers all three from the start, so later phases don't need a migration.
