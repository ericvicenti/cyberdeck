#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
app="${CASEWORK_APP_PATH:-$HOME/Applications/Casework.app}"
build=$(mktemp -d)
trap 'rm -rf "$build"' EXIT
swiftc -O -whole-module-optimization -parse-as-library Support.swift Captions.swift Compatibility.swift Casework.swift Cinema.swift SpotifyAuth.swift Music.swift AudioBands.swift SystemAudio.swift MusicVisuals.swift PlayerControls.swift Main.swift -o "$build/Casework" -framework Cocoa -framework SwiftUI -framework AVKit -framework GameController -framework Network -framework MediaPlayer -framework WebKit -framework ScreenCaptureKit -framework Accelerate -framework Security -framework CryptoKit
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
if [ -e "$app/Contents/MacOS/Casework" ]; then
  backup="$HOME/Library/Application Support/Casework/backups/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$backup"
  cp "$app/Contents/MacOS/Casework" "$backup/Casework"
fi
cp controller.js "$app/Contents/Resources/controller.js"
cp "$build/Casework" "$app/Contents/MacOS/Casework"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Casework</string>
<key>CFBundleIdentifier</key><string>com.casework.cyberdeck.native</string>
<key>CFBundleName</key><string>Casework</string>
<key>CFBundleDisplayName</key><string>Casework</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSScreenCaptureDescription</key><string>Casework listens to this Mac’s system audio to display a live visualizer. Video is not stored.</string>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
<key>NSSupportsAutomaticGraphicsSwitching</key><true/>
</dict></plist>
PLIST
if [ -f Casework.png ]; then
  mkdir -p "$build/Casework.iconset"
  for n in 16 32 128 256 512; do
    sips -z "$n" "$n" Casework.png --out "$build/Casework.iconset/icon_${n}x${n}.png" >/dev/null
    double=$((n * 2))
    sips -z "$double" "$double" Casework.png --out "$build/Casework.iconset/icon_${n}x${n}@2x.png" >/dev/null
  done
  iconutil -c icns "$build/Casework.iconset" -o "$app/Contents/Resources/Casework.icns"
  /usr/libexec/PlistBuddy -c 'Add :CFBundleIconFile string Casework' "$app/Contents/Info.plist"
fi
codesign --force --sign - "$app"
codesign --verify --deep --strict "$app"
printf 'Installed %s\n' "$app"
