# Casework for macOS

Standalone Apple Silicon client, installed at `~/Applications/Casework.app`. Opens fullscreen by default; `open -a Casework --args --windowed` opts out for a launch. Requires macOS 14+, a local Cyberdeck daemon and its existing `~/.cyberdeck/token`. The app never copies that credential to a remote node.

```sh
bash desktop/macos/install.sh
bash desktop/macos/install-games.sh
open ~/Applications/Casework.app
```

The native SwiftUI/AppKit launcher, Afterglow poster shelves/library/series pages, remote keyboard and AVKit player have no web renderer. Afterglow opens directly into Ready to watch, film and series shelves; selecting a downloaded film or episode starts playback without a second Play screen. Native Games uses ARM64 RetroArch and checksum-pinned Libretro cores. N64 uses ParaLLEl with the Ari64 dynamic recompiler and Glide64; the Mupen64Plus-Next/OpenGL-core path produced black frames on Clipper and is not selected. Web-only applications, full Cyberdeck and Afterglow's YouTube/music/playlists/advanced functions use an explicitly labelled, on-demand WebKit compatibility view. This is not a full native port of every app or the Expo server-delivered React Native modules. Compatibility navigation covers ordinary HTML controls; arbitrary canvas games still need their own gamepad implementation.

## System-audio visualizer

The **Visualizer** tile on Casework's home screen works without Spotify: it analyzes audio playing on this Mac from any app. Afterglow → Music → Visualizer (or V) uses the same capture; Spotify metadata is only used for the transport/title, never for audio samples. The fullscreen circular spectrum uses ScreenCaptureKit system-audio capture and Accelerate FFT, decays to stillness in silence, and honors Reduce Motion. Capture starts on entry and stops on exit. On first use macOS asks for Screen Recording permission; if denied, grant Casework access in System Settings → Privacy & Security → Screen & System Audio Recording, restart Casework, then press Retry. Streaming from a different computer is not captured: playback must actually reach Clipper's audio output. Do not run `install.sh` over a running Clipper app; build/test in a separate app path first.

## Controller

- D-pad/left stick moves; A selects; B returns; Y or Home goes to Casework; X opens search.
- Shoulder buttons/triggers page through grids. Back/Options returns; stick clicks open search (left) or the menu (right). Search has an on-screen keyboard, including Delete/Clear/Done; a physical keyboard also works.
- Video: D-pad selects the visible transport controls; A activates the highlighted control. With controls hidden, A toggles play and left/right seek 10 seconds. Up/down reveal controls; shoulders/triggers always seek 10 seconds. X mutes; Start opens More; B closes the menu or video. The seek bar, volume, captions, play/pause and fullscreen buttons are clickable. Controls fade after four seconds of playback and remain visible while paused.
- Native game: Home or Back+Start requests a graceful exit and returns to Casework. Only these return controls are handled in the background while Casework owns the emulator; normal gameplay buttons are left to RetroArch. Saves belong to `~/Library/Application Support/Casework/{Saves,States}` and are not shared with browser saves. Steam opens Big Picture; Home/Back+Start returns without killing Steam.
- Keyboard: arrows, Return, Escape, Home, Space/K (play/pause), J/L (seek), M (mute), C (captions), F (fullscreen), O (More), Cmd-Q. Native text fields retain ordinary typing, cursor movement, selection and clipboard shortcuts.

The last device used owns the presentation: controller input shows button hints and virtual keys; physical keyboard or mouse input hides gamepad hints. Typing replaces the virtual keyboard with a native field, preserving pending text and the first key. The controller can take over again without clearing text. Compatibility views follow the same rule. `ui/public/input-mode.js` supplies the shared web behavior for Cyberdeck/Games and is mirrored into Afterglow; `desktop/install-input-mode.py` installs it into existing richer host UI bundles and kiosk bootstrap imports without replacing those bundles. Existing web tabs need one reload.

Extended gamepads and micro gamepads use Apple's GameController framework. Siri Remote has not been physically verified. A paired iPad can later drive the same reducer over the existing Casework `/control` protocol: `casework.input {action:"left"|"right"|"up"|"down"|"select"|"back"|"home"|"menu"|"pause"|"search"|"previous"|"next"}` and `casework.status`. This release supplies the protocol, not an iPad remote UI.

## Data and playback

Afterglow's URL is discovered from `/api/applications`, never hardcoded to a hosting machine. Reads do not download titles; Watch explicitly uses the existing `/api/watch` queue. Existing files use `/api/playback`, original-time progress and HLS offsets. Native text subtitles use `/api/subtitles` with the track index from the playback response. Watch/download cancellation on the server, manual releases, playlists and YouTube remain in Full Afterglow. The private stream service and original media stay on Botical.

Games discovers a paired node with the existing Vault API (currently Enuc), falling back to local saved games when offline. Explicit Play downloads/copies into Casework's own library on Clipper; source files and source saves are retained. `~/Games/<system>` is also scanned. NES, SNES, N64, GB, GBC, GBA, Genesis, SMS and GG are supported; 2048 runs without a ROM. Games run locally, with no browser emulator or network streaming. `cores.json` pins official ARM64 downloads by archive and binary SHA256; an upstream change fails closed until reviewed. RetroArch uses a private stdin command pipe, with network commands disabled. Runtime/core licenses remain those of their upstream projects; binaries are installed, not checked into this repo.

