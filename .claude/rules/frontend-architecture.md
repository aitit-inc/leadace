---
paths:
  - "frontend/**"
---

# Frontend Architecture (LeadAce Web App)

Standard for `frontend/src/`: SvelteKit 2 + Svelte 5 runes + TypeScript
strict + Tailwind v4 (CSS-based config) + Supabase Auth via `@supabase/ssr`,
served on Cloudflare Pages. SSR + client hydration — the
[officially recommended Supabase/SvelteKit pattern](https://supabase.com/docs/guides/auth/server-side/sveltekit).
The SPA (`ssr: false`) era was abandoned: the post-OAuth load → mount race is
unfixable inside the SPA model. Canonical implementations to read before
changing auth or data flow: `src/hooks.server.ts`, `src/routes/+layout.server.ts`,
`src/routes/+layout.ts`, `src/routes/auth/callback/+server.ts`, `src/app.d.ts`.

## Core rules

- Auth session is owned by `hooks.server.ts`: per-request it builds the
  Supabase server client from cookies, populates
  `event.locals.{supabase,session,user,safeGetSession}`, and applies the
  route gate — route-id based (`(app)` requires session; `/login` redirects
  signed-in users to `?next`). Use route id, not pathname: group folders
  like `(app)` don't appear in the URL. Auth gating is never done in
  component `$effect`; pages assume `data.session` when their route group
  requires it.
- Prefer `+page.server.ts` for data routes; `+page.ts` only when data depends
  on browser-only inputs (localStorage etc.). Loaders parse
  `url.searchParams` into typed values — filter/sort/pagination state lives
  in the route URL, updated via `goto('?...', { replaceState: true, keepFocus: true, noScroll: true })`,
  never duplicated in component `$state`.
- Shared loads (projects, plan, active project) live in
  `(app)/+layout.server.ts`; children read them with `await parent()`.
  Loaders declare `depends('app:tag')`; pages refresh after mutations with
  `invalidate('app:tag')`.
- `$lib/api/<resource>.ts` owns backend endpoint paths, query serialization,
  payload shapes, envelope stripping — one typed client per backend resource
  group, functions named after use cases. Transport (`$lib/api.ts`):
  `request<T>(fetchFn, { method, path, body, auth: 'required'|'none', token? })`.
  Callers always supply the token explicitly (server:
  `locals.session.access_token`, client: `data.session.access_token`) — the
  transport never calls `supabase.auth.getSession()`. `auth: 'none'` is for
  public token-authenticated routes where the URL token IS the auth.
  401 → client redirects to `/login?next=...&reauth=1`; server throws
  `error(401)`.
- Success payloads are trusted; error payloads are `unknown`, normalized to
  displayable `{ error, detail }` before throwing. Pages catch `ApiError`
  once and render `error.detail || error.message` — never raw objects.
- Server data lives in the loader `data` prop — never in component `$state`
  or store modules. `$lib/stores/` holds only cross-page client-owned state
  (e.g. `theme.ts`); never session/user — `data.session` / `data.user` are
  authoritative. Store modules guard browser globals for SSR evaluation.
- Components live in `$lib/components/`: shared primitives at the top level,
  feature-scoped sections in subdirectories (`dashboard/`, `inquiry/`, ...).
  Feature components may call mutation APIs they own, but route-level effects
  go through callback props (`onChanged={() => invalidate('app:drafts')}`)
  rather than importing route modules. Pure helpers are small top-level
  `$lib/*.ts` modules (no fetch/DOM/Svelte imports). Target page size ~150
  lines; extract a feature component past ~50 template lines.
- Public config only via `$env/static/public` (`PUBLIC_*`); Supabase client
  setup lives in `+layout.ts` / `hooks.server.ts`, not `$lib`. Never put
  secrets in `PUBLIC_*`.
- Types: `$lib/types/<domain>.ts` mirrors backend service domains; each type
  names the backend type it mirrors. `any` prohibited — `unknown` + narrowing
  at boundaries.

## Auth flow invariants

- Server-side `getSession()` returns the unverified cookie payload — always
  validate via `getUser()` before trusting. `safeGetSession()` in
  `hooks.server.ts` is the only correct source.
- Root `+layout.server.ts` returns `{ session, user, cookies: cookies.getAll() }`;
  root `+layout.ts` builds the per-render client (browser:
  `createBrowserClient`, SSR: `createServerClient` reading `data.cookies`)
  and declares `depends('supabase:auth')`. The root layout component mounts
  the auth listener in `$effect` and calls `invalidate('supabase:auth')`
  when `expires_at` changes.
- `/auth/callback/+server.ts` exchanges the code server-side and
  303-redirects; the session cookies are already written by hooks'
  `cookies.setAll` during the exchange. `provider_refresh_token` exists only
  on the immediate sign-in event — persist it there; later session restores
  don't carry it.

## Public routes

`/login`, `/auth/callback`, `/mcp-authorize`, `/terms`, `/privacy`, `/legal`,
`/compliance`, `/unsubscribe/[token]`, `/q/[short_id]` are outside `(app)`.
`/q/[short_id]` (inquiry landing) must not touch
localStorage/cookies/session APIs — receivers have no account; the URL's
`short_id` is the auth.

## Styling

- Tailwind tokens live in `src/app.css` `@theme {}`; components use token
  classes (`bg-surface`, `text-text-muted`), not raw hex.
- Dark mode is class-based (`.dark` on `<html>`): SSR returns class-less
  default; the pre-mount inline script in `src/app.html` reads
  `localStorage.leadace.theme` before first paint.

## Gotchas

- Runes only work in `.svelte` / `.svelte.ts` files. Don't fetch server data
  in `$effect` — use `load`.
- `invalidate(tag)` only reruns loaders that declared `depends(tag)`.
- `page.url` from `$app/state` is read-only; route changes go through `goto`.
- SSR has no `window`/`document`/`localStorage` — guard with
  `import { browser } from '$app/environment'`.
- `adapter-cloudflare` runs every request through a Pages Function (not just
  assets) — watch invocation counts after rollout.
