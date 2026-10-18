#!/usr/bin/env bash
# reset_demo.sh — roll the live dashboard back to the Q3-only state before a demo.
# Removes every CSV in data/ except the Q3 file, resets the manifest, commits, pushes,
# and waits until GitHub Pages is serving the Q3-only manifest.
#
# Usage (Git Bash): ./reset_demo.sh
set -euo pipefail
cd "$(dirname "$0")"

KEEP="demovets_synthetic_q3_2026.csv"
[ -f "data/$KEEP" ] || { echo "data/$KEEP is missing; aborting." >&2; exit 1; }

for f in data/*.csv; do
  [ "$(basename "$f")" = "$KEEP" ] && continue
  git rm -q --cached "$f" 2>/dev/null || true
  rm -f "$f"
  echo "Removed $f"
done
printf '{\n  "files": [\n    "%s"\n  ]\n}\n' "$KEEP" > data/manifest.json

git add -A data
if git diff --cached --quiet; then
  echo "Already in the Q3-only state; nothing to push."
else
  git commit -q -m "Reset demo to Q3-only data"
  git push -q
  echo "Pushed. Waiting for GitHub Pages to publish..."
fi

REMOTE="$(git remote get-url origin)"
OWNER="$(echo "$REMOTE" | sed -E 's#.*github\.com[:/]([^/]+)/.*#\1#' | tr '[:upper:]' '[:lower:]')"
REPO="$(echo "$REMOTE" | sed -E 's#.*/([^/]+)$#\1#; s#\.git$##')"
URL="https://$OWNER.github.io/$REPO/"
START=$(date +%s)
for i in $(seq 1 60); do
  M="$(curl -fsS "${URL}data/manifest.json?t=$(date +%s%N)" 2>/dev/null || true)"
  if echo "$M" | grep -q "$KEEP" && [ "$(echo "$M" | grep -c '\.csv')" -eq 1 ]; then
    echo "Live site is Q3-only after $(( $(date +%s) - START ))s: $URL"
    echo "Reload the dashboard (or click \"Refresh data\") before the demo."
    exit 0
  fi
  sleep 5
done
echo "Pushed, but Pages still shows the old manifest after 5 minutes. Check the repo's Actions tab." >&2
exit 2
