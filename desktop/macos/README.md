# Casework for macOS

Standalone Apple Silicon client, installed at `~/Applications/Casework.app`. Opens fullscreen by default; `open -a Casework --args --windowed` opts out for a launch. Requires macOS 14+, a local Cyberdeck daemon and its existing `~/.cyberdeck/token`. The app never copies that credential to a remote node.

```sh
bash desktop/macos/install.sh
bash desktop/macos/install-games.sh
open ~/Applications/Casework.app
```

The native SwiftUI/AppKit launcher, Afterglow catalog/library/series pages, remote keyboard and AVKit player have no web renderer. Native Games uses ARM64 RetroArch and checksum-pinned Libretro cores. N64 uses ParaLLEl with the Ari64 dynamic recompiler and Glide64; the Mupen64Plus-Next/OpenGL-core path produced black frames on Clipper and is not selected. Web-only applications, full Cyberdeck and Afterglow's YouTube/music/playlists/advanced functions use an explicitly labelled, on-demand WebKit compatibility view. This is not a full native port of every app or the Expo server-delivered React Native modules. Compatibility navigation covers ordinary HTML controls; arbitrary canvas games still need their own gamepad implementation.

## Controller

- D-pad/left stick moves; A selects; B returns; Y or Home goes to Casework; X opens search.
- Shoulder buttons page through grids. Search has an on-screen keyboard, including Delete/Clear/Done; a physical keyboard also works.
- Video: A toggles play; left/right and shoulders seek 10s; up/down adjust volume; X mutes; Start opens the player menu (captions, 30s seek, stop). B closes the menu or video.
- Native game: Home or Back+Start requests a graceful exit and returns to Casework. Only these return controls are handled in the background while Casework owns the emulator; normal gameplay buttons are left to RetroArch. Saves belong to `~/Library/Application Support/Casework/{Saves,States}` and are not shared with browser saves. Steam opens Big Picture; Home/Back+Start returns without killing Steam.
- Keyboard: arrows, Return, Escape, Home, Space, M (player menu), F (fullscreen), Cmd-Q.

Extended gamepads and micro gamepads use Apple's GameController framework. Siri Remote has not been physically verified. A paired iPad can later drive the same reducer over the existing Casework `/control` protocol: `casework.input {action:"left"|"right"|"up"|"down"|"select"|"back"|"home"|"menu"|"pause"|"search"|"previous"|"next"}` and `casework.status`. This release supplies the protocol, not an iPad remote UI.

## Data and playback

Afterglow's URL is discovered from `/api/applications`, never hardcoded to a hosting machine. Reads do not download titles; Watch explicitly uses the existing `/api/watch` queue. Existing files use `/api/playback`, original-time progress and HLS offsets. Native text subtitles use `/api/subtitles` with the track index from the playback response. Watch/download cancellation on the server, manual releases, playlists and YouTube remain in Full Afterglow. The private stream service and original media stay on Botical.

Games discovers a paired node with the existing Vault API (currently Enuc), falling back to local saved games when offline. Explicit Play downloads/copies into Casework's own library on Clipper; source files and source saves are retained. `~/Games/<system>` is also scanned. NES, SNES, N64, GB, GBC, GBA, Genesis, SMS and GG are supported; 2048 runs without a ROM. Games run locally, with no browser emulator or network streaming. `cores.json` pins official ARM64 downloads by archive and binary SHA256; an upstream change fails closed until reviewed. RetroArch uses a private stdin command pipe, with network commands disabled. Runtime/core licenses remain those of their upstream projects; binaries are installed, not checked into this repo.

## Verification

`python3 desktop/macos/smoke.py` exercises the running app's actual controller reducer, fullscreen, live API reads and text entry. It does not assert physical-controller behavior. The app exposes authenticated loopback-only `127.0.0.1:4778`: GET `/state`, GET `/snapshot` (only the app's own view), POST `/input {action}`, POST `/text {text}` (when the keyboard is open). These require the local Cyberdeck bearer token; do not print or copy it. No screen-capture or Accessibility privilege is required.

For video decode QA, launch with `--verify`: saved viewing positions are not changed; `/state` includes decoded-frame counts and GET `/video-frame` returns an actual AVFoundation frame. `game-screenshot` requests RetroArch's own framebuffer capture. These diagnostics are disabled in normal launches. Do not use Watch/download actions in smoke tests; play existing completed files or generated fixtures. Verification screenshots/logs remain outside the repository under Casework's Application Support folder.

Architecture references: [AVKit](https://developer.apple.com/documentation/avkit/avplayerview), [GameController](https://developer.apple.com/documentation/gamecontroller), [RetroArch CLI](https://docs.libretro.com/guides/cli-intro/). Source `controller.js` provides spatial focus and native keyboard handoff only inside compatibility views. The home screen never loads WebKit. The existing Casework icon is reused from the mobile client. Close compatibility views before measuring native idle memory/CPU.
