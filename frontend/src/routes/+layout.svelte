<script lang="ts">
  import '../app.css';
  import { invalidate } from '$app/navigation';
  import { page } from '$app/state';
  import type { LayoutProps } from './$types';
  import CookieBanner from '$lib/components/CookieBanner.svelte';

  // /q/[shortId] is the only recipient-facing landing — it must not touch
  // localStorage / cookies. Match by route id so sibling routes like
  // /q/preview (sender-facing, gated by (app)) keep the banner.
  const INQUIRY_LANDING_ROUTE_ID = '/q/[shortId]';

  let { data, children }: LayoutProps = $props();
  let { supabase, session } = $derived(data);

  // Rerun supabase:auth-tagged loaders on token rotation / cross-tab sign-out.
  // expires_at guard skips no-op events.
  $effect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      if (newSession?.expires_at !== session?.expires_at) {
        void invalidate('supabase:auth');
      }
    });
    return () => sub.subscription.unsubscribe();
  });

  let isInquiryLanding = $derived(page.route.id === INQUIRY_LANDING_ROUTE_ID);
</script>

{@render children()}
{#if !isInquiryLanding}
  <CookieBanner />
{/if}
