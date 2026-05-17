#!/bin/zsh
set -euo pipefail

REPO_DIR="/Users/xp/vibecoding/pilipili"
PLIST_SRC="$REPO_DIR/ops/com.xp.pilipili.telegram-channel-sync.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.xp.pilipili.telegram-channel-sync.plist"
LABEL="com.xp.pilipili.telegram-channel-sync"

mkdir -p "$HOME/Library/LaunchAgents"
cp "$PLIST_SRC" "$PLIST_DST"
launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
launchctl enable "gui/$(id -u)/$LABEL"
launchctl kickstart -k "gui/$(id -u)/$LABEL"
launchctl print "gui/$(id -u)/$LABEL"
