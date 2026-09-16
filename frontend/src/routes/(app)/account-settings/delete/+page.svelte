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

<div class="mx-auto max-w-2xl space-y-6">
  <h2 class="font-display text-2xl font-semibold tracking-tight text-text">Delete account</h2>

  <div class="rounded-2xl bg-danger/10 p-5">
    <p class="mb-3 text-sm font-semibold text-danger">This cannot be undone.</p>
    <p class="mb-3 text-sm text-text">
      Deleting your account permanently removes:
    </p>
    <ul class="mb-3 list-inside list-disc space-y-1 text-sm text-text-secondary">
      <li>Your workspace and every project in it</li>
      <li>All prospects, organizations, outreach history, drafts, replies, and evaluations</li>
      <li>All uploaded documents and project settings</li>
      <li>Your Gmail send authorization</li>
      <li>Your login — signing in again with the same Google account creates a
        brand-new, empty account; none of the data above is restored</li>
    </ul>
    <p class="mb-3 text-sm text-text-secondary">
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

  <form onsubmit={handleDelete} class="card space-y-5 p-6">
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
            class="field mt-1"
          ></textarea>
        </label>
      {/if}

      <p class="text-xs text-text-muted">
        Stored anonymously to help us improve — it can't be linked back to you, so
        please don't include any personal information.
      </p>
    </fieldset>

    <label class="block">
      <span class="text-sm font-medium text-text">Type <span class="font-mono font-semibold">DELETE</span> to confirm.</span>
      <input
        type="text"
        bind:value={confirmText}
        autocomplete="off"
        spellcheck="false"
        class="field mt-2 font-mono"
      />
    </label>

    {#if errorMessage}
      <p class="text-sm text-danger">{errorMessage}</p>
    {/if}

    <div class="flex items-center gap-3 pt-2">
      <a href="/account-settings" class="btn btn-secondary">
        Back to Account
      </a>
      <button type="submit" disabled={!canSubmit} class="btn btn-danger">
        {deleting ? 'Deleting…' : 'Delete my account permanently'}
      </button>
    </div>
  </form>
</div>