## Verification

`python3 desktop/macos/visual-smoke.py` uses Vision OCR on actual app snapshots to catch stale cards independently of model state. `controls-smoke.py` (requires `--verify`) posts native key events into this app’s event loop and verifies virtual-to-physical text handoff, controller restoration, transport focus/seek and auto-hide. Wired Xbox D-pad/A/B events were observed on Clipper during the 2026-10-16 fix; the user confirmed video playback.

`python3 desktop/macos/smoke.py` exercises the running app's actual controller reducer, fullscreen, live API reads and text entry. It does not assert physical-controller behavior. The app exposes authenticated loopback-only `127.0.0.1:4778`: GET `/state`, GET `/snapshot` (only the app's own view), POST `/input {action}`, POST `/text {text}` (when the keyboard is open). These require the local Cyberdeck bearer token; do not print or copy it. No screen-capture or Accessibility privilege is required.

For video decode QA, launch with `--verify`: saved viewing positions are not changed; `/state` includes decoded-frame counts and GET `/video-frame` returns an actual AVFoundation frame. `game-screenshot` requests RetroArch's own framebuffer capture. These diagnostics are disabled in normal launches. Do not use Watch/download actions in smoke tests; play existing completed files or generated fixtures. Verification screenshots/logs remain outside the repository under Casework's Application Support folder.

Architecture references: [AVKit](https://developer.apple.com/documentation/avkit/avplayerview), [GameController](https://developer.apple.com/documentation/gamecontroller), [RetroArch CLI](https://docs.libretro.com/guides/cli-intro/). Source `controller.js` provides spatial focus and native keyboard handoff only inside compatibility views. The home screen never loads WebKit. The existing Casework icon is reused from the mobile client. Close compatibility views before measuring native idle memory/CPU.

## Spotify in native Afterglow

Music opens a native SwiftUI listening room: the existing Afterglow Spotify shelf,
account playlists/albums/liked songs, catalog search, playlist tracks, queue, Connect
device selection, play/pause, next/previous, shuffle/repeat, volume and scrubbing.
D-pad/A/B navigate every action; Start pauses, shoulders change tracks, X searches.
Space/K and J/L control playback; pointer and physical typing hide controller hints.
Starting a film pauses music started through Casework. Music can continue while browsing.

**Connect Spotify** opens the existing Spotify OAuth application in the system browser.
Casework uses PKCE and saves its own renewable login in macOS Keychain. Closing the
browser does not disconnect the player. Account → Disconnect removes this Mac's saved
login; Connect Spotify can reconnect or change accounts. First-time login still requires
Spotify's browser consent. The existing signed-in Cyberdeck browser bridge remains a
fallback until you establish a native login; no browser credentials are copied.

The authenticated daemon hands off a one-time authorization code through
`/api/spotify/native/*`, using the existing `http://127.0.0.1:4777/` redirect. Codes expire
in ten minutes, are claimed once, and never enter persistent state or Casework events.
The PKCE verifier and access/refresh tokens stay in the native process/Keychain. Native
requests refresh automatically, coalesce simultaneous renewals, and honor rate limits.

Playback uses the chosen Spotify Connect device. Clipper is selected automatically only
when its Spotify app is available; other speakers require an explicit device selection.
Sign into Spotify on Clipper once for local audio. The existing public Cyberdeck client ID
is reused; no new developer app is needed. Premium/Spotify access restrictions still
apply. The native UI has no embedded Spotify browser or DRM implementation. The separate
Afterglow web application's saved-link embed remains its existing player.

`music-fixture.py` serves isolated provider responses on loopback4779. Only the combination
`--verify --music-fixture` enables that backend; `music-smoke.py` exercises actual native
navigation and transport commands without changing Spotify or Afterglow account data.
Restore `spotify-device`/`spotify-device-name` preferences after fixture runs. The browser
bridge also has an isolated real-Chromium test for authentication, command delivery,
plain-text Spotify mutation replies, rejected routes and credential non-disclosure.

## Electric Sky visualizer

Music includes a native Canvas visualizer: five flowing circular spectrum ribbons,
with a full rainbow and soft colored halos. The rings expand with captured audio energy. Choose **Visualizer** with the controller or mouse, or press
**V**, for the immersive view; **B/Escape** returns to the library without stopping music.
D-pad/A still select the transport controls, Start pauses, and shoulders change tracks.
Search leaves the immersive view and opens the normal input-aware search field.
Animation is capped at30fps, freezes while paused/inactive, and respects Reduce Motion.
Its spectrum follows local system audio through ScreenCaptureKit and Accelerate FFT;
Spotify Connect provides track/transport metadata, not PCM. See the capture permission
and standalone Visualizer instructions above.

Native authorization checks (use a temporary executable; no real account needed):

```sh
swiftc -parse-as-library Support.swift SpotifyAuth.swift spotify-auth-test.swift -o /tmp/casework-spotify-auth-test -framework AppKit -framework GameController -framework Network -framework Security -framework CryptoKit
/tmp/casework-spotify-auth-test
# From repository root:
bun test tests/spotify-native.test.ts
```
