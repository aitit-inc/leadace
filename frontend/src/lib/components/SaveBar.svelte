<script lang="ts">
  import { afterNavigate, beforeNavigate, goto } from '$app/navigation';
  import ConfirmDialog from './ConfirmDialog.svelte';

  let {
    dirty,
    saving,
    error = null,
    onsave,
    ondiscard,
  }: {
    dirty: boolean;
    saving: boolean;
    error?: string | null;
    onsave: () => void;
    ondiscard: () => void;
  } = $props();

  type Pending = { title: string; confirmLabel: string; run: () => void };

  let pending = $state<Pending | null>(null);
  let leaving = $state(false);

  function runPending() {
    const action = pending;
    pending = null;
    action?.run();
  }

  function askDiscard() {
    pending = {
      title: 'Discard changes?',
      confirmLabel: 'Discard',
      run: ondiscard,
    };
  }

  beforeNavigate((nav) => {
    if (!dirty || leaving) return;
    nav.cancel();
    // A full unload cannot wait for a dialog; cancel() has already raised the
    // browser's own leave prompt.
    if (nav.type === 'leave') return;
    const url = nav.to?.url;
    if (!url) return;
    const delta = nav.type === 'popstate' ? nav.delta : undefined;
    pending = {
      title: 'Leave without saving?',
      confirmLabel: 'Leave',
      run: () => {
        leaving = true;
        // SvelteKit puts a cancelled popstate back, so goto() would append an
        // entry instead of replaying the move the user asked for.
        if (delta === undefined) void goto(url);
        else history.go(delta);
      },
    };
  });

  afterNavigate(() => (leaving = false));
</script>

{#if dirty || saving}
  <div class="sticky bottom-0 rounded-2xl border border-border bg-surface px-4 py-3 shadow-lg">
    <div class="flex flex-wrap items-center gap-3">
      <span class="mr-auto text-sm font-medium text-text">Unsaved changes</span>
      <button type="button" onclick={askDiscard} disabled={saving} class="btn btn-ghost">
        Discard
      </button>
      <button type="button" onclick={onsave} disabled={saving} class="btn btn-primary">
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
    {#if error}
      <p class="mt-2 text-xs text-danger">{error}</p>
    {/if}
  </div>
{/if}

{#if pending}
  <ConfirmDialog
    title={pending.title}
    message="The edits you made on this page will be lost."
    confirmLabel={pending.confirmLabel}
    danger
    onconfirm={runPending}
    oncancel={() => (pending = null)}
  />
{/if}
