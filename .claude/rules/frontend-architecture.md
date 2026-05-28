# Frontend Architecture (LeadAce Web App)

Standard implementation pattern for `frontend/src/`, a SvelteKit app served
via Cloudflare Pages.

Stack: SvelteKit 2 + Svelte 5 runes + TypeScript strict + Tailwind v4 CSS
config + Supabase Auth via `@supabase/ssr` + SSR + client hydration.

We use the SvelteKit / Supabase officially-recommended SSR pattern. The SPA
(`ssr: false`) era was abandoned after the post-OAuth load → mount race
proved unfixable inside the SPA model.

Authoritative references:

- SvelteKit project structure / routing: https://svelte.dev/docs/kit/project-structure
- SvelteKit `load`: https://svelte.dev/docs/kit/load
- SvelteKit hooks: https://svelte.dev/docs/kit/hooks
- Svelte 5 runes / shared state: https://svelte.dev/docs/svelte/$state
- Supabase + SvelteKit server-side auth: https://supabase.com/docs/guides/auth/server-side/sveltekit

---

## Core Rules

- Auth session is owned by `hooks.server.ts`: per-request it builds a Supabase server client from cookies, populates `event.locals.{session,user,supabase}`, and applies the route gate (`(app)` requires session; `/login` redirects signed-in users).
- Server-side `load` fetches via `event.locals.supabase` (first-paint path). Client-side `load` reruns only on client navigations and uses the `data.supabase` client created in root `+layout.ts`.
- Route-tree shape:
  - `+layout.server.ts` (root) returns `session`, `user`, and the cookies needed to rebuild the client Supabase client.
  - `+layout.ts` (root) constructs the per-render Supabase client — `createBrowserClient` in the browser, `createServerClient` on the server (reading cookies from `data`).
  - `(app)/+layout.server.ts` loads cross-page data (active project, plan, project list) via `locals.session.access_token`.
  - `+page.server.ts` is preferred for data routes (server fetches once, ships pre-rendered). `+page.ts` is reserved for pages depending on browser-only inputs (e.g. localStorage). Mutations always go through `$lib/api/*` from the page.
- Auth gating is never done in component `$effect`. Pages assume `data.session` is set when the route group requires it — `hooks.server.ts` already redirected.
- `$lib/api/*` owns backend endpoint paths, query serialization, request bodies, response parsing, envelope stripping. Transport is bearer-token based; the token is supplied per call (server: `locals.session.access_token`, client: `data.session.access_token`).
- Route query strings belong to routes; backend API query strings belong to API clients.
- Server data lives in the layout's `data` prop — not in component `$state` or authoritative state modules.
- Feature components don't import route modules, `$app/navigation`, or `$app/state`. Use callback props (`onChanged`, `onFilterChange`) for route-level effects.
- `$lib/utils/` is pure: no fetch, DOM, storage, Svelte imports, or runes.
- Public config goes through `$env/static/public`. Supabase client setup lives in `+layout.ts` and `hooks.server.ts`, not in `$lib`.

---

## Layers

