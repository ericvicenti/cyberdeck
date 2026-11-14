# Cyberdeck navigation coverage

Updated 2026-11-14. This is an implementation inventory, not a completion claim.
The nightly routine and fleet deployment status live in Deck's
`handoff/routines/cyberdeck-navigation/2026-11-14.md`.

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
| `storage` / Storage | node, filesystem and mount identify a volume; loading, last reading, errors and retry | Added to this inventory after the November 12–13 storage changes. Canonical explicit `node=self`, first-value singleton parameters, direct/reload/new-tab/history restoration and both identity fields are covered (November 14). Missing, invalid, unpaired/offline, denied, unavailable and malformed reads have owned titles. Peer reads wait for fleet discovery; delayed/overlapping reads cannot restore old errors, replace newer readings, rename another view or lock another node. Retry retains the URL; a failed refresh preserves a visibly marked last reading. |
| `controls` / Controls | control diagram, bindings/editor, reset notice | Static route/title covered where installed. Binding changes are settings, not navigation. Keyboard/gamepad mode preferences remain local. |
| `applications` / Applications | application id, Casework example, pairing dialog, reload | Id, unknown-id and unavailable-listing errors/titles covered; failed lookups retain the requested link instead of showing an ordinary app list. Pairing is an explicit operation. Visited generic iframe documents now survive primary-view, application and node navigation. Opt-in generic SPA navigation now restores root-relative child routes/titles via an origin/source/request-bound bridge and keeps one history owner. Commander has a bridge integration for its main views, trainer tabs/inspectors/filters, workshop tabs/run inspection, community directory and active-match menu/chat/help/workshop. Replay reads now distinguish missing, denied, unavailable and invalid content; directory reads have route-bound error titles, retry and hidden-response protection. Match/decision archive reads now validate selected identities, page data and rendered board shapes; missing/denied/unavailable/invalid outcomes retry at the same URL without replacing the inspector or issuing commands (November 10). Other malformed responses and real remote-match availability still need coverage. Unsupported nested links in noncooperating apps report a restoration error. See `docs/EMBEDDED-NAVIGATION.md`. |
| `applications?app=soniq` / Soniq | studio track/scene/bar/step, steps/piano editor, library query/category/source/offset, project and export dialogs | Clipper's Studio cooperates with the retained frame for track/scene/bar/step, editor mode, library visibility/query/category/source/page/sample, and the Projects dialog/selected snapshot. Direct links, reload, new tabs, Back/Forward and truthful errors/titles are covered. Links select snapshots without loading them; only Load selected snapshot changes the project. Project list loading, denied/unavailable reads, retry and late-response isolation are covered. A real AudioContext with a verified silent sink survives dialog/history/primary-view changes. External project changes retain selected IDs with honest errors; delayed load/import completions cannot reset a later selection or navigation round trip. Invalid-link recovery uses parent history and retains the same iframe. Piano-roll octave 0–8 now restores through canonical links, reload and history; the default 4 is omitted. Nondefault visible ranges name the title, and switching editors retains the selected range without changing notes or audio ownership. Starlight's separate older prototype is preserved. |
| `applications?app=afterglow` / AfterglowFrame + BoticalMedia/public/navigation.js | child route, season/episode, search/filter, person dialog, music and YouTube state | Existing bridge retained: exact origin+source, parent-only history, route restoration, stable iframe, title cleanup. Browser regressions now prove document/timer continuity across primary views, other apps and node changes, plus hidden-message isolation and route/title restoration. A pending parent route rejects stale child acknowledgements. Missing, malformed and legacy child routes normalize with replace, preserving the iframe document and prior history. No production media is played by these checks. |
| `applications?app=vimm` / Vault | tabs, system, query, letter, page; selected retro title modal | Covered. `game=<catalog-id>` restores a detail from its shelf/catalog/list context on fresh open, reload and history without starting playback. Invalid tab/system/query/letter/page/game values normalize; missing IDs retain an honest error/title. My list and ready-to-play metadata remain browser-local by design. |
| VaultPlayer / vault download and storage | running emulator, ROM cache, save state, native N64 handoff, pause menu | Play retains the selected game detail URL, while fresh links and reloads show details without starting or downloading a game. The owner survives app, primary-view, node and screen-remote navigation. Hidden games leave the modal top layer, release keyboard/controller handlers and cannot steal focus or titles. Resume returns to the existing core; explicit Save & exit completes it. Real NES homebrew fixtures prove continuity and responsive save/exit. Native N64/gamepad hardware remains unverified. |
| SteamVault / Steam | selected game, PC tab, query; native install/game/session/cloud-save decisions | `steam=<id>` detail added, resolves from serving-node library, restores without Play. Game/cloud decision/quit remain runtime/confirmation actions. Selected PC-game links now show loading, denied/unavailable reads, unsupported machines and missing-game states with matching titles. Retry preserves history; overlapping polls cannot replace a newer read or trigger a stale lock. Keep background Steam/client/kiosk alive. |
| GamesSection / Games | installed native games and import form | Part of Applications. Play/import are actions; no automatic execution from links. |
| CaseworkConsole | selected device, events, camera/media/QR, calls, native scene actions | Selected device is covered by `device=<id>`, including canonical default, reload/history, missing-device error/title and no action replay. Visited consoles retain their socket, calls and previews across apps, primary views, node URLs and history; lock tears them down. `media=<stored-name>` fetches only an existing authenticated upload: fresh open, reload and history never capture, upload or autoplay. Invalid, missing and denied previews have matching errors/titles. Tests use synthetic devices/tracks only. |
| `applications?app=afterglow&tab=music` / Spotify (the listening room), SpotifyRecordings, SpotifyVisualizer | shelves, entities, query, pagination, recordings, immersive mode | One player everywhere, inside Afterglow: `shelf`, `id`, `q`, `radio`, `page`, `immersive` and `shelf=history&recording=<id>` restore through direct links, reload and history; OAuth returns to the requested content, including saved recordings; read failures and unavailable pages retain the link with an honest title and read-only retry. Late or hidden reads cannot replace another view; no link starts playback; the SDK/player stays mounted through URL and primary-view changes. Legacy `#/spotify` links are rewritten. |
| `seed` / SeedAgents + published agents UI | agent/tab/trigger/memory, session/message/tool/prompt, list pages, run, server, node | Nested paths, canonical defaults/errors, Back/Forward and node-preserving new-window links covered. Titles observe the displayed authenticated reads, including external servers; late responses are bound to the signing host/account, server and entity. Session message/prompt/tool inspectors and full tool input/output restore without replacing the transcript or composer. Agent session-list page counts restore and retry. Global/server list rounds and sub-session disclosures also restore (November 9). Server account/provider read dialogs restore through `dialog=accounts|providers`, with route-owned loading/errors and retry (November 10); write forms and credentials stay transient. Expanded transcript tool groups and recorded message Context popovers restore in Seed and Sessions (November 10). Run Code/Activity/full-entry disclosures restore from URLs and history (November 11). Run Tool calls open/collapsed state and root/child error popovers restore with displayed-read titles and graph retry (November 14). Other transcript/workflow disclosures and attachment state, plus older-message history outside returned events, remain. |
| `desktop` / Desktop | selected node and connection | Primary route/title and URL-selected node covered; connect/input/credentials remain explicit runtime actions. |
| `desk` / Desk + voice | Fleet/Services/Agents glance tab, voice call, transcript, setup, mute | `tab=services` / `tab=agents` restore from fresh links and history; default fleet ignores stale local preferences, invalid tabs replace to the default, and titles match. Tab transitions retain the voice subtree without reconnecting. Calls and permissions stay explicit. The call owner now stays mounted across primary views, node changes and screen-remote navigation. Voice requests stay on the serving daemon’s hub relay; idle configuration refreshes on return. Simulated live-room tests prove no disconnect/reconnect during navigation, release of push-to-talk when hidden, and disconnect on authentication lock. Real calls/microphones are not used by tests. |
| `projects` / Projects | selected project, nested slug, unassigned repos, query | URL selection, canonical default, filter, title, missing project covered. Nested slugs use the same `p` key. Editing launches Files/Editor. |
| `agents` / Agents | task focus, run, log file, session query/host/tool, handoff disclosure, project prefill | Covered, including late search suppression. Task selection defaults to its run. Follow-scroll preference and launch/task drafts remain transient. Missing tasks/runs/logs have matching errors and titles; log content is keyed to run/file so failed or late requests cannot display another selection. Invalid log names canonicalize to worker.log. Backend failure titles are covered by the same ownership rules; broader session lifecycle checks remain. |
| `services` / Services | host and service focus | Existing URL parameters retained; legacy Home `service` links fixed centrally. Missing host/service selections and unavailable backend now have matching titles and visible errors. Start/restart/log commands remain explicit. |
| `data` / Data | root filter, repo query | Covered. Scans are actions; table has a fixed 100-item cap, not a pageable UI. |
| `files` / Files, TreeNode, dialogs | path, hidden files, sort/order, query, deep search, File Info modal | Covered, including stale listing/deep-search protection. Multi-selection, expanded tree folders, clipboard, rename/chmod/delete/import drafts stay transient; assess any desired navigable selection separately. Failed directory/info has a matching title. |
| `edit` / Editor | file path, text/media/markdown, playlist; video transport mode, loop/shuffle | Path/title reconstruct content; empty paths and missing text have accurate views/titles. Documents are retained per node/path across files, primary views and history, preserving unsaved buffers, undo and media. Saves capture a revision and cannot clear later edits; duplicate saves are serialized. Requests and delayed media events stay bound to the original node. Hidden ended/error events cannot navigate or retitle another view. Explicit playlist selection pauses the old track; ordinary navigation leaves playback intact. Drafts remain in memory until tab close, refresh or lock. PDF previews now restore page/zoom/rotation, typed failures and passwords through the parent route (see October 27). Persisted media playback position/preferences remain outside this slice. |
| `term` / Term, TermPane, SeedPane, PromptBar | node/session, new-session form, cwd prefill; transcript pagination | `filter` selects the tab-strip machine (`self` = serving node, absent = every machine); `target` selects the New form destination independently of the underlying session node. Both restore on reload/new-tab/Back/Forward, and selecting a session retains its filter. Default selection waits for its owner and replaces once; offline/unknown nodes have distinct errors, delayed peers do not become false missing sessions. Seed session links use authenticated entity titles. Links never create a process. Daemon persistence covered in existing E2E. Filtered links now default within their selected machine; unknown filters, fleet lookup errors and failed/denied lists preserve honest URLs and titles. Older overlapping polls cannot replace newer content or trigger stale locks. New-session drafts survive view/history changes in memory per machine and cwd prefill; refresh/lock clears them. Explicit Open preserves newer drafts and never redirects a different view when it finishes. Terminal disconnect, exit and lost states now have matching titles; reconnect needs no route write or process restart. Seed transcript controls and deeper attachment failure diagnostics remain. |
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

