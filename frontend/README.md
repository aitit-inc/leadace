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
npm run dev                # → http://localhost:5173
```

## Pre-release check

```sh
npm run check
```

## Updating dependencies (lockfile gotcha)

`@sveltejs/adapter-cloudflare` pulls in `@img/sharp-wasm32`, whose optional
peer deps resolve to different `@emnapi/*` versions on macOS vs Linux. Running
`npm install` on macOS therefore writes a lockfile that fails `npm ci` on CI
(Ubuntu). **Only when you change `package.json` or `package-lock.json`**,
regenerate the lockfile inside a Linux container:

```sh
# from frontend/
docker run --rm -v "$PWD":/w -w /w node:22-slim \
  npm install --package-lock-only --no-audit --no-fund
```

Then commit the regenerated `package-lock.json`. Regular code-only changes do
not require this step — CI consumes the committed lockfile as-is.
