import type { PageServerLoad } from './$types';

// Plan info is already loaded by (app)/+layout.server.ts as `plan` /
// `planError` and refreshed via invalidate('app:plan') after Stripe webhook
// confirmation, so this page doesn't need its own server load.
export const load: PageServerLoad = async () => ({});