Remaining Commander coverage: in-game tactic/menu selections; remaining
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


## 2026-10-29 Sessions filters, failures and drafts

A `#/term?filter=<node>` link with no session defaults only within that machine;
`filter=self` means the serving machine. An explicit `node` still takes priority
for default selection, and an explicit session keeps its own owner independently
of the tab filter. Defaults replace once. An empty selected machine opens its own
New form; unknown machines, failed reads and failed Seed listings do not silently
select another machine or imply there are no sessions. Valid local sessions stay
usable when fleet metadata is unavailable. Errors have matching titles and Retry.

Session reads keep per-machine request revisions: an explicit session event can
supersede a pending read, while ordinary polling lets slow reads finish. Late
content, errors and 401s cannot replace a newer result. Unpaired peers cannot
reappear from delayed reads. Local 401s lock based on HTTP status, including
messages other than “Unauthorized”; peer denials leave the local identity intact.
Existing selected terminals stay attached during filter-only navigation and polling.

The New form's command and working-directory drafts are held only in the authenticated
shell's memory, keyed by destination machine and URL cwd prefill. They survive
Back/Forward and primary-view navigation; they do not cross machines or appear in
URLs, history state or browser storage. Refresh, fresh tabs and lock start from the
link's prefill. Only explicit **Open** creates a process. A pending Open cannot be
submitted twice, erase a newer draft, or navigate away from a different view/target
when it finishes. Successful selection preserves the tab filter.

