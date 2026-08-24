#!/usr/bin/env bash
#
# Flug deploy: push the src/ code into your Google Apps Script project.
#
# One-time prerequisites on your machine (not in a remote sandbox — this
# needs to open a browser to log into YOUR Google account):
#   1. Node.js installed
#   2. npm install            # gets clasp locally
#   3. npx clasp login        # opens a browser; authorize with your Google account
#
# Then, from the repo root:
#   ./deploy.sh
#
# The first run creates a new standalone Apps Script project bound to your
# account and writes .clasp.json (gitignored). Later runs just push changes.
# After the first deploy, finish setup in the Apps Script editor:
#   - Run the `setup` function once (grants permissions, schedules the scan)
#   - Paste your Chat webhook URL into Script Properties → CHAT_WEBHOOK_URL
# See README.md for the full checklist.

set -euo pipefail

CLASP="npx clasp"

if ! $CLASP --version >/dev/null 2>&1; then
  echo "clasp not found. Run 'npm install' first (it installs clasp locally)." >&2
  exit 1
fi

# clasp stores the login token at ~/.clasprc.json.
if [ ! -f "$HOME/.clasprc.json" ]; then
  echo "Not logged in to clasp. Run 'npx clasp login' first (opens a browser)." >&2
  exit 1
fi

if [ ! -f ".clasp.json" ]; then
  echo "No .clasp.json yet — creating a new Apps Script project 'Flug'..."
  # Note: `clasp create --rootDir src` can write .clasp.json inside src/
  # instead of the repo root, which then breaks `clasp push`. So we create
  # the project, read the scriptId back, and write a correct root .clasp.json
  # ourselves — robust across clasp versions.
  create_out="$($CLASP create --type standalone --title "Flug" --rootDir src 2>&1)"
  echo "$create_out"

  script_id="$(printf '%s\n' "$create_out" | grep -oE 'script\.google\.com/d/[A-Za-z0-9_-]+' | head -1 | sed 's#.*/d/##')"
  # Fall back to whatever clasp wrote, wherever it landed.
  if [ -z "$script_id" ] && [ -f src/.clasp.json ]; then
    script_id="$(grep -oE '"scriptId" *: *"[^"]+"' src/.clasp.json | head -1 | sed -E 's/.*"scriptId" *: *"([^"]+)".*/\1/')"
  fi
  if [ -z "$script_id" ]; then
    echo "Could not determine the new scriptId from clasp output. Check the URL above and create .clasp.json manually (see README)." >&2
    exit 1
  fi

  rm -f src/.clasp.json
  printf '{"scriptId":"%s","rootDir":"src"}\n' "$script_id" > .clasp.json
  echo "Wrote .clasp.json (scriptId=$script_id, rootDir=src)."
fi

echo "Pushing src/ to Apps Script..."
$CLASP push --force

cat <<'DONE'

Pushed. Finish in the Apps Script editor (run `npm run open`):
  1. Run the `setup` function once and grant permissions.
  2. Script Properties → set CHAT_WEBHOOK_URL (and any other overrides).
  3. Run `dryRun` to sanity-check detection, then `sendTestMessage`.
DONE
