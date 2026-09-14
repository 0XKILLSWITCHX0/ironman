#!/usr/bin/env bash
# Pulls your Canvas class feed down locally as classes.ics (gitignored —
# the URL contains a personal access token, never commit it).
# Run this whenever your class schedule changes, then re-run generate-ics.js.
set -euo pipefail
cd "$(dirname "$0")"
source .env
curl -sf "$CLASS_ICS_URL" -o classes.ics
echo "Wrote classes.ics"