Repeatable checks: `bun run typecheck && bun run build`, then
`bun test tests/term-navigation.test.ts --timeout 30000` and the existing navigation,
embedded bridge, Seed and sessions regressions. The new suite uses synthetic lists,
inert sockets and explicit fake creation responses, never actual shells or messages.
`scripts/check-term-navigation-live.ts` checks installed assets and real fleet reads;
its failed-session response exists only in the fresh test browser. All WebSockets,
external requests and API writes are blocked. It verifies form destinations, history,
reload/new tabs, draft disposal, missing filters/machines and error-title cleanup.

Terminal attachment checks are in `bun test tests/term-navigation.test.ts --timeout 30000`:
the synthetic socket closes, reconnects and reports an exit; saved exit/lost links
reload with distinct titles while browser assertions
check the exact title, unchanged URL/history and cleanup on leaving Sessions. No
production terminal is opened or stopped by these checks.

The Seed UI package 0.1.11 has no host callback for its memory-content read outcomes
or transcript paging state. Its exported host/client/provider interfaces were audited
on this run. Accurate content-read failure titles and external-server titles need a
cooperative package API; do not infer success solely from parent-directory metadata,
monkey-patch global fetch, or replace the package's editor with a reduced viewer.
Commander in-game/errors, Soniq internal navigation, these Seed states, remaining attachment/native-device
cases and original-PDF controls remain outside completed acceptance. See the run
report for deployed hosts and exact verification; keep the routine enabled.

## 2026-10-30 Commander Live perspectives and terminal state titles

Commander's two Live trainer cards now use independent `localSeat` and `remoteSeat`
parameters. A missing key follows the current match's candidate seat; an explicit
seat stays selected through direct links, reload, new tabs and Back/Forward. Missing
snapshots retain requested seats, while out-of-range selections show an error and
matching title. The single Commander/Cyberdeck history owner remains unchanged;
selecting a perspective does not start or control a game. Commander client-only
deployment keeps the hosted server and existing game connections running. Its
synthetic standalone and embedded navigation suite covers both cards.

Sessions now distinguish `Disconnected`, `Exited` and `Lost` in the document title.
The first is the browser attachment state; the latter two come from the durable
session record or an exit event. Reconnecting changes neither the URL nor browser
history and does not restart the process. Production-bundle tests cover these
states and title cleanup after leaving Sessions.

## 2026-10-31 Commander live-match panels

Commander's active room URL now selects its game menu, help dialog and chat with
`panel=menu|help|chat`. The in-game tactic workshop uses the existing
`tactics`, `tactic`, `version`, `history` and `editor` parameters. The
single Commander/Cyberdeck history owner restores these selections on direct
open, refresh, new tab and Back/Forward without replacing the board or
reconnecting to the current match. A panel link with no active match retains
the requested URL and shows an unavailable title/error. Links never send chat,
run a tactic, make a move or surrender.

The Commander source lives on Clipper; its client-only overlay and backup are
recorded in the latest Deck run report. Repeat the synthetic standalone and
embedded checks from the exact captured Commander source:
`CYBERDECK_UI=<Cyberdeck dist/ui> bunx playwright test --config navigation.config.ts`.
The game controls and lobby suites use their own disposable server. Installed
navigation can be checked with
`CYBERDECK_TEST_ORIGIN=<Cyberdeck loopback tunnel> CYBERDECK_PARENT_ORIGIN=https://probe.vicenti.net CYBERDECK_CHILD_TRANSPORT=<Commander loopback tunnel> CYBERDECK_TEST_TOKEN_HOST=clipper bun scripts/check-commander-navigation-live.ts`;
that checker blocks writes and game sockets.

The remaining gaps are the Commander per-view error matrix, Soniq internal
navigation, Seed memory-content and transcript outcome hooks, and the original
PDF/native/attachment cases listed above. A fresh browser can restore panel
selection only if the game service can resume that browser's live seat.

## 2026-11-01 Soniq Studio selections

