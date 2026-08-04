import { dev } from '$app/environment';
import { ACTIVE_PROJECT_COOKIE } from '$lib/active-project';
import { listAttention } from '$lib/api/attention';
import { getPlan } from '$lib/api/billing';
import { listProjects } from '$lib/api/projects';
import type { PlanInfo } from '$lib/types/plan';
import type { LayoutServerLoad } from './$types';

// The active-project preference is a cookie (set by the project switcher) so
// the server can pre-render the right project on first paint, without waiting
// for client localStorage reconciliation.
export const load: LayoutServerLoad = async ({ fetch, locals, cookies, depends }) => {
	// 'app:onboarding' = the onboarding page's "check now" button.
	depends('app:active-project', 'app:projects', 'app:plan', 'app:onboarding', 'app:attention');

	const session = locals.session;
	if (!session) {
		// hooks.server.ts already gates this group — this branch narrows the
		// type and surfaces a hook misconfiguration loudly.
		throw new Error('(app)/+layout.server.ts: locals.session was not set');
	}
	const token = session.access_token;

	// /projects is required — let it throw and surface via +error.svelte. Plan
	// and attention are best-effort: a transient failure hides the relevant
	// widget (banners, bell), not the whole app.
	const [projects, planResult, attention] = await Promise.all([
		listProjects(fetch, token),
		getPlan(fetch, token).then(
			(p) => ({ ok: true as const, plan: p }),
			(e: unknown) => ({
				ok: false as const,
				message: e instanceof Error ? e.message : 'Failed to load plan',
			}),
		),
		listAttention(fetch, token).catch(() => []),
	]);
	const plan: PlanInfo | null = planResult.ok ? planResult.plan : null;
	const planError: string | null = planResult.ok ? null : planResult.message;
	// A failed attention load reads as "connected" — never trap the user in onboarding.
	const mcpConnected = !attention.some((i) => i.kind === 'mcp_not_connected');

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

	return { activeProjectId: next, projects, plan, planError, attention, mcpConnected };
};
