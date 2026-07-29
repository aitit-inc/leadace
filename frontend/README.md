# frontend/

LeadAce web app. SvelteKit 2 (Svelte 5 runes) + Tailwind v4 + Supabase Auth
(`@supabase/ssr`), SSR + client hydration, deployed to Cloudflare Pages.

For repo-wide dev workflow and env setup, see the top-level
[README.md](../README.md), [CLAUDE.md](../CLAUDE.md), and
[docs/self-host.md](../docs/self-host.md). For frontend conventions (data
loading, state, components), see
[.claude/rules/frontend-architecture.md](../.claude/rules/frontend-architecture.md).

## Local dev

```sh
cp .env.example .env       # set PUBLIC_SUPABASE_* from `supabase status`
npm install
npm run dev                # → http://localhost:5273
```

## Pre-release check

```sh
npm run check
```

## Updating dependencies (lockfile gotcha)

`npm install` with `node_modules` already present prunes other-platform
optional deps — `@emnapi/*`, `@img/sharp-*` — from `package-lock.json`
([npm/cli#7961](https://github.com/npm/cli/issues/7961), npm 10.3+–11.x). CI
then runs `npm ci` against that pruned lockfile and fails with `Missing: … from
lock file`. This is an npm-version / stale-`node_modules` issue, not a
macOS-vs-Linux one.

**Only when you change `package.json` or `package-lock.json`**, regenerate the
lockfile under the repo's pinned toolchain (node 22 via `.nvmrc`, matching CI):

```sh
# from frontend/
nvm use                    # node 22 (repo .nvmrc) — matches CI
rm -rf node_modules        # removing this first is what avoids the prune
npm install --no-audit --no-fund
```

Then commit the regenerated `package-lock.json`. Docker is not needed. Regular
code-only changes do not require this step — CI consumes the committed lockfile
as-is.
