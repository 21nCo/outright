#!/usr/bin/env bash
set -euo pipefail

exec node /Users/serro/Documents/dev/n/agent/automation/linear-loop/pr-settle-gate.mjs \
  --config /Users/serro/Documents/dev/n/agent/automation/linear-loop/projects/outright.json