Clipper's richer Soniq Studio now uses the generic embedded-navigation version 1
adapter for track, scene, bar, step, steps/piano editor and library visibility.
The child writes its own history only when opened standalone; inside Cyberdeck,
the parent owns each URL entry and title. Its route is `/studio` with omitted
defaults and zero-based scene/bar/step parameters. Invalid or missing selections
keep their link and show an honest title. The private child checks the exact
parent origin and source; restoring a link does not play audio or edit notes.
The Studio's `/studio` static fallback supports standalone fresh opens. A
read-only live check on Clipper exercised direct links, one entry, Back, reload
and retained iframe with no API writes or page errors, while the service PIDs
and stopped audio transport were preserved.

Soniq's source and tests are in Clipper's non-Git clean snapshot
`~/Code/Soniq-nav-20261101` and backed-up narrow overlay; see its
`docs/NAVIGATION.md` and the Deck run report for repeatable checks and rollback.
The remaining Soniq state is library query/category/source/page and selected
sample, project browsing and snapshot switches. Starlight's older Soniq
prototype remains separate; it has not received this Clipper UI overlay.


## 2026-11-04 Soniq projects and Commander read failures

Soniq's library navigation from November 2 is installed; its Projects dialog
and selected snapshot from the unfinished November 3 run are now reconciled,
extended and deployed on Clipper. `dialog=projects&snapshot=<id>` opens a
selected snapshot without loading it. The explicit **Load selected snapshot**
button performs that command. Loading, missing selections, denied reads and
unavailable lists have matching visible states and titles. Retry reads the same
selection without a history entry. Aborted responses cannot replace a reopened
view or retitle another primary view. The installed read-only check covers
parent history, reload/new tabs, missing snapshots, retry and locked deep links.
No production audio or project writes are used. An isolated real AudioContext
with a verified non-audible sink retains its owner across history and primary
views. Repeat from Clipper's exact `~/Code/Soniq-nav-20261104` snapshot:
`npm test` and `npm run format:check`; the unchanged lockfile's dependency audit
still reports 11 moderate advisories. `node scripts/check-project-navigation-live.mjs`
from installed Soniq checks the running service without API writes.

Commander's replay reads now name missing, denied, unavailable and invalid
content distinctly. Directory failures bind their title to the exact source,
filter and page; Refresh retries without navigation. Hidden or late directory
responses cannot rename a replay, workshop or another primary view. Standalone
and embedded production-bundle cases cover direct links, reload, new tabs,
Back/Forward, retry and title cleanup. The workshop test now waits for the
parent's shareable editor URL before capturing it for reload.

The exact Commander snapshot on Clipper is `~/Code/Commander-nav-20261104`.
Repeat `bun run build`, `bun run test` and
`CYBERDECK_UI=~/.cyberdeck/src/dist/ui bunx playwright test --config navigation.config.ts`;
set the same explicit parent-origin build list recorded with its rollback
package. `scripts/check-commander-errors-live.ts` checks installed assets through
the configured origin with synthetic child APIs and blocked game sockets:
`CYBERDECK_PARENT_ORIGIN=https://probe.vicenti.net CYBERDECK_CHILD_TRANSPORT=http://127.0.0.1:4319 bun scripts/check-commander-errors-live.ts`.
No real account, match or command is created by that checker.

Both hosted apps are shared by every Cyberdeck instance. Their narrow source
packages and rollback backups are recorded in the Deck run report. Commander
activates only its client entrypoint and retains old chunks for open tabs;
Cyberdeck, Commander, Soniq, kiosk and terminal processes are not restarted.
Remaining acceptance includes Seed memory-content/external/transcript outcome
hooks, the rest of Commander's error matrix/live remote resumption, and the
native/attachment/original-file boundaries recorded above. Keep the routine
enabled until those cases are resolved.


## 2026-11-04 Steam library reads and restored Starlight UI

PC-game links keep their selected `steam` ID when a library read fails. Loading,
denied/unavailable reads, unsupported machines, missing games and invalid payloads
have visible, recoverable states and matching titles. Retry keeps the same URL
and history; a focus refresh cancels the older request, ordinary polls do not
overlap, and a stale 401 cannot lock newer content. Existing library/session data
remains mounted while a refresh fails. No link starts, stops or downloads a game.

`bun test tests/steam-navigation.test.ts --timeout 30000` uses synthetic Steam
lists and blocks commands and external artwork. It covers direct links, refresh,
new tabs, history, error recovery, stale reads, title cleanup and authentication.
The same seven cases pass against the exact Botical compiler tree, preserving
its distinct Term/voice overlay. The prebuilt installer fingerprints every source
input, backs up source/UI, keeps old chunks, and atomically activates the new
entrypoint without restarting services.

Starlight was reachable but served HTTP 404 because its October 31 build had left
no `dist/ui/index.html` or asset chunks. Its source matches the other current
hosts exactly. The deployment backs up its remaining assets and explicitly
records the absent entrypoint before restoring the verified build. Recovery and
rollback were rehearsed with isolated files before installation. All seven hosts
now pass the installed check, with daemon PIDs and managed session records
preserved. No hosts remain pending for this overlay.

Repeat installed checks with `bun scripts/check-steam-navigation-live.ts`;
`CYBERDECK_TEST_ORIGIN` selects a loopback tunnel and
`CYBERDECK_TEST_TOKEN_HOST` reads that host's token in process over SSH. All
Steam responses in this checker are browser fixtures; it blocks commands and
sockets, never reaches a Steam server, and leaves active clients untouched.

