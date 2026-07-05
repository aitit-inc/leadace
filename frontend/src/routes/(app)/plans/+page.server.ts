import type { PageServerLoad } from './$types';

// Plan info is already loaded by (app)/+layout.server.ts as `plan` / `planError`,
// so this page doesn't need its own server load.
export const load: PageServerLoad = async () => ({});
