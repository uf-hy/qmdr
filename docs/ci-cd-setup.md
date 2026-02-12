# CI/CD Setup & Branch Protection Guide

This document explains required repository settings for the hardened CI/CD pipelines.

## 1) Required GitHub Secrets

### CI integration smoke test
- `QMD_SILICONFLOW_API_KEY`

### npm publish (choose one auth mode)

#### Mode A (recommended): npm Trusted Publishing (OIDC)
- No `NPM_TOKEN` required.
- You must configure trusted publishing in npm package settings.

#### Mode B (fallback): npm token
- `NPM_TOKEN` (automation token with publish permissions)

## 2) Branch Protection (what and why)

Branch protection is a GitHub rule set on `main` to prevent direct/broken merges.

Recommended settings for this repo:

1. **Settings → Branches → Add rule** for `main`
2. Enable:
   - Require a pull request before merging
   - Require approvals (at least 1)
   - Require status checks to pass before merging
3. Required checks:
   - `Quality (typecheck + unit tests)`
   - `Integration (SiliconFlow smoke)` *(optional if you want hard API gate on every PR)*

If you expect external fork PRs, keep integration as optional because secrets are not exposed to forked PRs.

## 3) npm Trusted Publishing setup (recommended)

In npm package settings (`qmdr`):

1. Open package → **Settings** → **Trusted publishers**
2. Add GitHub repository: `uf-hy/qmdr` (replace with your actual owner/repo if different)
3. Restrict workflow file to: `.github/workflows/release.yml`
4. Save

After this, release workflow can publish using OIDC (`id-token: write`) without `NPM_TOKEN`.

## 4) Release process

Release is tag-driven:

```bash
git tag v1.0.3
git push origin v1.0.3
```

Workflow guarantees:
- tag version must match `package.json` version
- binaries are built for all configured targets
- `.sha256` checksum files are attached
- npm publish runs before GitHub Release creation

## 5) Operational notes

- CI runs on `pull_request`, `push main`, and `workflow_dispatch`.
- Integration smoke job is conditional on `QMD_SILICONFLOW_API_KEY`.
- If npm trusted publishing is not configured and `NPM_TOKEN` is missing, release workflow will fail at npm publish.
