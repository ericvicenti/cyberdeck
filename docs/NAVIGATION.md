# Cyberdeck navigation coverage

Updated 2026-10-18. This is an implementation inventory, not a completion claim.
The nightly routine and fleet deployment status live in Deck's
`handoff/routines/cyberdeck-navigation/2026-10-18.md`.

## Source and rollout status

The shared router, administrative views, Casework device selection and Cloud
bridge are now reconciled into main from this routine's exact owned patches.
The newer Seed and Desktop views are retained. Seed nested paths use the same
history writer, including replace notifications and node-preserving new-window
links; malformed and unknown nested paths render a not-found view. Services and
cmux now distinguish missing selections from ordinary content. Native keyboard
Enter/save events reach React and editors; the unmerged TV runtime receives the
narrow companion patch in `scripts/navigation-tv-keyboard.patch`.

Fleet installs still contain separate Vault/Spotify/controller overlays. Never
replace those trees wholesale from main. The 2026-10-17 packages capture each
host's exact source, merge only owned deltas, compile on Yacht and fingerprint
all UI/daemon inputs before activation. This also avoids Botical's build OOM.
The Deck report is authoritative for completed and pending deployments.

## URL contract

`#/view?key=value&node=<paired-id>` is authoritative. Missing `node` means the
serving machine, even when local storage remembers another machine. Existing
internal navigation carries `node`; explicit local/node links override it. The
server still authenticates every API/proxy request; node IDs are path-encoded.
Node-scoped components remount only when that node changes, not on query edits.
Applications, Spotify and the physical screen remote retain their existing
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
| `fleet` / Home | local/fleet overview, node links; pairing and account/reset dialogs; NetworkMap selected endpoints | Overview and node links covered. Pairing/reset/benchmark actions remain transient and must never auto-run. Decide URL representation for NetworkMap endpoint selection. |
| `controls` / Controls | control diagram, bindings/editor, reset notice | Static route/title covered where installed. Binding changes are settings, not navigation. Keyboard/gamepad mode preferences remain local. |
| `applications` / Applications | application id, Casework example, pairing dialog, reload | Id and unknown-id error/title covered. Pairing is an explicit operation. Visited generic iframe documents now survive primary-view, application and node navigation. Their nested reload/history/state/title still require cooperative bridges. |
| `applications?app=afterglow` / AfterglowFrame + BoticalMedia/public/navigation.js | child route, season/episode, search/filter, person dialog, music and YouTube state | Existing bridge retained: exact origin+source, parent-only history, route restoration, stable iframe, title cleanup. Browser regressions now prove document/timer continuity across primary views, other apps and node changes, plus hidden-message isolation and route/title restoration. A pending parent route rejects stale child acknowledgements. Missing, malformed and legacy child routes normalize with replace, preserving the iframe document and prior history. No production media is played by these checks. |
| `applications?app=vimm` / Vault | tabs, system, query, letter, page; selected retro title modal | Covered. `game=<catalog-id>` restores a detail from its shelf/catalog/list context on fresh open, reload and history without starting playback. Invalid tab/system/query/letter/page/game values normalize; missing IDs retain an honest error/title. My list and ready-to-play metadata remain browser-local by design. |
| VaultPlayer / vault download and storage | running emulator, ROM cache, save state, native N64 handoff, pause menu | Runtime session; do not replay Play/downloads from URL. Verify continuation across all relevant URL changes. Existing regression suites exercise generated fixture ROMs only. |
| SteamVault / Steam | selected game, PC tab, query; native install/game/session/cloud-save decisions | `steam=<id>` detail added, resolves from serving-node library, restores without Play. Game/cloud decision/quit remain runtime/confirmation actions. Keep background Steam/client/kiosk alive. |
| GamesSection / Games | installed native games and import form | Part of Applications. Play/import are actions; no automatic execution from links. |
| CaseworkConsole | selected device, events, camera/media/QR, calls, native scene actions | Selected device is covered by `device=<id>`, including canonical default, reload/history, missing-device error/title and no action replay. Device IDs are serving-node-local. Media preview URL semantics and call/session lifecycle still pending. |
| `spotify` / Spotify, SpotifyRecordings, SpotifyVisualizer | shelves, entities, query, pagination, recordings, immersive mode | Compact player (main, Yacht/Iris/Sentinel/Botical/Clipper): submitted `q` and loaded `playlists` page count restore through direct links, reload and history; stale search/page results are ignored. Rich player (Enuc/Starlight): `shelf`, `id`, `q`, `radio`, `page`, `immersive` retain the existing listening room. OAuth returns to requested content in both variants; no link starts playback. SDK/player stays mounted through URL and primary-view changes. `shelf=history&recording=<id>` now selects saved-audio details separately from Play. Fresh links/reload/history resolve local or node metadata without fetching audio or retrying uploads; missing/offline/no-account states have honest titles. A persistent audio owner survives shelf/detail/primary-view transitions. Enuc’s exact rich-player build is tested; Starlight’s deployment remains pending while offline. |
| `seed` / SeedAgents + published agents UI | agent/tab/trigger/memory, session, run, server, node | Nested route canonicalization, malformed/unknown path errors, route-based titles, Back/Forward and node-preserving new-window links covered. Backend, identity and server failures keep accurate titles across nested routes, reload and node transitions; late failures cannot retitle another node. Human-readable async entity names and the remaining lifecycle matrix still need coverage. |
| `desktop` / Desktop | selected node and connection | Primary route/title and URL-selected node covered; connect/input/credentials remain explicit runtime actions. |
| `desk` / Desk + voice | Fleet/Services/Agents glance tab, voice call, transcript, setup, mute | `tab=services` / `tab=agents` restore from fresh links and history; default fleet ignores stale local preferences, invalid tabs replace to the default, and titles match. Tab transitions retain the voice subtree without reconnecting. Calls and permissions stay explicit. The call owner now stays mounted across primary views, node changes and screen-remote navigation. Voice requests stay on the serving daemon’s hub relay; idle configuration refreshes on return. Simulated live-room tests prove no disconnect/reconnect during navigation, release of push-to-talk when hidden, and disconnect on authentication lock. Real calls/microphones are not used by tests. |
| `projects` / Projects | selected project, nested slug, unassigned repos, query | URL selection, canonical default, filter, title, missing project covered. Nested slugs use the same `p` key. Editing launches Files/Editor. |
| `agents` / Agents | task focus, run, log file, session query/host/tool, handoff disclosure, project prefill | Covered, including late search suppression. Task selection defaults to its run. Follow-scroll preference and launch/task drafts remain transient. Missing tasks/runs/logs have matching errors and titles; log content is keyed to run/file so failed or late requests cannot display another selection. Invalid log names canonicalize to worker.log. Backend failure titles are covered by the same ownership rules; broader session lifecycle checks remain. |
| `services` / Services | host and service focus | Existing URL parameters retained; legacy Home `service` links fixed centrally. Missing host/service selections and unavailable backend now have matching titles and visible errors. Start/restart/log commands remain explicit. |
| `data` / Data | root filter, repo query | Covered. Scans are actions; table has a fixed 100-item cap, not a pageable UI. |
| `files` / Files, TreeNode, dialogs | path, hidden files, sort/order, query, deep search, File Info modal | Covered, including stale listing/deep-search protection. Multi-selection, expanded tree folders, clipboard, rename/chmod/delete/import drafts stay transient; assess any desired navigable selection separately. Failed directory/info has a matching title. |
| `edit` / Editor | file path, text/media/markdown, playlist; video transport mode, loop/shuffle | Path/title reconstruct content; empty paths and missing text have accurate views/titles. Loading and save results are scoped to the current file/editor, including rapid transitions; stale results cannot overwrite another file or clear its unsaved indicator. Media failure titles and preserving media/unsaved edits across primary-view changes remain; playback preferences stay runtime state. |
| `term` / Term, TermPane, SeedPane, PromptBar | node/session, new-session form, cwd prefill; transcript pagination | Default selection replaces; explicit session/node links push once; invalid session and title covered. Links never create a process. Daemon session persistence covered in existing E2E. Transcript pagination/draft and backend error details remain. |
| `cmux` / Cmux | surface, scrollback, creation form | Surface/scrollback URL/default/title covered. Polling screen response guarded. Workspace creation, input and desktop focus are explicit actions. Missing surfaces have a not-found state/title and never poll a nonexistent terminal. Backend unavailable has its own title. |
| `cloud` / Cloud + RemoteBrowser | profile, target URL, archive query, provider+conversation | Covered. Remote URL/title state mirrors into the parent route after a request acknowledgement; initial profile state cannot overwrite direct links, redirects replace the requested URL, page/user navigation pushes once, and Back/Forward restores without remounting the persistent browser. The UI settles unacknowledged state for older daemons during rolling updates. Missing profiles, invalid target URLs and unavailable browsers show matching errors/titles before any browser socket is opened. |
| `remote` / ScreenRemote | physical screen connection, text/scroll mode, remote buttons | Static route/title; captures server kiosk, which has its own navigation. Do not attach normal Playwright to active kiosk (it changes emulated focus); only noDefaults/raw CDP for future physical verification. |
| Standalone player documents | `/vault-player.html`, newer installed `/spotify-player.html` | Internal player/SDK transports, not independently reconstructable media links. Preserve their authenticated message channels; represent navigable content in their parent view. `/samples/:name` serves media bytes, not a view. |
| Markdown / Widgets / PromptBar / VolumeControl | rendering, panel links, new-run draft, session strip, volume | No independent routes. Session strip links now encode node and session in a single transition. Input/volume are actions/preferences. |

