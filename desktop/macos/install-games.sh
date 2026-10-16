#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -d /Applications/RetroArch.app ]; then
  HOMEBREW_NO_AUTO_UPDATE=1 brew install --cask retroarch-metal
fi
python3 install-cores.py
