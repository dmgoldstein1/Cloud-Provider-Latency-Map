#!/usr/bin/env bash
# import_run.sh - point at the newest netlat.sh run by symlinking
# data/netlat/latest -> scripts/runs/run-<id>.
# Usage: ./scripts/import_run.sh [scripts/runs/run-<id>]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -n "${1:-}" ]; then
  LATEST="$1"
else
  LATEST="$(ls -dt "$ROOT/scripts/runs"/run-* 2>/dev/null | head -1 || true)"
fi

if [ -z "$LATEST" ] || [ ! -f "$LATEST/manifest.json" ]; then
  echo "usage: $0 [scripts/runs/run-<id>]" >&2
  echo "no completed netlat.sh run found (needs manifest.json + *_matrix.csv)" >&2
  exit 1
fi

[ -f "$LATEST/latency_matrix.csv" ] || { echo "error: $LATEST/latency_matrix.csv missing" >&2; exit 1; }

mkdir -p data/netlat
ln -sfn "$(basename "$LATEST")" data/netlat/latest
echo "linked $LATEST -> data/netlat/latest"
