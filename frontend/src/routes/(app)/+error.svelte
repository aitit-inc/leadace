<script lang="ts">
  import { page } from '$app/state';
  import { invalidateAll, goto } from '$app/navigation';
  import { setActiveProject } from '$lib/active-project';
  import Logo from '$lib/components/Logo.svelte';

  let retrying = $state(false);

  // The +error boundary doesn't receive `data`, so reach for the layout's
  // supabase client through `page.data` (set by the root +layout.ts).
  let supabase = $derived(page.data.supabase);

  async function retry() {
    retrying = true;
    try {
      await invalidateAll();
    } finally {
      retrying = false;
    }
  }

  async function signOut() {
    await supabase?.auth.signOut();
    await setActiveProject(null);
    goto('/login');
  }
</script>

<div class="flex min-h-screen flex-col items-center justify-center px-6 py-10 text-center">
  <h1 class="mb-3 flex items-center gap-2 font-mono text-base font-semibold text-text">
    <Logo size={22} class="text-accent" />
    LeadAce
  </h1>
  <p class="mb-1 text-sm text-text">Something went wrong loading the app.</p>
  <p class="mb-4 max-w-md text-xs text-text-muted">
    {page.error?.message ?? 'Unknown error'}
  </p>
  <div class="flex gap-3">
    <button
      type="button"
      onclick={retry}
      disabled={retrying}
      class="rounded bg-text px-4 py-1.5 text-xs font-medium text-page hover:bg-text/90 transition-colors disabled:opacity-50"
    >
      {retrying ? 'Retrying…' : 'Try again'}
    </button>
    <button
      type="button"
      onclick={signOut}
      class="rounded border border-border px-4 py-1.5 text-xs font-medium text-text hover:bg-surface transition-colors"
    >
      Sign out
    </button>
  </div>
</div>
