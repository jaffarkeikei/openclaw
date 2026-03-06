# Upstream Sync Runbook

This repository is a fork of `openclaw/openclaw`.

Use this runbook to keep `jaffarkeikei/openclaw` updated with upstream changes, especially security fixes.

## Remotes

Expected remotes:

- `origin` -> `https://github.com/jaffarkeikei/openclaw.git`
- `upstream` -> `https://github.com/openclaw/openclaw.git`

Verify:

```bash
git remote -v
```

## Sync Model

This fork now acts as a **direct-sync mirror layer** for Anza.

- Upstream changes sync directly into `jaffarkeikei/openclaw@main`
- Review happens in the **Anza** repository when the OpenClaw pin changes
- There is **no review PR inside the fork** as part of the normal automated flow

## Normal Update Flow (weekly)

1. Fetch latest upstream:

   ```bash
   git fetch upstream
   ```

2. Update local `main`:

   ```bash
   git checkout main
   git merge --ff-only upstream/main
   ```

3. Push fork `main`:

   ```bash
   git push origin main
   ```

4. Let Anza consume the new fork SHA through its own pin-bump PR:
   - `anza/.github/workflows/openclaw-version-bump.yml`
   - `anza/ops/openclaw-version.json`

## Emergency Security Update Flow

Use this path when upstream publishes a high-priority fix:

1. Sync `main` from `upstream/main` immediately.
2. Run smoke tests (build, startup, key channels).
3. Ship a canary deployment.
4. Roll out broadly after canary validation.

## GitHub Actions Automation

The workflow at `.github/workflows/sync-upstream.yml` now syncs upstream updates directly into this fork's `main` branch on a schedule and via manual trigger.

Notes:

- The workflow preserves this fork's own `.github/workflows` directory when upstream changes touch workflow files. This avoids GitHub token restrictions when pushing workflow-file updates from automation.
- As a result, this fork is intended to track the **runtime/codebase** closely for Anza, but it is not a byte-for-byte mirror of upstream workflow automation files.

If merge conflicts occur, resolve them manually using this runbook.