| Layer | Responsibility | Must not do |
|---|---|---|
| `hooks.server.ts` | Per-request: build server Supabase client from cookies, populate `event.locals.{supabase,session,user,safeGetSession}`, run the route-id-based auth gate (`(app)` redirects to `/login`, `/login` redirects to `?next` for signed-in users), set `filterSerializedResponseHeaders` for Supabase | route-specific business logic, fetching app data |
| `routes/+layout.server.ts` (root) | Return `{ session, user, cookies: cookies.getAll() }` so the client `+layout.ts` can rebuild the Supabase client with the same cookie state | per-route gating (lives in hooks), business data |
| `routes/+layout.ts` (root) | Build the per-render Supabase client (browser: `createBrowserClient`, server: `createServerClient` reading `data.cookies`); call `getSession()` and `getUser()`; return `{ supabase, session, user }`. Declare `depends('supabase:auth')` so client-side `invalidate('supabase:auth')` reruns it | side effects, redirects |
| `routes/+layout.svelte` (root) | Mount the Supabase auth listener via `$effect`, call `invalidate('supabase:auth')` on session changes, render `{@render children()}`, render the cookie banner | auth gating, route-level redirects |
| `routes/(app)/+layout.server.ts` | Load `projects`, `plan`, and reconcile `activeProject` via the API; return typed shape children read with `await parent()` | UI state, redirects on auth (already gated) |
| `routes/.../+page.server.ts` (preferred for data routes) | Parse `params` / `url.searchParams` (validated), call `$lib/api/*` with `event.fetch` and `locals.session.access_token`, declare `depends(...)` for `invalidate` tags, return flat typed data | UI state, DOM/storage access, components |
| `routes/.../+page.ts` (when client-only data is needed) | Same contract as `+page.server.ts` but on the client; uses `data.session.access_token` | server-only secrets, browser-globals during SSR |
| `routes/.../+page.svelte` | Render `PageProps` data, hold page-local `$state`, compose components, call mutation APIs, run `goto` / `invalidate` | raw `fetch`, backend URL construction, direct `supabase`, `$env`, authoritative server-data state |
| `routes/.../+server.ts` | Server-only endpoints (`/auth/callback`, programmatic redirects). Use `event.locals.supabase` for code exchange and `event.cookies` for setting session cookies | client UI |
| `$lib/api/client.ts` | `request(fetchFn, { method, path, body, auth, token? })` with auth header injection, error normalization, 401 → /login redirect (client) | resource-specific URLs, UI state |
| `$lib/api/<resource>.ts` | One typed client per backend resource group; use-case function names; backend URLs and payload shape; accepts an optional `token` for server-side calls | raw `Response`, Svelte modules, redirects |
| `$lib/state/*.svelte.ts` | Cross-page client-owned state: active project preference, theme | authoritative server data, route imports, components |
| `$lib/components/ui/` | App-agnostic primitives | `$lib/api/`, `$lib/state/`, `$lib/auth/` |
| `$lib/components/<feature>/` | Feature sections used by one or two pages; may own row/dialog mutation state | route imports, `$app/navigation`, `$app/state`, invalidation tags |
| `$lib/utils/` | Pure helpers split by topic | everything outside the standard library |
| `$lib/types/` | Shared frontend domain types | runtime behavior, non-standard dependencies |

---

## `hooks.server.ts` Shape

```ts
import { createServerClient } from '@supabase/ssr';
import { redirect, type Handle } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import {
  PUBLIC_SUPABASE_URL,
  PUBLIC_SUPABASE_ANON_KEY,
} from '$env/static/public';

const supabase: Handle = async ({ event, resolve }) => {
  event.locals.supabase = createServerClient(
    PUBLIC_SUPABASE_URL,
    PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll: () => event.cookies.getAll(),
        setAll: (cookies) => {
          for (const { name, value, options } of cookies) {
            event.cookies.set(name, value, { ...options, path: '/' });
          }
        },
      },
    },
  );

  // Always validate the JWT with getUser(); getSession() alone returns the
  // unverified cookie payload. safeGetSession() returns both only when the
  // server confirms the JWT.
  event.locals.safeGetSession = async () => {
    const { data: { session } } = await event.locals.supabase.auth.getSession();
    if (!session) return { session: null, user: null };
    const { data: { user }, error } = await event.locals.supabase.auth.getUser();
    if (error) return { session: null, user: null };
    return { session, user };
  };

  return resolve(event, {
    filterSerializedResponseHeaders: (name) =>
      name === 'content-range' || name === 'x-supabase-api-version',
  });
};

const authGuard: Handle = async ({ event, resolve }) => {
  const { session, user } = await event.locals.safeGetSession();
  event.locals.session = session;
  event.locals.user = user;

  // Use route id, not pathname — group folders like (app) won't appear in
  // the URL but do show up in route id.
  const inAppGroup = event.route.id?.startsWith('/(app)');
  if (inAppGroup && !session) {
    const next = event.url.pathname + event.url.search;
    redirect(303, `/login?next=${encodeURIComponent(next)}`);
  }
  if (event.route.id === '/login' && session) {
    const nextRaw = event.url.searchParams.get('next');
    redirect(303, nextRaw ?? '/prospects');
  }

  return resolve(event);
};

export const handle = sequence(supabase, authGuard);
```

