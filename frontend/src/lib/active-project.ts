// Cookie-based active-project preference. The server's `(app)/+layout.server.ts`
// reads this cookie to pre-render with the right project; the client writes
// it on switch / create. A 1-year `Max-Age` matches the SvelteKit auth-cookie
// convention (long enough to feel sticky, short enough that abandoned
// browsers don't hold a tenant pointer indefinitely).

import { browser, dev } from '$app/environment';
import { invalidate } from '$app/navigation';

export const ACTIVE_PROJECT_COOKIE = 'leadace_active_project';

function cookieAttrs(): string {
	const base = 'Path=/; SameSite=Lax';
	const lifetime = `Max-Age=${60 * 60 * 24 * 365}`;
	const secure = dev ? '' : '; Secure';
	return `${base}; ${lifetime}${secure}`;
}

export async function setActiveProject(id: string | null): Promise<void> {
	if (!browser) return;
	if (id) {
		document.cookie = `${ACTIVE_PROJECT_COOKIE}=${encodeURIComponent(id)}; ${cookieAttrs()}`;
	} else {
		document.cookie = `${ACTIVE_PROJECT_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0${dev ? '' : '; Secure'}`;
	}
	await invalidate('app:active-project');
}
