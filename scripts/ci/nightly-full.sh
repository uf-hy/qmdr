#!/usr/bin/env bash

set -euo pipefail

LOG_DIR="${QMD_CI_LOG_DIR:-/tmp/qmdr-ci-logs}"
mkdir -p "$LOG_DIR"

echo "[nightly] typecheck"
bun run typecheck 2>&1 | tee "$LOG_DIR/typecheck.log"

echo "[nightly] full test suite"
set +e
bun run test:full 2>&1 | tee "$LOG_DIR/full-test.log"
full_test_exit=${PIPESTATUS[0]}
set -e

echo "[nightly] integration smoke"
set +e
bash scripts/ci/integration-smoke.sh 2>&1 | tee "$LOG_DIR/integration-smoke.log"
integration_exit=${PIPESTATUS[0]}
set -e

echo "full_test_exit=$full_test_exit"
echo "integration_exit=$integration_exit"

if [ "$full_test_exit" -ne 0 ]; then
  echo "Nightly checks failed (full_test_exit=$full_test_exit)"
  exit 1
fi

if [ "$integration_exit" -ne 0 ]; then
  echo "Warning: integration smoke failed (non-blocking, SiliconFlow may need identity verification)"
fi

echo "Nightly checks passed"