`event.locals` is typed in `src/app.d.ts`:

```ts
import type { Session, SupabaseClient, User } from '@supabase/supabase-js';

declare global {
  namespace App {
    interface Locals {
      supabase: SupabaseClient;
      safeGetSession: () => Promise<
        | { session: Session; user: User }
        | { session: null; user: null }
      >;
      session: Session | null;
      user: User | null;
    }
    interface PageData {
      session: Session | null;
      user: User | null;
    }
  }
}
export {};
```

---

## Root Layout Loaders

```ts
// routes/+layout.server.ts
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({
  locals: { session, user },
  cookies,
}) => ({
  session,
  user,
  // The client +layout.ts needs the cookie state to construct a server-side
  // Supabase client during SSR rendering of child pages. Browser-side it is
  // ignored.
  cookies: cookies.getAll(),
});
```

```ts
// routes/+layout.ts
import {
  createBrowserClient,
  createServerClient,
  isBrowser,
} from '@supabase/ssr';
import {
  PUBLIC_SUPABASE_URL,
  PUBLIC_SUPABASE_ANON_KEY,
} from '$env/static/public';
import type { LayoutLoad } from './$types';

export const load: LayoutLoad = async ({ data, depends, fetch }) => {
  depends('supabase:auth');
  const supabase = isBrowser()
    ? createBrowserClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
        global: { fetch },
      })
    : createServerClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
        global: { fetch },
        cookies: { getAll: () => data.cookies },
      });

  const { data: { session } } = await supabase.auth.getSession();
  const { data: { user } } = await supabase.auth.getUser();

  return { supabase, session, user };
};
```

```svelte
<!-- routes/+layout.svelte -->
<script lang="ts">
  import '../app.css';
  import { invalidate } from '$app/navigation';
  import type { LayoutProps } from './$types';
  import CookieBanner from '$lib/components/CookieBanner.svelte';

  let { data, children }: LayoutProps = $props();
  let { supabase, session } = $derived(data);

  // Tell SvelteKit to rerun the supabase:auth-tagged loaders when the
  // session changes (token refresh, sign-out from another tab). The guard
  // on expires_at avoids re-invalidating on no-op events.
  $effect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      if (newSession?.expires_at !== session?.expires_at) {
        invalidate('supabase:auth');
      }
    });
    return () => sub.subscription.unsubscribe();
  });
</script>

{@render children()}
<CookieBanner />
```

---

## Data Loading

Prefer `+page.server.ts` for data routes; fall back to `+page.ts` only when data depends on browser-only inputs (localStorage, window.matchMedia, etc.). Pages read typed props and trigger reruns after mutations:

```ts
// routes/(app)/prospects/+page.server.ts
import type { PageServerLoad } from './$types';
import { listProspects } from '$lib/api/prospects';

export const load: PageServerLoad = async ({ fetch, parent, url, locals }) => {
  const { activeProjectId } = await parent();
  const status = parseStatus(url.searchParams.get('status'));
  const page = parsePage(url.searchParams.get('page'));

  if (!activeProjectId) {
    return { activeProjectId: null, prospects: [], total: 0, page, filters: { status } };
  }

  const { prospects, total } = await listProspects(
    activeProjectId,
    { status, page, limit: 25 },
    fetch,
    locals.session?.access_token,
  );

  return { activeProjectId, prospects, total, page, filters: { status } };
};
```

