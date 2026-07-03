#!/bin/bash
# Launched by Chrome/Brave via native messaging. Execs the venv's python
# directly (no `source activate` — that script hardcodes the venv's creation
# path and breaks if the project moves; python itself resolves the venv from
# pyvenv.cfg next to the binary). stdin/stdout carry the framed messages, so
# all diagnostics go to the log file.
LOG="$HOME/Library/Application Support/erp-auto-login/host.log"
mkdir -p "$(dirname "$LOG")"
echo "=== $(date) started ===" >> "$LOG"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$DIR/../.venv/bin/python3" "$DIR/native_host.py" 2>> "$LOG"
