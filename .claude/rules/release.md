---
paths:
  - "plugin/.claude-plugin/plugin.json"
---

# Releasing

## Version bump

- Bump `plugin/.claude-plugin/plugin.json`. Default: z+1 in x.y.z (each part can be ≥2 digits: 0.3.9 → 0.3.10).
- Two commits: code change first, then a separate `chore: :bookmark: bump version to x.y.z` for the bump alone.

### Preferred: `release PR` workflow

Trigger the `release PR` workflow from the GitHub Actions tab (Actions → release PR → Run workflow). Inputs:

- `version` — optional. Blank ⇒ auto z+1 patch bump. Specify (e.g. `0.6.0`) for minor/major.

The workflow bumps `plugin.json`, commits to `develop` as `chore: :bookmark: bump version to X.Y.Z`, pushes via SSH (Deploy Key), and opens the `develop → main` PR with a changelog since the last `v*` tag. Merge it from the UI with **Create a merge commit** (no-squash, no-ff).

The bump commit on `develop` triggers `check.yml` (Deploy Key push isn't subject to GITHUB_TOKEN's anti-recursion rule), so its check status shows on the PR head — verify it before merging.

#### Repository setup (configure once)

The `release PR` and `merge-back` workflows both depend on a Deploy Key + secret + ruleset bypass triplet (each pushes to `develop`, which the Ruleset otherwise restricts to PRs). Set these up once per repository (or after rotating the key).

1. Generate an SSH key pair locally (no passphrase):
   ```bash
   ssh-keygen -t ed25519 -C "release-pr workflow" -f /tmp/release_pr_key -N ""
   ```
2. Repository → Settings → **Deploy keys** → *Add deploy key*:
   - Title: `release-pr workflow`
   - Key: contents of `/tmp/release_pr_key.pub`
   - **Allow write access**: checked
3. Repository → Settings → Secrets and variables → Actions → *New repository secret*:
   - Name: `RELEASE_PR_DEPLOY_KEY`
   - Value: contents of `/tmp/release_pr_key` (private key, including the BEGIN/END lines)
4. Repository → Settings → Rules → Rulesets → `develop` → Edit → Bypass list → *Add bypass* → **Deploy keys** → select `release-pr workflow`.
5. Delete the local key files: `rm /tmp/release_pr_key /tmp/release_pr_key.pub`.

If the Deploy Key is ever rotated, repeat 1–5 and update the secret/bypass entry.

## Branch flow

- `develop` is the default. Day-to-day commits land on `develop` or on branches PR'd into `develop`. Feature branches → `develop` are **squash** merges.
- `main` is the production branch. Merge `develop` → `main` with a **merge commit (no-squash, no fast-forward)** to ship. The `merge-back.yml` workflow then auto-resyncs by merging `main` back into `develop` (triggered on `push: main`); if it reports a conflict, resolve and push `develop` manually. Squashing `develop` → `main` re-compresses commits already on `main`, so the next release sees them as phantom conflicts (cost us a conflict on PR #18). The asymmetry is deliberate: squash on the way in (one commit per feature), merge commit on the way out (shared history stays linear).
- CI deploy (`deploy.yml`: Workers + Pages + plugin marketplace via `main`-tagged migration job) runs only on `main` push. Pushes/PRs to `develop` run `check.yml` only.

## Deploy

Merge `develop` → `main` to deploy. CI builds backend (Workers + Pages); the plugin bump goes live through the marketplace as soon as it lands on `main`.

For backend changes that break the running plugin (drop / rename DB column, remove an MCP tool, change a required argument), push order does not save users still on the old plugin who haven't run `/plugin update`. The fix is backend backwards-compatibility for one release cycle, then removing the old shape in a later release.

## OSS public mirror

A `main` push also triggers `sync-public.yml`, which mirrors the OSS-publishable tree to the public repo (`aitit-inc/leadace`) — fully automatic, nothing to do. Two things to keep in mind: it's a **one-way** mirror (the sync overwrites public `main` wholesale, so never edit public directly — external PRs get incorporated into this private repo first, then re-synced), and what gets published is the allowlist in `.github/sync/build-public-tree.sh` (a new file is public only if added there). When the user says they're about to release, remind them of this in one line.

## MIN_PLUGIN_VERSION

`backend/src/mcp/index.ts` defines `MIN_PLUGIN_VERSION`. The `/leadace` skill calls `get_server_version`, reads `plugin/.claude-plugin/plugin.json`, and aborts with a `/plugin update` message if the plugin is older.

Bump `MIN_PLUGIN_VERSION` to the just-released plugin version only when the backend now requires plugin behavior the old plugin lacks — e.g.:

- Removed an MCP tool the plugin still calls
- Renamed or removed a required field on an existing tool
- Changed response shape in a way the plugin parses
- Dropped a backwards-compat shim from a prior cycle

Don't bump it for additive changes (new tool, new optional field). The point is to give old-plugin users a clear fix-it message instead of a cryptic tool error.
