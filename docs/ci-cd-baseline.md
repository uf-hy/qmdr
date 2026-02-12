# CI/CD Baseline Snapshot (pre-overhaul)

This document records the repository's CI/CD state before the overhaul.

## Existing workflows

### 1) CI Test
- File: `.github/workflows/test.yml`
- Trigger: `push` on `main`
- Runtime: `ubuntu-latest`
- Bun: `1.3.6`
- Secret used: `QMD_SILICONFLOW_API_KEY`
- Behavior:
  - Creates temporary markdown docs
  - Runs integration-oriented CLI flow:
    - `collection add`
    - `embed`
    - `doctor`
    - `query` / `search`
    - deletion + `update` check

### 2) Release
- File: `.github/workflows/release.yml`
- Trigger: `push` tags `v*`
- Matrix targets:
  - `darwin-arm64`
  - `linux-x64`
  - `linux-arm64`
- Behavior:
  - Compiles binaries with `bun build --compile`
  - Uploads artifacts
  - Creates GitHub Release via `softprops/action-gh-release@v2`

## Gaps at snapshot time

- No pull-request CI gate
- No dedicated typecheck step in workflow
- No npm publish stage
- No checksum/provenance artifacts for release assets
- No workflow-level concurrency control

---

Snapshot intent: preserve an explicit baseline before introducing stricter quality gates and dual-channel release (GitHub Release + npm).
