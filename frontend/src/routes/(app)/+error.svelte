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
  <h1 class="mb-4 flex items-center gap-2.5 font-display text-xl font-semibold text-text">
    <Logo size={28} class="text-accent" />
    LeadAce
  </h1>
  <p class="mb-1 text-base text-text">Something went wrong loading the app.</p>
  <p class="mb-5 max-w-md text-sm text-text-muted">
    {page.error?.message ?? 'Unknown error'}
  </p>
  <div class="flex gap-2">
    <button type="button" onclick={retry} disabled={retrying} class="btn btn-primary">
      {retrying ? 'Retrying…' : 'Try again'}
    </button>
    <button
      type="button"
      onclick={signOut}
      class="btn btn-secondary"
    >
      Sign out
    </button>
  </div>
</div>
