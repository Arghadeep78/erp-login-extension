#!/bin/bash
# Registers the native messaging host so the extension can launch it.
# Usage: ./install.sh <extension-id>
# (Get the extension ID from brave://extensions or chrome://extensions
# after loading the unpacked extension with Developer Mode on.)
set -euo pipefail

EXT_ID="${1:?Usage: ./install.sh <extension-id>}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_NAME="com.erpautologin.helper"

case "$(uname)" in
  Darwin)
    # macOS TCC silently blocks browsers from exec'ing anything inside protected
    # folders — the host dies before its first line with "Native host has exited".
    case "$DIR" in
      "$HOME/Desktop/"*|"$HOME/Documents/"*|"$HOME/Downloads/"*)
        echo "ERROR: this project is inside a macOS-protected folder ($DIR)." >&2
        echo "Browsers cannot launch native hosts from Desktop/Documents/Downloads." >&2
        echo "Move the project elsewhere (e.g. ~/erp-auto-login) and re-run." >&2
        exit 1
        ;;
    esac
    TARGET_DIRS=(
      "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
      "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
      "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
      "$HOME/Library/Application Support/com.operasoftware.Opera/NativeMessagingHosts"
      "$HOME/Library/Application Support/Vivaldi/NativeMessagingHosts"
    )
    ;;
  Linux)
    TARGET_DIRS=(
      "$HOME/.config/google-chrome/NativeMessagingHosts"
      "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
      "$HOME/.config/microsoft-edge/NativeMessagingHosts"
      "$HOME/.config/opera/NativeMessagingHosts"
      "$HOME/.config/vivaldi/NativeMessagingHosts"
    )
    ;;
  *)
    echo "Unsupported OS. On Windows, run native-host\\install.ps1 instead — see README." >&2
    exit 1
    ;;
esac

for TARGET_DIR in "${TARGET_DIRS[@]}"; do
  mkdir -p "$TARGET_DIR"
  sed \
    -e "s#REPLACED_BY_INSTALL_SCRIPT_PATH#$DIR/run_native_host.sh#" \
    -e "s#REPLACED_BY_INSTALL_SCRIPT_EXTID#$EXT_ID#" \
    "$DIR/$HOST_NAME.json" > "$TARGET_DIR/$HOST_NAME.json"
  echo "Installed host manifest to: $TARGET_DIR/$HOST_NAME.json"
done

echo "Done. Reload the extension and try the popup button."
echo "Diagnostics log: ~/Library/Application Support/erp-auto-login/host.log"