## Repeatable verification and deployment

Build first: `bun run typecheck && bun run build`.
Read-only real-browser fixtures:
`bun test tests/navigation-browser.test.ts tests/afterglow-navigation.test.ts`.
Steam/Vault fixture regressions:
`bun test tests/steam-browser.test.ts tests/vimm-browser.test.ts`.
Casework selected-device navigation is exercised by the kitchen-sink case in
`bun test tests/e2e.test.ts` (this host may need a larger timeout while Seed
development renderers are saturating the CPU).
Real sandboxed daemon regression: `bun test tests/e2e.test.ts` (includes generated
shell/files and isolates daemon home; does not control installed sessions).
Cloud archive/browser history and rolling-protocol regressions are in
`bun test tests/cloud.test.ts tests/navigation-browser.test.ts`.
Compact Spotify URL/OAuth regression: `bun test tests/spotify.test.ts tests/spotify-e2e.test.ts --timeout 30000`. Rich-player checks use the captured host build and the 2026-10-16 listening-room fixture suite (see the run report). `scripts/navigation-rich-spotify.patch` preserves the owned rich-player delta separately because that larger player is not yet on main.
Auth/session regressions: `bun test tests/auth.test.ts tests/sessions.test.ts`.
Installer conflict/rollback checks: `bun test tests/navigation-install.test.ts`.
Live read-only checks: `CYBERDECK_TEST_ORIGIN=<private-origin> bun scripts/check-navigation-live.ts`.
Set `CYBERDECK_TEST_STEAM=1` on Enuc to check title links without Play.
Loopback Yacht reads its token inside the process; `CYBERDECK_TEST_TOKEN_HOST=<ssh-alias>`
can read a remote token inside the process for an SSH tunnel. No token is logged.
The script blocks all non-GET API requests and uses a separate headless browser.