The existing HLS end-to-end fixture now scopes its selectors to the visible
Editor document. Earlier videos stay mounted intentionally; a selector matching
the old player waited until the short HLS clip advanced back to it, then read
its direct-playback status. The failure reproduces on the pre-change UI. Both
direct and HLS video cases pass with the selected document explicitly checked;
playback behavior is unchanged.


## 2026-11-05 listening room and Studio navigation

Music catalog failures distinguish denied access, content unavailable to the app,
rate limits and other read errors without substituting a previous shelf. Retry
keeps the exact URL and history position. Pages beyond an exhausted listing show
**Music page not found**. Route cleanup invalidates pending reads when leaving the
view. Saved-recording IDs survive the tab-local, state-verified Spotify OAuth
continuation; codes and tokens remain excluded. The visualizer scrolls with the
catalog so it cannot cover track navigation menus.

`bun test tests/spotify-e2e.test.ts tests/spotify.test.ts tests/music.test.ts --timeout 30000`
checks catalog/recording OAuth restoration, fresh tabs, reload/history, late reads,
error retry, unavailable pages, title cleanup and retained playback. The recorder
fixture uses original generated PCM, a verified silent AudioContext sink, and its
actual media clock; it never contacts Spotify or uses protected audio. Browser
tests are muted and allow normal user playback in production. Run browser suites
separately from production builds on shared hosts. `CYBERDECK_TEST_UI` selects an
exact captured build; `CYBERDECK_TEST_ORIGIN` checks installed loopback assets.
All application/Spotify APIs in this suite are intercepted fixtures, including
archive writes, so installed verification does not mutate production data.

Soniq's selected IDs remain in the URL when another client changes the project;
valid selections pick up new names and missing selections remain honest errors.
Load/import resets apply only to their originating navigation generation. A later
selection, including a round trip back to the same URL, wins. Invalid-link recovery
uses the existing adapter and retains the iframe. New standalone and embedded
regressions run on desktop and mobile; prior audio-owner continuity checks remain.
The current Deck report records exact source overlays, backups and pending hosts.
Seed content/transcript outcome hooks, residual Commander errors, Soniq piano-roll
octave range and native/device boundaries still prevent app-wide acceptance.


## 2026-11-06 Studio octaves, Commander read states and Seed content outcomes

Soniq's `octave` (0–8, default 4 omitted) now identifies the piano roll's twelve
visible keys. Its buttons, title, reload, fresh tabs and Back/Forward agree in
standalone and embedded views. The range remains selected when switching editors.
Invalid values retain their URL and show an error. Silent real-AudioContext tests
retain the same audio owner while navigating octaves, dialogs and primary views.

Commander workshop Account, tactic-library, version/history and run-list reads
now have accurate denied/missing/unavailable titles and read-only retry. Account
content does not depend on the tactic library; a failed run listing cannot look
like an empty successful result. Hidden list/version reads abort. Training summary,
live, worker-log and experiment reads also report their actual failure state;
retry retains the URL, history position and previously loaded content. Delayed
worker reads cannot rename a newer selection. The installed checker is
`scripts/check-commander-errors-live.ts`; all child APIs and game sockets are
fixtures, and only installed assets cross the private transport.

Cyberdeck pins an optional `SeedAgentsHost.onReadOutcome` extension to the published
`@seed-hypermedia/agents-ui` 0.1.11 through Bun's tracked `patchedDependencies`. The
small patch observes the memory query's rendered success/error state. It does not
replace the transport, add a content read, change signing or modify server trust.
`ui/lib/seed-read-outcome.ts` accepts only outcomes for the current host, account,
server, agent and file. It makes failed content reads override successful directory
metadata, while later files/nodes and primary views retain their own titles. The
existing metadata resolver still names successful files. Install with
`bun install --frozen-lockfile` before typecheck/build; keep the patch on dependency
upgrades until the same optional API is available upstream.

`bun test tests/seed-titles-browser.test.ts tests/seed-navigation.test.ts tests/navigation-browser.test.ts --timeout 30000`
uses the real patched Seed UI with synthetic signed read-only responses.
`CYBERDECK_TEST_UI` selects an exact local build; `CYBERDECK_TEST_ORIGIN` loads only
installed assets over a loopback tunnel. All Seed and Cyberdeck API responses are
local fixtures. No production identity signs, agent is messaged or session created.

Remaining: Seed transcript pagination/selection and transcript outcome hooks,
external-server entity names, deeper Commander malformed-payload and match/decision
retry cases, remote-seat fresh-browser availability, and the native/attachment/
original-viewer boundaries documented above. Starlight rollout status and exact
rollback locations are in the current Deck report. App-wide acceptance remains
incomplete; the routine stays enabled.


## 2026-11-07: Seed displayed reads and transcript content

Seed titles now follow the queries already displayed by the published UI: agents,
sessions, runs, triggers, session lists and memory directory/content outcomes.
Cyberdeck no longer sends separate title-only metadata requests. This also names
URL-supplied external-server content without adding signatures or changing the
existing signing/proxy boundary. Failed reads win over stale successful metadata;
callback ownership includes the signing host/account, server and entity.

The pinned optional host API remains a Bun patch on agents-ui 0.1.11. `routeUrl`
supplies canonical Cyberdeck session/message share links with the node retained.
`onReadOutcome` reports existing rendered queries; it performs no transport work.
Keep the patch through upgrades until upstream provides these APIs.

Nested session routes accept `panel=prompt` for the current system prompt and
`event=<message-id>[&panel=message]` for a selected message or its details dialog.
Back/Forward, refresh and a fresh tab restore these views. The Sessions host
uses the same `panel`/`event` state on `#/term?session=seed-<id>` and retains its
transcript owner. An absent message keeps
its link and shows an honest missing-content state/title. Transcript queries,
composer and streaming subscriptions remain mounted during these route changes;
opening a panel does not re-read a transcript, send a message or create a session.

