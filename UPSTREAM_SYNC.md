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

4. Merge updated `main` into product branches:

   ```bash
   git checkout <feature-or-product-branch>
   git merge main
   ```

## Emergency Security Update Flow

Use this path when upstream publishes a high-priority fix:

1. Sync `main` from `upstream/main` immediately.
2. Run smoke tests (build, startup, key channels).
3. Ship a canary deployment.
4. Roll out broadly after canary validation.

## GitHub Actions Automation

The workflow at `.github/workflows/sync-upstream.yml` creates a PR from upstream updates into this fork's `main` branch on a schedule and via manual trigger.

If merge conflicts occur, resolve them manually using this runbook.