`install-navigation.py --package <package> --check` prepares a three-way merge of
this run's before/after files into each installed clone. Installation backs up
owned source files and the existing UI, typechecks, builds into a staging folder,
checks for concurrent UI edits, copies assets, then atomically swaps index.html.
It retains old hashed assets for open pages and never restarts services or reloads
kiosks. Conflicts abort before writes. Failed validation restores owned source
and leaves the old UI serving. `--rollback <backup>` verifies that no newer edit
would be overwritten, then restores source and the old entrypoint.


For exact prebuilt deployments, use `scripts/install-navigation-built.py` with a
per-host package (`manifest.json`, `after/`, `ui/`). It checks all source inputs
and served-asset hashes, backs up the existing source and UI, preserves old
chunks, and atomically activates index.html without restarting. `--check`
performs validation only; `--rollback <backup>` refuses newer source/UI edits.
Tests: `bun test tests/navigation-built-install.test.ts`.

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

Rich saved-recording changes are isolated in `scripts/navigation-recordings.patch`
because the complete listening-room UI is still an installed overlay. Apply only
after reconciling that overlay; never replace the richer player with main’s compact
player. Run `CYBERDECK_TEST_UI=/path/to/exact/dist/ui bun test
scripts/recordings-browser.test.ts --timeout 30000` for standalone browser fixtures:
encoded detail IDs, reload/new tab/history, missing/offline/account boundaries, mobile
layout and generated local audio continuing through shelf/primary-view transitions.
The fixture blocks external networking and uses synthetic credentials/media only.

The TV keyboard companion patch also reserves Space for the visible live Desk’s
push-to-talk control. Its global activation handler must not swallow that hold,
and hidden Desk controls must not receive keys from another view.

Editor/Seed failure and rapid-transition regressions are in `tests/navigation-browser.test.ts`;
Afterglow canonicalization and single-history checks are in `tests/afterglow-navigation.test.ts`.
Run the whole main suite with `bun test tests --timeout 30000`; the standalone rich
recordings fixture under `scripts/` requires its own exact rich-player build.