Agent session lists use `pages=<2..100>` for the number of loaded pages. Back
collapses cached results, Forward restores them, and fresh links load the necessary
cursor pages in order. Invalid/default counts are removed with replace; exhausted
counts replace with the actual last page. Failed pages retain earlier results and
retry in place. Delayed pages cannot rename a later entity, node or primary view.

Repeat: `bun run typecheck`, `bun run build`, then
`bun test tests/seed-titles-browser.test.ts tests/seed-navigation.test.ts --timeout 30000`.
The production bundle and actual pinned dependency are driven in Chromium with
synthetic signed read responses. `CYBERDECK_TEST_UI=<exact dist/ui>` selects a
captured compiler tree; `CYBERDECK_TEST_ORIGIN=<loopback tunnel>` loads installed
assets while all API and signing responses remain fixtures.

Remaining acceptance: other Seed list/search/disclosure and attachment detail
states, full-transcript history outside the package's returned event window,
Commander deep malformed-payload/match/decision retry and remote-seat cases,
native devices/attachments and original-PDF viewer controls. These are separate
from today's completed Seed slice. The current Deck report records fleet receipts,
rollback paths and any pending hosts; do not infer app-wide completion here.

## 2026-11-08: Recorded tool inspectors and full payloads

Seed session routes now restore `panel=tool&tool=<call-id>` in the actual published
UI. `event` canonicalizes with replace to the displayed row containing that tool,
including grouped/collapsed thinking rows. Ordinary, status and continuation tool
inspectors use one dialog owner at the session root; continuation handoff details
retain their existing presentation. Missing calls retain honest links and errors.
These selections never execute a tool or follow a continuation automatically.

`full=input|output|both` selects recorded full payload reads for truncated content.
Each selection pushes once; Back restores the truncated version, Forward uses the
cached full read, and reload/new tabs read the same selected data. Non-truncated
and malformed selections normalize with replace. The existing signed
`GetSessionEvent` API supplies content; links cannot supply an arbitrary sequence.
Responses must match the session, sequence, event type and tool call. Missing,
denied, unavailable and malformed reads have matching views/titles and retry
without changing history. No title-only request is added.

Sessions uses the same state as top-level `panel`, `event`, `tool`, and `full`
parameters on `#/term?session=seed-<id>`, retaining its machine and filter. Both
hosts keep the transcript, composer and subscription owners mounted during
inspector/history changes. Late payload success/failure cannot rename another
call, session, machine, primary view or locked screen. Existing iframe bridges,
playback, terminals and games are unchanged.

Repeat `bun run typecheck`, `bun run build`, then
`bun test tests/seed-titles-browser.test.ts tests/seed-navigation.test.ts tests/term-navigation.test.ts --timeout 30000`.
The nine added browser cases use the production bundle, real pinned dependency
and synthetic read-only signed responses. `CYBERDECK_TEST_UI` selects an exact
artifact; `CYBERDECK_TEST_ORIGIN` loads installed assets through loopback while
all API/signing responses remain fixtures. Keep the agents-ui 0.1.11 Bun patch
through upgrades until the upstream host API supports the same behavior.

Remaining acceptance: Seed global/server list/search/disclosure, attachment
read/detail state and older-message history; Commander's deeper malformed/match/
decision retry and remote-seat matrix; native/device and original-file viewer
boundaries. This slice does not complete the routine. Fleet receipts, rollback
paths and any pending hosts are in today's Deck report.


## 2026-11-09: Global/server session lists and expanded parents

The global Seed list and individual server lists now use `pages=<2..100>` for
loaded cursor rounds. Each round reads every server that still has another page,
waits for those displayed reads, and deduplicates session identities per server.
“Load more sessions” pushes one entry; Back hides later cached rounds and Forward
restores them. Fresh links and refresh reconstruct the cursors in order. Invalid
or default counts normalize with replace; exhausted lists replace with the actual
last round. Failed later pages retain earlier rows and retry in place. Malformed
responses and repeated cursors produce a visible, retryable failure.

Global, server and agent session lists accept repeated `child=` selections,
encoded JSON `[server, parent-session-id]` pairs. `@host` identifies the selected
node's configured server without storing the browser's current proxy origin.
Selections are bounded, sorted and deduplicated. Only matching rendered parent
rows can expand or read child sessions; a link cannot introduce another server
or fetch an arbitrary parent. Missing parents keep their URLs and show an honest
error. A known parent whose child count has become zero still restores its selected
empty disclosure. Expanded children do not send a message, create a session or follow a run.

Titles observe the displayed lists and child reads, including loading, denied,
missing, unavailable and malformed outcomes. Independent expanded parents retain
independent failures. Ownership includes the signing host/account, server,
list/agent, page count and parent selection, so a delayed response cannot rename
Back, another page/node/view or the authentication screen. Child-list retries are
explicit; a swallowed published-package retry option is corrected. The list and
composer remain mounted during URL/history changes.

There is no dedicated search field on the published global/server lists. Model
and account/resource pickers are editable form controls; this change adds no new
search feature. Server account/provider read dialogs and their nested selections
need separate route ownership. Remaining Seed navigation also includes transcript/
thinking-group and other read disclosures, attachment details/errors, and selected messages
outside the returned event window. Commander deep read/decision failures and
remote seats, plus native/device/original-file boundaries, remain separate.

