#!/usr/bin/env bash

set -euo pipefail

mkdir -p "${QMD_CONFIG_DIR:-/tmp/qmdr-ci-config}" "${XDG_CACHE_HOME:-/tmp/qmdr-ci-cache}"

LOG_DIR="${QMD_CI_LOG_DIR:-/tmp/qmdr-ci-logs}"
mkdir -p "$LOG_DIR"

run_and_log() {
  local name="$1"
  shift
  "$@" 2>&1 | tee "$LOG_DIR/${name}.log"
}

TEST_DOCS_DIR="/tmp/qmdr-test-docs"
rm -rf "$TEST_DOCS_DIR"
mkdir -p "$TEST_DOCS_DIR"

cat > "$TEST_DOCS_DIR/cooking-tips.md" <<'EOF'
# Cooking Tips

Start by heating the pan before adding oil.
Season food in layers and taste as you cook.
For pasta, save a small cup of pasta water to help sauces bind.
EOF

cat > "$TEST_DOCS_DIR/git-workflow.md" <<'EOF'
# Git Workflow

Create a feature branch for each task.
Keep commits small and focused.
Rebase on main before opening a pull request.
EOF

cat > "$TEST_DOCS_DIR/travel-japan.md" <<'EOF'
# Travel in Japan

Trains are reliable and often the fastest option between cities.
IC cards are convenient for local transit.
Try regional food specialties in each destination.
EOF

run_and_log collection-add bun src/qmd.ts collection add "$TEST_DOCS_DIR" --name test-ci --mask "*.md"
run_and_log embed bun src/qmd.ts embed
run_and_log doctor bun src/qmd.ts doctor

query_output_1="$(run_and_log query-pasta bun src/qmd.ts query "how to make pasta" -c test-ci)"
if [ -z "$(echo "$query_output_1" | tr -d '[:space:]')" ]; then
  echo "Query 1 returned empty output"
  exit 1
fi
echo "$query_output_1"

run_and_log query-git bun src/qmd.ts query "git branch strategy" -c test-ci
run_and_log search-japan bun src/qmd.ts search "japan" -c test-ci

echo "--- Testing file deletion (deactivate) ---"
rm "$TEST_DOCS_DIR/travel-japan.md"
run_and_log update bun src/qmd.ts update
echo "File deletion test passed"