```svelte
<script lang="ts">
  import { invalidate } from '$app/navigation';
  import type { PageProps } from './$types';
  import { sendDraft } from '$lib/api/drafts';

  let { data }: PageProps = $props();

  async function handleSend(id: number) {
    await sendDraft(id, data.session?.access_token);
    await invalidate('app:drafts');
  }
</script>
```

- Filter / sort / pagination state lives in the route URL. Loaders parse `url.searchParams` into typed values and pass them to the API client. Inputs update the route via `goto('?status=...', { replaceState: true, keepFocus: true, noScroll: true })`. Don't duplicate the same state in component `$state`.
- Shared loads (current user, active project, plan, project list) live in `(app)/+layout.server.ts`; children read them with `await parent()` instead of refetching.

---

## API Clients

Mirror backend resource groups: `prospects.ts`, `drafts.ts`, `outreach.ts`, `responses.ts`, `projects.ts`, `organizations.ts`, `documents.ts`, `evaluations.ts`, `plan.ts`, `settings.ts`, `auth-google.ts`, `unsubscribe.ts`.

Functions are named after use cases. Both `fetchFn` and `token` are explicit so the server can pass `event.fetch` + `locals.session.access_token` and the client can pass `fetch` + `data.session.access_token`:

```ts
import { request, type RequestFetch } from '$lib/api/client';

export async function listDrafts(
  projectId: string,
  fetchFn: RequestFetch = fetch,
  token?: string,
): Promise<OutreachDraft[]> {
  const res = await request<{ drafts: OutreachDraft[] }>(fetchFn, {
    method: 'GET',
    path: `/projects/${projectId}/drafts`,
    auth: 'required',
    token,
  });
  return res.drafts;
}
```

Transport contract:

```ts
type RequestAuth = 'required' | 'none';
type RequestOptions = {
  method: string;
  path: string;
  body?: unknown;
  auth: RequestAuth;
  /** Explicit access token; required for `auth: 'required'` calls. */
  token?: string;
};
request<T>(fetchFn, opts: RequestOptions): Promise<T>;
```

- `auth: 'required'` injects `Authorization: Bearer ${token}`. The transport never calls `supabase.auth.getSession()` — callers always supply the token. Keeps the transport pure and identical on server and client.
- `auth: 'none'` attaches no bearer. Used by public token-authenticated routes (`/inquiry`, `/unsubscribe/[token]`) where the URL token IS the auth.
- 401 handling: client routes to `/login?next=...&reauth=1`; server throws SvelteKit `error(401)` so it surfaces through `+error.svelte`.
- Success payloads are trusted. Error payloads are `unknown` and normalized to displayable `{ error, detail }` strings before throwing.

---

## Auth Callback (`/auth/callback/+server.ts`)

```ts
import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { isSafeRelativePath } from '$lib/redirect';

export const GET: RequestHandler = async ({ url, locals: { supabase }, cookies }) => {
  const code = url.searchParams.get('code');
  const errorParam = url.searchParams.get('error');
  if (errorParam) redirect(303, `/login?error=${encodeURIComponent(errorParam)}`);
  if (!code) redirect(303, `/login?error=missing_code`);

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) redirect(303, `/login?error=${encodeURIComponent(error.message)}`);

  // ... persist provider_refresh_token to backend if present ...

  const nextCookie = cookies.get('lp-next');
  cookies.delete('lp-next', { path: '/' });
  const next = nextCookie && isSafeRelativePath(nextCookie) ? nextCookie : '/prospects';
  redirect(303, next);
};
```

`hooks.server.ts`'s `cookies.setAll` already wrote the Supabase session
cookies during `exchangeCodeForSession`. The 303 redirect to `/prospects`
is now a normal authenticated request — the `(app)` gate in hooks passes,
loaders run server-side, the page is rendered with data.

---

## State

- **Server data:** loader (`+page.server.ts` / `+layout.server.ts`) →
  `data` prop. Same prop shape regardless of whether the load ran on the
  server or after a client-side navigation.