Repeat `bun run typecheck`, `bun run build`, then
`bun test tests/seed-titles-browser.test.ts tests/seed-navigation.test.ts tests/term-navigation.test.ts --timeout 30000`.
The actual pinned package and production UI run against synthetic signed reads;
`CYBERDECK_TEST_UI` selects an exact build and `CYBERDECK_TEST_ORIGIN` loads installed
assets through loopback. API/signature data stays synthetic. Keep the Bun patch
until the upstream route and host APIs provide this behavior. Today's Deck report
records exact artifacts, fleet backups, preservation checks and pending hosts.


## 2026-11-10: Server account/provider read dialogs

Seed server routes accept `dialog=accounts|providers` inside `r=server?url=…`.
Both server-page buttons and global server-menu shortcuts enter these canonical
routes. Opening or closing a dialog pushes once; Back/Forward, refresh and a fresh
tab restore the same server, dialog and signing node. Server list/page/disclosure
state remains in the route when opening from that list. The underlying list,
composer and subscriptions retain their owners during dialog navigation.

Titles observe the displayed signed ListModelProviders or ListSigningIdentities
read. Loading, missing, denied, unavailable and malformed outcomes have matching
content and titles. Empty lists appear only after a successful read. Explicit
retry uses the same URL and history entry. Late replies cannot rename a different
dialog, server, signing node, primary view or authentication screen. The pinned
package validates list shapes before rendering, and the host never makes a second
request solely for a title.

The published 0.1.11 dialogs have editable account rows and provider/add/import/
delete/sign-in forms, but no separate read-only account/provider detail or model
catalog disclosure. Those forms, drafts, credentials and confirmations remain
local; opening a URL does not submit, authenticate, import, delete or rename.
Reloading an Add provider form restores its parent providers list.

Repeat `bun run typecheck`, `bun run build`, then
`bun test tests/seed-titles-browser.test.ts tests/seed-navigation.test.ts tests/term-navigation.test.ts --timeout 30000`.
Browser tests drive the real pinned package and production bundle with synthetic
signed reads; `CYBERDECK_TEST_UI` selects an exact artifact and
`CYBERDECK_TEST_ORIGIN` loads installed assets through a loopback tunnel. All API
and signing responses remain fixtures. Keep the Bun patch pinned through upgrades.

Remaining Seed coverage includes transcript/thinking and other read disclosures,
attachment details/errors and selected messages outside the returned event
window. Commander deep failures/remote seats and native/device/original-file
boundaries remain separate. The current Deck report records exact artifacts,
rollback paths, preservation evidence and the concrete pending-host list.


### Expanded transcript tool groups

Session routes accept repeated `thinking=<first-recorded-tool-call-id>` values.
Selections are sorted, deduplicated, bounded to 100 groups/512 characters per ID,
and reject empty or control-character values. Seed stores them inside `r`; Sessions
uses the same repeated top-level key while retaining `session`, `node` and `filter`.
Expansion/collapse pushes once, and history restores the exact rendered groups
without replacing the transcript/composer or rereading a session. Refresh and a
fresh tab restore the same groups. Compact embedded chats retain local behavior.

Missing groups retain their link and show a matching error/title without fetching
an arbitrary event. Titles describe expanded groups while a modal's content owns
its own title. Opening inspectors retains expansion; message share links preserve
it and update after later toggles. Delayed transcripts cannot rename another
session/node/view or the locked screen. Other run/plan and read disclosures,
attachments and selected messages outside the returned event window remain open.

### Recorded message Context popovers

`panel=context&event=<message-id>` restores the recorded context that accompanied
a user message in Seed and Sessions. The existing popover retains its presentation;
its open/close state now pushes one entry and restores through refresh/new tabs
and history. Closing retains the message anchor. The selected node, Sessions
filter, transcript/composer and subscriptions survive these transitions.

Only context present in the displayed transcript can open. A missing message,
a message without context, or a system/assistant row keeps the requested URL and
shows a matching Context not found title/error without issuing an arbitrary event
read. A context panel without an event canonicalizes with replace. Late transcript
results cannot reopen a previous context or rename another session/node/view or
the locked screen. No current window is inspected, no context is captured, and no
message is sent when following these links. Tests use recorded synthetic lines.


Pointer dismissal of Context waits for the same click's host navigation. A primary
view or another message selection writes one entry and Back restores the open
popover. A plain outside click writes one close, while Escape/focus behavior and
compact nonnavigable embeds retain their normal behavior. Pending click handlers
are removed when their route owner closes or unmounts; lock cannot retain them.


### Commander match and decision archive reads

Clipper's current Commander source was captured separately from its serving
`~/.commander/web/client` installation. The untouched captured source rebuilt to
exactly the serving entrypoint with its existing trusted parent origins. The
verified four-file source overlay adds schema/identity checks for match metadata
and decision pages, read-only Retry match/Retry decisions controls and exact
loading/error titles. Rows must match their requested seat and page sequence;
malformed boards and outputs cannot crash the selected inspector. Retry preserves
its URL, history position and mounted owner. Explicit replay verification remains
a command and never runs from a URL or retry.

Standalone, Cyberdeck-embedded and protected Probe-parent fixtures cover missing,
denied, unavailable, malformed and non-JSON data, recovery, reload, stable owners,
page/perspective races and failures after hiding the inspector. The actual serving
assets can be selected with `COMMANDER_UI=~/.commander/web/client` in Commander's
navigation suite. Cyberdeck's `scripts/check-commander-errors-live.ts` now also
checks these installed error/retry paths over private loopback transports, with
synthetic child APIs and all game connections blocked. No production account,
match or order is created by the checks. Server and worker processes are retained.

