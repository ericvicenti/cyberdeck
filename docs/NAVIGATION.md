# Cyberdeck navigation coverage

Updated 2026-10-27. This is an implementation inventory, not a completion claim.
The nightly routine and fleet deployment status live in Deck's
`handoff/routines/cyberdeck-navigation/2026-10-27.md`.

## Source and rollout status

The shared router, administrative views, Casework device selection and Cloud
bridge are now reconciled into main from this routine's exact owned patches.
The newer Seed and Desktop views are retained. Seed nested paths use the same
history writer, including replace notifications and node-preserving new-window
links; malformed and unknown nested paths render a not-found view. Services and
cmux now distinguish missing selections from ordinary content. Native keyboard
Enter/save events reach React and editors; the TV runtime is on main.
The October 19–21 Editor, Vault player and Casework continuity work is now
reconciled into current main with its production-bundle browser tests.

## URL contract

`#/view?key=value&node=<paired-id>` is authoritative. Missing `node` means the
serving machine, even when local storage remembers another machine. Internal
navigation never carries `node` from one view to the next: a link states its own
machine (Files, Editor, Cloud, Desktop, Seed and a session tab are machine-bound;
Projects, Sessions, cmux, Data, Agents, Services and Home span the fleet and have no
node of their own, except Data's `node` filter). There is no page-wide machine
selector. The server still authenticates every API/proxy request; node IDs are
path-encoded. Node-scoped components remount only when that node changes, not on
query edits.
Applications (with Afterglow's music tab) and the physical screen remote retain their existing
serving-node behavior.

`ui/lib/navigation.ts` owns parsing, sorted query serialization, push/replace,
legacy aliases, merged parameter updates, and route titles. `edit` coalesces an
input interaction into one undoable entry. Default selections use replace;
explicit entity/tab selections push. No-op writes create no entry. Query values
are split at the first `?`, then encoded by URLSearchParams. Unknown top-level
routes show Page not found. Future changes should normalize further view-specific
parameters rather than hiding an invalid selected entity with the first result.

Dynamic titles belong to an exact fragment and have an owner-specific cleanup.
Stale requests must be cancelled or generation-checked before publishing content
or titles. The authentication screen owns `Locked · Cyberdeck`, preserves the
requested fragment, and reloads it after unlocking.

A URL describes content; it must not replay a command. In particular,
`#/term?cwd=…` opens a prefilled **New session** form. Only Open creates the shell.
Once created the URL identifies the durable session. Closing a browser attachment
does not terminate the daemon-owned process.

## Complete route and state-owner inventory

“Covered” below describes the implemented state, not all acceptance criteria for
that view. Runtime operations, drafts, selection for destructive actions, and
credentials should not be replayed from a link.

| Route / owner | Navigable state | Coverage / remaining work |
| --- | --- | --- |
| main / PWA / token and OAuth bootstrap | token entry, OAuth return, install manifest | Spotify OAuth restores a validated, tab-local return fragment after state verification. Callback codes are removed and cannot enter shared URLs; invalid state cannot choose a return destination. |
| App / api / navigation | primary view, node, not-found, auth, titles | Covered, including legacy `service`→`svc`, Steam app→Vault tab. More parameter validation and every error title remain. |
| `fleet` / Home | local/fleet overview, node links; pairing and account/reset dialogs; NetworkMap selected endpoints | Overview and node links covered. `networkFrom` / `networkTo` identify an inspected connection by host name, independent of the serving node. Selections push once; partial/whitespace links replace canonical defaults; Back/Forward, reload and fresh tabs restore both endpoints. Unknown/same-host links keep honest errors and titles; unavailable telemetry retains the requested pair. Pairing/reset/benchmark actions remain explicit and never replay from links. |
| `controls` / Controls | control diagram, bindings/editor, reset notice | Static route/title covered where installed. Binding changes are settings, not navigation. Keyboard/gamepad mode preferences remain local. |
| `applications` / Applications | application id, Casework example, pairing dialog, reload | Id, unknown-id and unavailable-listing errors/titles covered; failed lookups retain the requested link instead of showing an ordinary app list. Pairing is an explicit operation. Visited generic iframe documents now survive primary-view, application and node navigation. Opt-in generic SPA navigation now restores root-relative child routes/titles via an origin/source/request-bound bridge and keeps one history owner. Commander has a bridge integration (Starlight activation verified on October 26) for its main views, trainer tabs/inspectors/filters, workshop tabs/run inspection and community directory; its remaining nested states are listed below. Unsupported nested links in noncooperating apps report a restoration error. See `docs/EMBEDDED-NAVIGATION.md`. |
| `applications?app=afterglow` / AfterglowFrame + BoticalMedia/public/navigation.js | child route, season/episode, search/filter, person dialog, music and YouTube state | Existing bridge retained: exact origin+source, parent-only history, route restoration, stable iframe, title cleanup. Browser regressions now prove document/timer continuity across primary views, other apps and node changes, plus hidden-message isolation and route/title restoration. A pending parent route rejects stale child acknowledgements. Missing, malformed and legacy child routes normalize with replace, preserving the iframe document and prior history. No production media is played by these checks. |
| `applications?app=vimm` / Vault | tabs, system, query, letter, page; selected retro title modal | Covered. `game=<catalog-id>` restores a detail from its shelf/catalog/list context on fresh open, reload and history without starting playback. Invalid tab/system/query/letter/page/game values normalize; missing IDs retain an honest error/title. My list and ready-to-play metadata remain browser-local by design. |
| VaultPlayer / vault download and storage | running emulator, ROM cache, save state, native N64 handoff, pause menu | Play retains the selected game detail URL, while fresh links and reloads show details without starting or downloading a game. The owner survives app, primary-view, node and screen-remote navigation. Hidden games leave the modal top layer, release keyboard/controller handlers and cannot steal focus or titles. Resume returns to the existing core; explicit Save & exit completes it. Real NES homebrew fixtures prove continuity and responsive save/exit. Native N64/gamepad hardware remains unverified. |
| SteamVault / Steam | selected game, PC tab, query; native install/game/session/cloud-save decisions | `steam=<id>` detail added, resolves from serving-node library, restores without Play. Game/cloud decision/quit remain runtime/confirmation actions. Keep background Steam/client/kiosk alive. |
| GamesSection / Games | installed native games and import form | Part of Applications. Play/import are actions; no automatic execution from links. |
| CaseworkConsole | selected device, events, camera/media/QR, calls, native scene actions | Selected device is covered by `device=<id>`, including canonical default, reload/history, missing-device error/title and no action replay. Visited consoles retain their socket, calls and previews across apps, primary views, node URLs and history; lock tears them down. `media=<stored-name>` fetches only an existing authenticated upload: fresh open, reload and history never capture, upload or autoplay. Invalid, missing and denied previews have matching errors/titles. Tests use synthetic devices/tracks only. |
| `applications?app=afterglow&tab=music` / Spotify (the listening room), SpotifyRecordings, SpotifyVisualizer | shelves, entities, query, pagination, recordings, immersive mode | One player everywhere, inside Afterglow: `shelf`, `id`, `q`, `radio`, `page`, `immersive` and `shelf=history&recording=<id>` restore through direct links, reload and history; OAuth returns to the requested content; no link starts playback; the SDK/player stays mounted through URL and primary-view changes. Legacy `#/spotify` links are rewritten. |
| `seed` / SeedAgents + published agents UI | agent/tab/trigger/memory, session, run, server, node | Nested route canonicalization, malformed/unknown path errors, route-based titles, Back/Forward and node-preserving new-window links covered. Backend, identity and server failures keep accurate titles across nested routes, reload and node transitions; late failures cannot retitle another node. Agent/tab/trigger names, memory paths, session titles (including untitled sessions) and run titles now resolve through authenticated read-only metadata on the selected node. Missing/access-denied/unavailable entities have matching titles. Route/host ownership rejects late responses; focus and 30-second visible-page refresh pick up renames. URL-supplied external servers retain route-based titles; memory-directory metadata now distinguishes missing files, directories, access denial and unavailable parents. File-content read failures after successful metadata and further lifecycle cases still need coverage. |
| `desktop` / Desktop | selected node and connection | Primary route/title and URL-selected node covered; connect/input/credentials remain explicit runtime actions. |
| `desk` / Desk + voice | Fleet/Services/Agents glance tab, voice call, transcript, setup, mute | `tab=services` / `tab=agents` restore from fresh links and history; default fleet ignores stale local preferences, invalid tabs replace to the default, and titles match. Tab transitions retain the voice subtree without reconnecting. Calls and permissions stay explicit. The call owner now stays mounted across primary views, node changes and screen-remote navigation. Voice requests stay on the serving daemon’s hub relay; idle configuration refreshes on return. Simulated live-room tests prove no disconnect/reconnect during navigation, release of push-to-talk when hidden, and disconnect on authentication lock. Real calls/microphones are not used by tests. |
| `projects` / Projects | selected project, nested slug, unassigned repos, query | URL selection, canonical default, filter, title, missing project covered. Nested slugs use the same `p` key. Editing launches Files/Editor. |
| `agents` / Agents | task focus, run, log file, session query/host/tool, handoff disclosure, project prefill | Covered, including late search suppression. Task selection defaults to its run. Follow-scroll preference and launch/task drafts remain transient. Missing tasks/runs/logs have matching errors and titles; log content is keyed to run/file so failed or late requests cannot display another selection. Invalid log names canonicalize to worker.log. Backend failure titles are covered by the same ownership rules; broader session lifecycle checks remain. |
| `services` / Services | host and service focus | Existing URL parameters retained; legacy Home `service` links fixed centrally. Missing host/service selections and unavailable backend now have matching titles and visible errors. Start/restart/log commands remain explicit. |
| `data` / Data | root filter, repo query | Covered. Scans are actions; table has a fixed 100-item cap, not a pageable UI. |
| `files` / Files, TreeNode, dialogs | path, hidden files, sort/order, query, deep search, File Info modal | Covered, including stale listing/deep-search protection. Multi-selection, expanded tree folders, clipboard, rename/chmod/delete/import drafts stay transient; assess any desired navigable selection separately. Failed directory/info has a matching title. |
| `edit` / Editor | file path, text/media/markdown, playlist; video transport mode, loop/shuffle | Path/title reconstruct content; empty paths and missing text have accurate views/titles. Documents are retained per node/path across files, primary views and history, preserving unsaved buffers, undo and media. Saves capture a revision and cannot clear later edits; duplicate saves are serialized. Requests and delayed media events stay bound to the original node. Hidden ended/error events cannot navigate or retitle another view. Explicit playlist selection pauses the old track; ordinary navigation leaves playback intact. Drafts remain in memory until tab close, refresh or lock. PDF previews now restore page/zoom/rotation, typed failures and passwords through the parent route (see October 27). Persisted media playback position/preferences remain outside this slice. |
| `term` / Term, TermPane, SeedPane, PromptBar | node/session, new-session form, cwd prefill; transcript pagination | `filter` selects the tab-strip machine (`self` = serving node, absent = every machine); `target` selects the New form destination independently of the underlying session node. Both restore on reload/new-tab/Back/Forward, and selecting a session retains its filter. Default selection waits for its owner and replaces once; offline/unknown nodes have distinct errors, delayed peers do not become false missing sessions. Seed session links use authenticated entity titles. Links never create a process. Daemon persistence covered in existing E2E. Transcript pagination/drafts and remaining backend errors remain. |
| `cmux` / Cmux | surface, scrollback, creation form | Surface/scrollback URL/default/title covered. Polling screen response guarded. Workspace creation, input and desktop focus are explicit actions. Missing surfaces have a not-found state/title and never poll a nonexistent terminal. Backend unavailable has its own title. |
| `cloud` / Cloud + RemoteBrowser | profile, target URL, archive query, provider+conversation | Covered. Remote URL/title state mirrors into the parent route after a request acknowledgement; initial profile state cannot overwrite direct links, redirects replace the requested URL, page/user navigation pushes once, and Back/Forward restores without remounting the persistent browser. The UI settles unacknowledged state for older daemons during rolling updates. Missing profiles, invalid target URLs and unavailable browsers show matching errors/titles before any browser socket is opened. |
| `remote` / ScreenRemote | physical screen connection, text/scroll mode, remote buttons | Static route/title; captures server kiosk, which has its own navigation. Do not attach normal Playwright to active kiosk (it changes emulated focus); only noDefaults/raw CDP for future physical verification. |
| Standalone player documents | `/vault-player.html`, `/spotify-player.html` | Internal player/SDK transports, not independently reconstructable media links. Preserve their authenticated message channels; represent navigable content in their parent view. `/samples/:name` serves media bytes, not a view. |
| Markdown / Widgets / PromptBar / VolumeControl | rendering, panel links, new-run draft, session strip, volume | No independent routes. Session strip links now encode node and session in a single transition. Input/volume are actions/preferences. |

## Repeatable verification and deployment

Build first: `bun run typecheck && bun run build`.
Read-only real-browser fixtures:
`bun test tests/navigation-browser.test.ts tests/afterglow-navigation.test.ts`.
Editor, Vault and Casework continuity fixtures:
`bun test tests/navigation-browser.test.ts tests/vault-navigation.test.ts tests/casework-navigation.test.ts --timeout 30000`.
The Vault fixture uses generated original NES homebrew; Casework uses synthetic
devices, tracks and uploads. Neither suite starts production media or actions.
Real sandboxed daemon regression: `bun test tests/e2e.test.ts` (includes generated
shell/files and isolates daemon home; does not control installed sessions).
Cloud archive/browser history and rolling-protocol regressions are in
`bun test tests/cloud.test.ts tests/navigation-browser.test.ts`.
Music (Afterglow tab) URL/OAuth regression: `bun test tests/spotify.test.ts tests/spotify-e2e.test.ts --timeout 30000`.
Auth/session regressions: `bun test tests/auth.test.ts tests/sessions.test.ts`.

The 2026-10-17 keyboard regression is covered by `tests/input-mode.test.ts`,
Files deep search in `tests/navigation-browser.test.ts`, CodeMirror save in
`tests/e2e.test.ts`, and real published Seed UI submission in `tests/voice.test.ts`.
Those browser suites use isolated fake services and generated local fixtures.

Mac tar resource forks (`._*`) are metadata, not build inputs. The prebuilt installer ignores them while fingerprinting every content input and served asset; it still refuses genuine added/changed files. Browser suites should run separately from fleet builds (`bun test tests --timeout 30000`) to avoid startup timeouts on the shared Mac.

The 2026-10-18 session lifecycle checks are in `tests/afterglow-navigation.test.ts`
and `tests/navigation-browser.test.ts`. `RetainedView` mounts Applications and Desk
on their first visit, keeps their own params while hidden, and makes them inert.
`ApplicationFrames` retains only visited frame documents; hidden frames cannot own
the active title or route. The auth gate still disposes these authenticated sessions.
The screen-remote view hides the main shell instead of disposing media/voice owners.
Live smoke checks exercise the installed Afterglow wrapper with a local intercepted
child fixture, keeping production media and saved state untouched.

The TV runtime also reserves Space for the visible live Desk’s
push-to-talk control. Its global activation handler must not swallow that hold,
and hidden Desk controls must not receive keys from another view.

Editor/Seed failure and rapid-transition regressions are in `tests/navigation-browser.test.ts`;
Afterglow canonicalization and single-history checks are in `tests/afterglow-navigation.test.ts`.
Run the whole main suite with `bun test tests --timeout 30000`.


## 2026-10-22 Network Map checks and current source split

`bun test tests/network-navigation.test.ts --timeout 30000` exercises the production
bundle with read-only telemetry, including encoded node IDs, directed measurements,
selection swaps, missing hosts, delayed responses, title cleanup and authentication.
`CYBERDECK_TEST_UI=/path/to/exact/dist/ui` selects a captured installed-tree build.
`CYBERDECK_TEST_ORIGIN=<private-tunnel> CYBERDECK_TEST_TOKEN_HOST=<ssh-alias> bun scripts/check-network-navigation-live.ts`
checks actual served routes in a separate browser and rejects all API writes. Omit the
token host for local Yacht. It does not run a network benchmark or use a kiosk context.

The October 19–21 Editor/Vault/Casework lifecycle patches were recovered from the
isolated worktrees, reconciled against current main, and reverified on 2026-10-25.
Their older installed overlays and rollback history remain evidence only; current
fleet availability is recorded in the latest Deck run report.

Remaining: the nested Commander states listed below; Seed titles for URL-supplied
external servers and nested-file errors; the rest of the error/lifecycle matrix;
native/physical-device cases. Current pending hosts are recorded in the run report. This inventory is not an
app-wide acceptance claim. Network URLs describe an inspection, never a test command.


Seed metadata title checks: `bun test tests/seed-titles-browser.test.ts tests/seed-navigation.test.ts tests/navigation-browser.test.ts --timeout 30000`.
The browser fixture runs the actual published Seed UI, synthetic signed CBOR reads and
fake entity metadata. It rejects message/create/run/trigger mutations. Tests cover direct
links, nested tabs, new tabs, reload/history, focus refresh, late names across routes/nodes,
authentication cleanup, and cancellation before a follow-up metadata signature.
`CYBERDECK_TEST_UI=/path/to/exact/dist/ui` selects an installed-tree build.

`CYBERDECK_TEST_ORIGIN=<private-tunnel> CYBERDECK_TEST_TOKEN_HOST=<ssh-alias> bun scripts/check-seed-titles-live.ts`
verifies actual named agents where a live Seed identity/server is available. It allowlists
read-only signed actions and rejects other API writes; no agent is started or messaged.
Offline/no-identity hosts are reported as unavailable rather than treated as live passes.
Title lookups use only the selected node's configured server; they never sign extra
requests for an arbitrary server URL carried in a link. Existing Seed navigation and
session components retain their original ownership and are not remounted for titles.

Sessions checks: `bun test tests/navigation-browser.test.ts tests/seed-titles-browser.test.ts`.
The fixture covers filter/form destinations, defaults, fresh/history restoration, delayed
selected owners, backend errors, unknown machines, title cleanup and Seed session titles.
`CYBERDECK_TEST_ORIGIN=<private-tunnel> CYBERDECK_TEST_TOKEN_HOST=<ssh-alias> bun scripts/check-term-navigation-live.ts`
checks installed form/filter/history/error routes without attaching to a terminal or
creating a process. No-peer hosts report that live destination coverage is unavailable.


## 2026-10-23 generic embedded bridge

`bun test tests/embedded-navigation.test.ts --timeout 30000` runs the actual public
adapter in a separate-origin child against the built Cyberdeck UI. It checks direct
links/new tabs/reload, canonical defaults, one-entry navigation, no-op/replace,
Back/Forward, delayed renders, hidden session retention, origin/source/request
validation, stale titles, errors, explicit reload and authentication cleanup.
Use `CYBERDECK_TEST_UI` for a captured installed-tree build. The adapter is opt-in;
this does not claim Commander or arbitrary third-party apps adopted it. Afterglow's
protocol and source remain unchanged. See `docs/EMBEDDED-NAVIGATION.md` for the
child integration contract and the limitations of independent history writers.


## 2026-10-24 Commander adoption and measured source state

Commander has a tested implementation of the generic adapter for canonical query
routes, title updates and parent-owned history. Starlight went offline during this
run; client activation and live verification remain pending. Its child is shared by
the fleet; updating its
client assets does not require rebuilding Cyberdeck or restarting either service.
The child waits for a trusted parent before mounting a default view. Opening an
embedded trainer/replay link therefore does not initialize a game/account first.
Trusted parent origins are an explicit build configuration, never a URL parameter.

Covered child state: room invitations, replay and tactic-recording identifiers,
replay run inspection, workshop tabs/run inspection, community source/kind/ladder/
search/page, trainer tabs/matches/experiments/filter/search/limit/log worker.
Errors have matching titles and retain requested identifiers. The live Commander
seat/board and latest replay/recording owner survive internal view changes;
hidden boards ignore game keys. Links never join, leave or issue game commands.

The October 26 follow-up covers workshop tactic/version/history/editor selection,
trainer match decisions/perspectives, replay frames/perspectives and remote
invitations/session selection. Remaining Commander states are listed in that section. The adapter is
implemented; this is not deployment confirmation, full child-view coverage or app-wide acceptance.

`Commander/e2e/navigation.spec.ts` serves the actual built child and, when
`CYBERDECK_UI` is supplied, this built parent with synthetic HTTP/Socket.IO data.
Run `CYBERDECK_UI=/path/to/Cyberdeck/dist/ui bunx playwright test --config navigation.config.ts`
in the Commander checkout. It covers direct/reload/new-tab links, canonicalization,
Back/Forward, one-entry edits, rapid transitions, hidden sessions/playback, late
metadata, wrong source/origin messages and authentication disposal. No production
game or account is used by these fixtures.

`CYBERDECK_TEST_ORIGIN=<loopback-tunnel> CYBERDECK_PARENT_ORIGIN=<trusted-private-origin> CYBERDECK_TEST_TOKEN_HOST=<ssh-alias> bun scripts/check-commander-navigation-live.ts`
checks the installed Commander observatory through a real Cyberdeck parent. It
blocks API writes and all game connections, uses only trainer reads, and confines
the token to its parent origin. Omit the token host for Yacht. The separate generic
fixture verifier and Afterglow suite remain unchanged.

The October 24 capture found all seven hosts reachable. Yacht, Starlight, Enuc,
Iris, Sentinel and Clipper had clean source at `37346df`; Botical retained sixteen
source overlays at its own revision. Five of the clean hosts served the exact
new main UI artifact. Earlier Editor/Vault/Casework retention overlays remain in
the October 19–21 snapshots and Botical. Current main supersedes those exact owned
hunks after the 2026-10-25 reconciliation; do not reapply an older whole overlay.
See the Deck run reports for source fingerprints and rollback backups.


## 2026-10-24 Seed memory metadata errors

Memory titles check the selected file against its parent directory metadata, with
no second content download. Missing files/directories, directories used as files,
denied access and unavailable metadata get honest titles while preserving the URL.
Focus refresh detects deletion, and stale directory replies cannot rename another
route, node or authentication screen. A successful metadata lookup followed by a
file-content failure remains outside this title helper's coverage.

`bun test tests/seed-titles-browser.test.ts tests/seed-navigation.test.ts --timeout 30000`
covers these cases against the real published Seed UI and built Cyberdeck client,
using synthetic metadata and signatures. `CYBERDECK_TEST_UI` selects an exact host
build. `scripts/check-seed-titles-live.ts` verifies installed titles/history/reload
with authenticated read-only metadata and a deliberately nonexistent file path;
no agent, session, trigger or memory mutation is permitted.


## 2026-10-26 Commander nested selections

The shared Commander client now restores workshop tactic/version/history/editor,
trainer match decision/seat, replay frame/player perspective and remote invitation
server/room links through the existing origin/source/request-bound bridge. Browser
Back/Forward creates one selection entry and preserves mounted boards, clocks and
unsaved workshop drafts. Hidden trainer inspectors cannot handle Escape or rename
another view. A fresh replay never starts playback; elapsed playback time remains
runtime state, while Pause and Copy link capture the current position. A delayed
saved-game response cannot take over Home after closing a directly opened replay.

The configured private HTTPS parent origins and their existing private HTTP/alternate
port variants are explicit build inputs. The adapter still rejects arbitrary parents;
no wildcard/referrer trust or public endpoint was introduced. Afterglow is unchanged.

Commander checks: `CYBERDECK_UI=<Cyberdeck>/dist/ui bun x playwright test --config navigation.config.ts`;
`bun x vitest run tests/generals.test.ts tests/replays.test.ts tests/tactic-api.test.ts tests/tactics.test.ts tests/trainer.test.ts`;
`CI=1 bun x playwright test e2e/tactics.spec.ts e2e/generals.spec.ts e2e/trainer.spec.ts e2e/community.spec.ts`.
The navigation suite uses synthetic game/account data; the remote session test intercepts
the WebSocket protocol and never contacts public matchmaking.

`scripts/check-commander-navigation-live.ts` now grants private-network permission only
in its fresh browser context, avoids logging authenticated request exceptions, and
checks a real archived match's decision/perspective when available. It blocks all writes
and game sockets. Missing archives are reported as unavailable; selected missing-match
errors are always checked. The run report records exact deployment and host results.

Recorded views and inspectors now restore decision timelines and input/source/lifecycle
disclosures. Replay inspectors publish decision/frame/perspective in one transition;
explicit frame links win during restoration, including frame zero. Hidden inspectors
with the same recording ID cannot become navigation/title owners. Title cleanup checks
the last writer so a completed parent load cannot erase a nested error title.

Remaining Commander coverage: trainer Live-card perspective; in-game tactic/menu selections; remaining
per-view failures. Remaining Cyberdeck coverage: Seed successful-metadata/content-read
failures and external-server title limits, PDF native-original/annotation cases, transcript/draft
semantics and native/physical-device cases. App-wide acceptance remains incomplete.


## 2026-10-27 PDF previews

The Editor's PDF preview now owns `page` (one-based), `zoom` (`fit`, `width`, or
25–400 percent) and `rotate` (0/90/180/270) in its existing node/path URL. Page one,
fit width and zero rotation have no query parameter. Malformed/default values
replace once; valid pages beyond the document length retain a shareable missing-page
view. Controls push one entry and no-op changes push none. Reload/new tabs and
Back/Forward restore the same page, zoom, rotation and node with matching titles.

A lazy, pinned PDF.js renderer replaces the nested browser plug-in history owner.
Documents remain loaded per node/path across primary views, other files and peers;
page/zoom changes do not refetch the file. Render cancellation and separate canvases
prevent old work from painting another selection. The preview supports selectable
page text. Passwords remain transient, survive ordinary retained-view navigation,
and are required again after refresh/lock; they never appear in links. Original
file controls (printing, forms, full-document search, annotations/bookmarks) remain
available through **Open original** in a separate browser tab. Those native-viewer
controls are not synchronized into Cyberdeck's parent route; this is not a claim
of complete native PDF viewer coverage.

File metadata distinguishes missing files, directories and unknown machines before
loading. Content failure after successful metadata, denied access, corrupt PDFs,
offline machines, retries and stale replies have explicit view/title coverage. The
serving node's 401 locks only its active view; a hidden failure cannot lock another
view, and a peer's denial does not discard the serving identity. The selected node
owns every request. File bytes use authorization headers rather than tokens in the
PDF renderer URL. Worker, fonts, CMaps and decoder assets are versioned and served
locally; no external PDF service or document script is used. [PDF.js rendering API](https://mozilla.github.io/pdf.js/examples/).

Repeatable tests: `bun run typecheck && bun run build`, then
`bun test tests/pdf-navigation.test.ts --timeout 30000`. The suite generates original
three-page content and includes an original password-protected copy (password
`fixture-password`; generated with pypdf's RC4-128 solely to exercise the reader).
Use `CYBERDECK_TEST_UI` for an exact captured host build, and optionally
`CYBERDECK_TEST_ARTIFACTS` to save the fit-width/rotated screenshots. No user's PDF
is used by the fixtures. Existing editor/media/bridge regression suites still apply.

Installed check:
`CYBERDECK_TEST_ORIGIN=<private-loopback-tunnel> CYBERDECK_TEST_PDF=<run-dir>/navigation.pdf CYBERDECK_TEST_TOKEN_HOST=<ssh-alias> bun scripts/check-pdf-navigation-live.ts`.
Create only the original fixture from `tests/fixtures/navigation-pdf.ts` in this run's
artifact directory; omit token host on Yacht. This check uses real installed assets,
worker and authenticated filesystem reads. It rejects writes, external requests,
non-fixture PDF reads and all WebSocket connections, and checks a deliberately
nonexistent path for the missing-file title. It never attaches to a kiosk or terminal.

Deployment adds the pinned `pdfjs-dist` dependency and Vite asset packaging, plus
only the PDF viewer, its scoped styles/types and the Editor integration. Exact
captured source groups are built separately, fingerprinted, backed up and activated
by atomic index replacement. Old hashed assets remain available to existing tabs.
No daemon or active session restart is necessary. See the current run report for
actual hosts, rollback paths and pending rollout status. App-wide acceptance remains
incomplete; retain the routine until the complete checklist is satisfied.
