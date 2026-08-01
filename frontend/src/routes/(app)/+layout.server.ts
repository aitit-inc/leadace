import { dev } from '$app/environment';
import { ACTIVE_PROJECT_COOKIE } from '$lib/active-project';
import { listAlerts } from '$lib/api/alerts';
import { getGmailStatus } from '$lib/api/auth-google';
import { getPlan } from '$lib/api/billing';
import { getOnboardingStatus } from '$lib/api/onboarding';
import { listProjects } from '$lib/api/projects';
import type { GmailStatus } from '$lib/types/auth-google';
import type { PlanInfo } from '$lib/types/plan';
import type { LayoutServerLoad } from './$types';

// The active-project preference is a cookie (set by the project switcher) so
// the server can pre-render the right project on first paint, without waiting
// for client localStorage reconciliation.
export const load: LayoutServerLoad = async ({ fetch, locals, cookies, depends }) => {
	depends(
		'app:active-project',
		'app:projects',
		'app:plan',
		'app:gmail-status',
		'app:onboarding',
		'app:alerts',
	);

	const session = locals.session;
	if (!session) {
		// hooks.server.ts already gates this group — this branch narrows the
		// type and surfaces a hook misconfiguration loudly.
		throw new Error('(app)/+layout.server.ts: locals.session was not set');
	}
	const token = session.access_token;

	// /projects is required — let it throw and surface via +error.svelte. Plan
	// and Gmail status are best-effort: a transient failure hides the relevant
	// widget, not the whole app. Gmail status loads here so the header can show
	// a "Gmail not connected" banner on every authenticated page.
	const [projects, planResult, gmailStatus, mcpConnected, alerts] = await Promise.all([
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
		listAlerts(fetch, token).catch(() => []),
	]);
	const plan: PlanInfo | null = planResult.ok ? planResult.plan : null;
	const planError: string | null = planResult.ok ? null : planResult.message;

	const stored = cookies.get(ACTIVE_PROJECT_COOKIE) ?? null;
	const next = stored && projects.some((p) => p.id === stored)
		? stored
		: (projects[0]?.id ?? null);

	// Cookie attributes mirror $lib/active-project so client and server agree.
	if (stored !== next) {
		if (next) {
			// httpOnly: false — SvelteKit defaults to true, which would silently
			// block client-side setActiveProject's document.cookie writes.
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

	return { activeProjectId: next, projects, plan, planError, gmailStatus, mcpConnected, alerts };
};