Remaining acceptance: Seed workflow tool/source/activity/error and other read
disclosures, attachment details/errors and selected messages outside the returned
event window; other Commander malformed-payload and independent remote-seat
availability cases; native/device and original-file viewer boundaries. Starlight
must receive/reconcile the still-pending fleet overlay when it becomes reachable.

## 2026-11-11: Seed run Code and Activity disclosures

Seed run URLs now restore `code=1`, `activity=1`, and repeated `entry=<run-id:seq>`
inside the nested `r=run/<id>?…` route. Entry ids are deduplicated, sorted, bounded
at 100 and validated with the existing recorded-selection limits; selecting an
entry also opens Activity. Closing Activity clears its entry selections in the
same transition. Code and Activity can be open together. Each toggle adds one
history entry; Back/Forward retains the run page and existing subscription.
New tabs and refresh restore the server, signer node and selected disclosures.
Opening a link reads recorded content and never executes or cancels a run.

Titles observe the displayed run and disclosure state, including missing source,
read failures and activity that has not arrived. The live journal stream has no
completion marker: absent selected entries remain explicitly waiting instead of
being reported as missing. Historical journal availability and subscription
failure diagnostics remain an acceptance limitation. No extra journal request
or subscription is created for navigation or titles.

The actual patched package is covered by `tests/seed-titles-browser.test.ts`:
direct/reload/fresh-tab links, node selection, history/retained DOM, canonical
flags and bounded entries, unavailable source, read failures, delayed reads,
missing stream entries and lock cleanup. Other workflow tool/error/plan
selections, transcript attachments and older-window messages remain open;
Commander malformed/read-disclosure/live-seat and native/original-file cases
also remain. Keep the routine enabled until the full acceptance matrix passes.


## 2026-11-14: Seed run tool-list and error selections

Nested run routes accept `calls=open|closed` and `error=<run-id>`. The error can
belong to the displayed run or a descendant in its plan. Empty, oversized or
control-character selections are removed; duplicate singleton parameters use the
first value. Unknown error IDs stay in the URL with a missing-content state.
Explicit tool-list state survives journal updates; omitting it keeps Seed’s
existing automatic sizing. A selected empty tool list remains waiting because
the journal protocol has no completion marker.

The existing error popover and Tool calls control each push one transition;
Escape/outside dismissal clears the error selection. Back/Forward, refresh and
new tabs restore the same signer node, server and disclosures. The run graph and
journal remain mounted, with no repeated read or subscription from URL changes.
Other embedded transcript graphs retain local behavior until separately covered.

Error titles observe the displayed root and graph reads. Child graph loading,
denied/unavailable/malformed reads, missing selections and retry keep the requested
URL; a late response cannot reopen a closed selection or own another node/title.
Graph responses validate the selected root and basic entry shape. No run command,
resume, cancel, message or download is issued when opening these links.

Repeat: build, then `bun test tests/seed-titles-browser.test.ts --test-name-pattern
'Seed run selection' --timeout 30000`. The ten new Chromium cases include direct
links, reload/new tabs, history and retained owners, request/subscription counts,
canonical invalid links, graph failures/retry, delayed owner changes, lock cleanup,
and phone/desktop error-popover bounds. `CYBERDECK_TEST_ORIGIN` runs the same
read-only fixtures against installed assets through loopback SSH tunnels.

Remaining coverage: run tool inspectors/details and other transcript/workflow
plan disclosures, attachments/errors and older-message windows; Commander deep
read/live-seat cases; native/device/original-file boundaries. Journal availability
and subscription failures still need diagnostics. App-wide acceptance remains open.


## 2026-11-14: Storage volume restoration and read ownership

Storage is a new primary view added since the preceding inventory. Its canonical
URL is `#/storage?filesystem=<device-or-pool>&mount=<mount>&node=<paired-id-or-self>`.
Both volume identity fields must agree; a missing item never falls back to a
same-mount or same-device volume. Default and duplicate singleton parameters
replace in place, and absent/invalid selections keep useful states without disk
reads. Filesystem and mount strings preserve encoded spaces, slashes and query
characters. Unknown and offline peers are never probed by this view.

Each read/error belongs to the exact node and effect generation. Node changes,
retry, Back/Forward and leaving the view discard late completions. A newer poll
wins over an older request. A failed refresh retains the last reading with a
visible warning, accurate unavailable title and explicit retry; links never run
a rescan or cleanup. Peer reads wait for successful paired-node discovery; fleet
lookup failures can retry at the same link. Only an active serving-node 401 locks
the app. Other nodes' denials and late local denials cannot lock the active node.

`tests/storage-navigation.test.ts` covers the exact production bundle with nine
read-only Chromium cases: encoded direct/reload/new-tab/history links; canonical
and invalid URLs; missing/denied/unavailable/malformed reads and retry; delayed
node/view transitions; overlapping poll ordering and retained readings; local
versus peer authentication; paired-node discovery; legacy daemon compatibility; and phone/desktop error states.
Repeat after building with `bun test tests/storage-navigation.test.ts --timeout
30000`. `CYBERDECK_TEST_ORIGIN` selects installed assets over private loopback SSH.


On an endpoint-only 404, Storage reads the same node’s existing dashboard disk
snapshot. Botical’s long-running daemon requires this compatibility path. It
uses the same validation, owner and authentication guards; a 401/403/503 never
triggers a dashboard fallback, and navigation never restarts the daemon.