- **Page-local UI state:** `$state(...)` inside the component.
- **Cross-page client state:** `$lib/state/<topic>.svelte.ts` (theme,
  active project preference). Never hold session/user here — `data.session`
  / `data.user` are authoritative.
- **Cross-page server data:** loaded by a layout loader; refreshed with
  `invalidate('app:tag')` after mutations.

State modules may persist their own client-owned values to `localStorage` /
`sessionStorage`, guarded for non-browser evaluation.

---

## Components

- `$lib/components/ui/` — generic primitives with only visual-contract props. Reusable in isolation; never imports API, auth, or state.
- `$lib/components/<feature>/` — feature-scoped sections. May call mutation APIs for actions they own, but route refresh stays on the page via callback props: `<DraftCard onChanged={() => invalidate('app:drafts')} />`.

Target page size is under ~150 lines. If a section grows past ~50 lines of template, extract a feature component.

---

## Types

- Split `$lib/types.ts` into `$lib/types/<domain>.ts` by backend service
  domain until a generated/shared source of truth exists.
- Each frontend type should name the backend file/type it mirrors.
- `any` is prohibited. Use `unknown` plus narrowing at boundaries.
- `App.Locals` and `App.PageData` typed in `src/app.d.ts`.

---

## Styling

- Tailwind tokens live in `src/app.css` `@theme {}` (single source of truth).
- Components use token classes (`bg-surface`, `text-text-muted`, `border-border`), not raw hex / RGB.
- Dark mode is class-based via `.dark` on `<html>`. SSR returns the class-less default; the pre-mount inline script in `src/app.html` reads `localStorage.leadace.theme` and flips the class before first paint to avoid flash-of-wrong-theme.

---

## Forms And Errors

- Simple forms use plain `<form onsubmit={...}>`, bound inputs, and API
  calls (no SvelteKit form actions yet).
- Pages catch `ApiError` once and render `error.detail || error.message`.
  Never render raw objects.
- Add route-level `+error.svelte` files for uncaught loader errors where
  the app shell needs a controlled fallback.

---

## Public Routes

`/login`, `/auth/callback`, `/mcp-authorize`, `/terms`, `/privacy`, `/legal`, `/compliance`, `/unsubscribe/[token]`, `/q/[short_id]` are outside the `(app)` group — the auth guard doesn't redirect them. `/login` does redirect signed-in users to `?next` (in `hooks.server.ts`).

`/q/[short_id]` (inquiry landing) MUST NOT touch localStorage / cookies / session APIs — receivers reach it without an account. Its loader runs server-side with the URL's `short_id` as auth, and its component imports neither `$lib/auth` nor `$lib/stores/auth.ts`.

---

## Gotchas

- Runes work in `.svelte`, `.svelte.ts`, `.svelte.js`. In this TypeScript repo, shared state modules are `*.svelte.ts`.
- Don't fetch server data in `$effect`; use `load`.
- `invalidate(tag)` only reruns loaders that called `depends(tag)`. Root layout uses `'supabase:auth'`; `(app)/+layout.server.ts` uses `'app:active-project'` / `'app:projects'` / `'app:plan'`.
- `page.url` from `$app/state` is read-only; route changes go through `goto`.
- During SSR, `window` / `document` / `localStorage` / `navigator` etc. are undefined. Guard with `import { browser } from '$app/environment'` or `typeof window !== 'undefined'`. Modules under `$lib/state/` keep these guards locally.
- Supabase `provider_refresh_token` exists only on the immediate sign-in event — persist it in `/auth/callback/+server.ts`; don't rely on later session restores.
- Server-side `getSession()` returns the unverified cookie payload. Always validate via `getUser()` before trusting (see `safeGetSession` in `hooks.server.ts`).
- Public env vars only reach the client through `$env/static/public`. Never put secrets in `PUBLIC_*`.
- `adapter-cloudflare` deploys server hooks and loaders as Pages Functions. Every request hits a Function (not just static assets), so total Function invocations grow with traffic — watch Cloudflare Pages metrics after rollout.
