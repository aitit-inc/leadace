<script lang="ts">
  import { goto } from '$app/navigation';
  import { deleteAccount, type AccountDeletionReason } from '$lib/api/account';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  let token = $derived(data.session?.access_token);
  let supabase = $derived(data.supabase);

  const reasonOptions: { value: AccountDeletionReason; label: string }[] = [
    { value: 'not_enough_results', label: "I didn't get enough results (replies / leads)" },
    { value: 'too_expensive', label: 'Too expensive' },
    { value: 'missing_features', label: 'Missing features I needed' },
    { value: 'too_hard_to_use', label: 'Too hard to set up or use' },
    { value: 'switched_to_alternative', label: 'Switching to another tool' },
    { value: 'no_longer_needed', label: 'No longer need it' },
    { value: 'other', label: 'Other' },
  ];

  let reason = $state<AccountDeletionReason | ''>('');
  let detail = $state('');
  let confirmText = $state('');
  let deleting = $state(false);
  let errorMessage = $state('');

  // Unknown plan (loader failed) → show the paid warning to avoid under-warning.
  let isPaid = $derived(
    data.plan ? data.plan.plan !== 'free' && data.plan.plan !== 'unlimited' : true,
  );
  let surveyAnswered = $derived(
    reason !== '' && (reason !== 'other' || detail.trim().length > 0),
  );
  let canSubmit = $derived(confirmText === 'DELETE' && surveyAnswered && !deleting);

  async function handleDelete(e: Event) {
    e.preventDefault();
    if (!canSubmit || reason === '') return;
    deleting = true;
    errorMessage = '';
    try {
      await deleteAccount(
        reason === 'other' ? { reason, detail: detail.trim() } : { reason },
        fetch,
        token,
      );
      await supabase.auth.signOut().catch(() => undefined);
      await goto('/login?deleted=1', { replaceState: true });
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : 'Failed to delete account';
      deleting = false;
    }
  }
</script>

<svelte:head>
  <title>Delete account · LeadAce</title>
</svelte:head>

<h2 class="text-lg font-semibold text-text mb-6">Delete account</h2>

<div class="max-w-2xl space-y-6">
  <div class="rounded-md border border-danger/40 bg-danger/5 p-5">
    <p class="text-sm font-medium text-danger mb-3">This cannot be undone.</p>
    <p class="text-sm text-text mb-3">
      Deleting your account permanently removes:
    </p>
    <ul class="list-disc list-inside text-sm text-text-muted space-y-1 mb-3">
      <li>Your workspace and every project in it</li>
      <li>All prospects, organizations, outreach history, drafts, replies, and evaluations</li>
      <li>All uploaded documents and project settings</li>
      <li>Your Gmail send authorization</li>
      <li>Your login — signing in again with the same Google account creates a
        brand-new, empty account; none of the data above is restored</li>
    </ul>
    <p class="text-sm text-text-muted mb-3">
      MCP clients you previously connected keep their tokens for up to 30 days.
      Disconnect LeadAce from each MCP client (Claude Desktop, etc.) after deleting
      to revoke them immediately.
    </p>
    {#if isPaid}
      <p class="text-sm text-text">
        Your paid subscription will be cancelled immediately. No prorated refund is
        issued for the remainder of the current billing period.
      </p>
    {/if}
  </div>

  <form onsubmit={handleDelete} class="space-y-5">
    <fieldset class="space-y-3">
      <legend class="text-sm font-medium text-text">
        Before you go — why are you leaving? <span class="text-danger">*</span>
      </legend>
      <div class="space-y-2">
        {#each reasonOptions as option (option.value)}
          <label class="flex items-center gap-2 text-sm text-text">
            <input
              type="radio"
              name="deletion-reason"
              value={option.value}
              bind:group={reason}
              class="accent-accent"
            />
            <span>{option.label}</span>
          </label>
        {/each}
      </div>

      {#if reason === 'other'}
        <label class="block">
          <span class="sr-only">Tell us more</span>
          <textarea
            bind:value={detail}
            rows="3"
            maxlength="500"
            placeholder="Tell us more…"
            class="mt-1 block w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-text focus:border-accent focus:outline-none"
          ></textarea>
        </label>
      {/if}

      <p class="text-xs text-text-muted">
        Stored anonymously to help us improve — it can't be linked back to you, so
        please don't include any personal information.
      </p>
    </fieldset>

    <label class="block">
      <span class="text-sm text-text">Type <span class="font-mono font-semibold">DELETE</span> to confirm.</span>
      <input
        type="text"
        bind:value={confirmText}
        autocomplete="off"
        spellcheck="false"
        class="mt-2 block w-full rounded-md border border-border bg-page px-3 py-2 text-sm text-text font-mono focus:border-accent focus:outline-none"
      />
    </label>

    {#if errorMessage}
      <p class="text-sm text-danger">{errorMessage}</p>
    {/if}

    <div class="flex items-center gap-3 pt-2">
      <a
        href="/account-settings"
        class="rounded-md border border-border bg-page px-4 py-2 text-sm font-medium text-text hover:bg-surface"
      >
        Back to Account
      </a>
      <button
        type="submit"
        disabled={!canSubmit}
        class="rounded-md bg-danger px-4 py-2 text-sm font-medium text-white hover:bg-danger/90 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {deleting ? 'Deleting…' : 'Delete my account permanently'}
      </button>
    </div>
  </form>
</div>
