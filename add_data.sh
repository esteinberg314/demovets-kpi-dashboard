#!/usr/bin/env bash
# add_data.sh — push a new CSV to the live dashboard.
#   1. copies the CSV into data/
#   2. adds it to data/manifest.json
#   3. commits and pushes
#   4. waits until GitHub Pages is serving it, then tells you to click "Refresh data"
#
# Usage (Git Bash, from anywhere):
#   ./add_data.sh                      # adds the October refresh file from staging/
#   ./add_data.sh path/to/other.csv    # adds any CSV with the same columns
set -euo pipefail
cd "$(dirname "$0")"

SRC="${1:-staging/demovets_synthetic_oct_2026_refresh.csv}"
[ -f "$SRC" ] || { echo "File not found: $SRC" >&2; exit 1; }
head -1 "$SRC" | grep -q 'record_id' || { echo "$SRC has no record_id column; is it the right file?" >&2; exit 1; }
NAME="$(basename "$SRC")"

# 1. copy into data/
cp "$SRC" "data/$NAME"

# 2. rebuild the manifest: existing files plus this one (no duplicates, order kept)
FILES="$(grep -o '"[^"]*\.csv"' data/manifest.json | tr -d '"' || true)"
echo "$FILES" | grep -qx "$NAME" || FILES="$(printf '%s\n%s' "$FILES" "$NAME" | sed '/^$/d')"
{
  echo '{'
  echo '  "files": ['
  echo "$FILES" | sed 's/.*/    "&"/' | sed '$!s/$/,/'
  echo '  ]'
  echo '}'
} > data/manifest.json
echo "Manifest now lists:"; sed -n 's/^ *"\(.*\.csv\)".*/  - \1/p' data/manifest.json

# 3. commit and push
git add "data/$NAME" data/manifest.json
if git diff --cached --quiet; then
  echo "Nothing new to commit ($NAME is already live)."
else
  git commit -q -m "Add data: $NAME"
  git push -q
  echo "Pushed. Waiting for GitHub Pages to publish..."
fi

# 4. wait until the live manifest lists the file
REMOTE="$(git remote get-url origin)"
OWNER="$(echo "$REMOTE" | sed -E 's#.*github\.com[:/]([^/]+)/.*#\1#' | tr '[:upper:]' '[:lower:]')"
REPO="$(echo "$REMOTE" | sed -E 's#.*/([^/]+)$#\1#; s#\.git$##')"
URL="https://$OWNER.github.io/$REPO/"
START=$(date +%s)
for i in $(seq 1 60); do
  if curl -fsS "${URL}data/manifest.json?t=$(date +%s%N)" 2>/dev/null | grep -q "$NAME"; then
    echo "LIVE after $(( $(date +%s) - START ))s: $URL"
    echo "Now click \"Refresh data\" on the dashboard."
    exit 0
  fi
  sleep 5
done
echo "Pushed, but Pages hasn't published yet after 5 minutes. Check the repo's Actions tab." >&2
echo "Fallback: drag $SRC onto the dashboard (or use \"Add data file\")." >&2
exit 2
