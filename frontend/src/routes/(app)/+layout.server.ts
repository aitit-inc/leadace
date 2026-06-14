import { dev } from '$app/environment';
import { ACTIVE_PROJECT_COOKIE } from '$lib/active-project';
import { getGmailStatus } from '$lib/api/auth-google';
import { getPlan } from '$lib/api/billing';
import { getOnboardingStatus } from '$lib/api/onboarding';
import { listProjects } from '$lib/api/projects';
import type { GmailStatus } from '$lib/types/auth-google';
import type { PlanInfo } from '$lib/types/plan';
import type { LayoutServerLoad } from './$types';

// (app) group: gated by hooks.server.ts. By the time this load runs,
// `locals.session` is guaranteed to be set.
//
// Children read this layer via `await parent()`. The active project
// preference is persisted in a cookie (set by `(app)/+layout.svelte`'s
// project switcher) so the server can pre-render the right project on first
// paint without waiting for client localStorage reconciliation.
export const load: LayoutServerLoad = async ({ fetch, locals, cookies, depends }) => {
	depends('app:active-project', 'app:projects', 'app:plan', 'app:gmail-status', 'app:onboarding');

	const session = locals.session;
	if (!session) {
		// hooks.server.ts already redirects unauthenticated requests away
		// from this group, so this branch is defensive belt-and-braces — it
		// keeps the type narrowed and surfaces a misconfiguration loudly
		// rather than letting the API call below fall through with no token.
		throw new Error('(app)/+layout.server.ts: locals.session was not set');
	}
	const token = session.access_token;

	// /projects is required — without it we can't render the switcher and
	// most pages have nothing to show. Let it throw and rely on +error.svelte
	// to keep the app shell alive. /me/plan and Gmail status are best-effort:
	// a transient failure hides the relevant widget (quota / connection
	// warning), not tear down the whole app. Gmail status lives here (not on
	// the account-settings page only) so the header can surface a "Gmail not
	// connected" banner with a Connect button on every authenticated page.
	const [projects, planResult, gmailStatus, mcpConnected] = await Promise.all([
		listProjects(fetch, token),
		getPlan(fetch, token).then(
			(p) => ({ ok: true as const, plan: p }),
			(e: unknown) => ({
				ok: false as const,
				message: e instanceof Error ? e.message : 'Failed to load plan',
			}),
		),
		getGmailStatus(fetch, token).then<GmailStatus, GmailStatus>(
			(res) =>
				res.connected
					? { state: 'connected', email: res.email ?? '', updatedAt: res.updatedAt ?? '' }
					: { state: 'disconnected' },
			(e: unknown) => ({
				state: 'error',
				message: e instanceof Error ? e.message : 'Failed to load Gmail status',
			}),
		),
		// Default to connected on failure so a transient error never traps the user.
		getOnboardingStatus(fetch, token).then(
			(s) => s.mcpConnected,
			() => true,
		),
	]);
	const plan: PlanInfo | null = planResult.ok ? planResult.plan : null;
	const planError: string | null = planResult.ok ? null : planResult.message;

	// Reconcile the active-project cookie with the freshly loaded list. If
	// the stored ID is no longer in the list (project deleted, switched
	// tenants, etc.), fall back to the first project. This mirrors the old
	// client-store reconciliation but happens server-side so the first paint
	// already has a valid `activeProjectId`.
	const stored = cookies.get(ACTIVE_PROJECT_COOKIE) ?? null;
	const next = stored && projects.some((p) => p.id === stored)
		? stored
		: (projects[0]?.id ?? null);

	// Persist the reconciled value back so the cookie doesn't keep pointing
	// at a deleted project on every subsequent request. Cookie attributes
	// mirror $lib/active-project so the client and server agree.
	if (stored !== next) {
		if (next) {
			// httpOnly: false so client-side setActiveProject can overwrite
			// this. SvelteKit's cookies.set defaults to httpOnly: true, which
			// would silently block document.cookie writes from JS.
			cookies.set(ACTIVE_PROJECT_COOKIE, next, {
				path: '/',
				sameSite: 'lax',
				secure: !dev,
				httpOnly: false,
				maxAge: 60 * 60 * 24 * 365,
			});
		} else if (stored) {
			cookies.delete(ACTIVE_PROJECT_COOKIE, { path: '/' });
		}
	}

	return { activeProjectId: next, projects, plan, planError, gmailStatus, mcpConnected };
};
