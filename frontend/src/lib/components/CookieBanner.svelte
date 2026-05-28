<script lang="ts">
  import { onMount } from 'svelte';
  import { EDITION } from '$lib/config';

  const STORAGE_KEY = 'leadace.cookie_consent';

  let visible = $state(false);

  onMount(() => {
    try {
      if (localStorage.getItem(STORAGE_KEY) !== 'accepted') {
        visible = true;
      }
    } catch {
      // Private mode or storage disabled — show the banner once per session
      visible = true;
    }
  });

  function accept() {
    try {
      localStorage.setItem(STORAGE_KEY, 'accepted');
    } catch {
      // Ignore — banner still dismissed for this session
    }
    visible = false;
  }
</script>

{#if visible}
  <div
    class="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-surface px-4 py-3 text-sm text-text-secondary shadow-[0_-1px_0_0_rgba(0,0,0,0.04)] md:inset-x-auto md:bottom-4 md:right-4 md:w-96 md:rounded-md md:border md:shadow-none"
    role="region"
    aria-label="Cookie notice"
  >
    <p class="leading-relaxed">
      We use first-party cookies and local storage for authentication and to remember your
      preferences. We don't use analytics or advertising trackers.
      {#if EDITION === 'cloud'}
        <a href="/privacy#cookies" class="underline hover:text-text">Learn more</a>.
      {/if}
    </p>
    <div class="mt-3 flex justify-end">
      <button
        type="button"
        onclick={accept}
        class="rounded-md border border-border bg-page px-3 py-1.5 text-xs font-medium text-text transition-colors hover:border-accent hover:text-accent"
      >
        Got it
      </button>
    </div>
  </div>
{/if}
