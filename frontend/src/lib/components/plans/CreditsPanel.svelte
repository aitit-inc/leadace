<script lang="ts">
  import { untrack } from 'svelte';
  import { createCreditCheckoutSession, updateAutoTopUp } from '$lib/api/billing';
  import { creditsCoverOverage, formatCents } from '$lib/credits';
  import {
    CREDIT_PACK_CENTS,
    USAGE_PRICE_CENTS,
    type CreditPackCents,
    type CreditState,
  } from '$lib/types/plan';

  let {
    credits,
    token,
    onChanged,
  }: {
    credits: NonNullable<CreditState>;
    token: string | undefined;
    onChanged: () => Promise<void>;
  } = $props();

  let buying = $state<CreditPackCents | null>(null);
  let saving = $state(false);
  let message = $state('');

  // Seeded once: the plan reloads several times after a Stripe redirect and
  // must not overwrite what the user is typing. Save writes these same values.
  const seed = untrack(() => credits.autoTopUp);
  let enabled = $state(seed.enabled);
  let amountCents = $state<CreditPackCents>(
    CREDIT_PACK_CENTS.find((pack) => pack === seed.amountCents) ?? 2500,
  );
  let thresholdDollars = $state(String(seed.thresholdCents / 100));

  async function buy(pack: CreditPackCents) {
    buying = pack;
    message = '';
    try {
      const res = await createCreditCheckoutSession(
        {
          packCents: pack,
          successUrl: `${window.location.origin}/plans?credits=success`,
          cancelUrl: `${window.location.origin}/plans?credits=cancel`,
        },
        fetch,
        token,
      );
      window.location.href = res.url;
    } catch (e) {
      message = `Error: ${e instanceof Error ? e.message : 'Unknown error'}`;
      buying = null;
    }
  }

  async function save() {
    const thresholdCents = Math.round(Number(thresholdDollars) * 100);
    if (!Number.isInteger(thresholdCents) || thresholdCents < 100 || thresholdCents > 10_000) {
      message = 'Threshold must be between $1 and $100.';
      return;
    }
    saving = true;
    message = '';
    try {
      await updateAutoTopUp({ enabled, amountCents, thresholdCents }, fetch, token);
      await onChanged();
      message = enabled ? 'Auto top-up is on.' : 'Auto top-up is off.';
    } catch (e) {
      message = `Error: ${e instanceof Error ? e.message : 'Unknown error'}`;
    } finally {
      saving = false;
    }
  }
</script>

<div class="rounded-md border border-border p-5 mb-6">
  <div class="flex flex-wrap items-start justify-between gap-4 mb-2">
    <div>
      <p class="text-xs text-text-muted uppercase tracking-wider mb-1">Prepaid credits</p>
      <p class="font-mono text-xl font-semibold {credits.balanceCents < 0 ? 'text-danger' : 'text-text'}">
        {formatCents(credits.balanceCents)}
      </p>
    </div>
    <div class="flex flex-wrap gap-2">
      {#each CREDIT_PACK_CENTS as pack (pack)}
        <button
          type="button"
          onclick={() => buy(pack)}
          disabled={buying !== null}
          class="rounded px-3 py-1.5 text-xs font-medium text-text border border-border hover:bg-surface transition-colors disabled:opacity-50"
        >
          {buying === pack ? 'Redirecting...' : `Add ${formatCents(pack)}`}
        </button>
      {/each}
    </div>
  </div>
  <p class="text-xs text-text-muted mb-4">
    Past your allowance, a new prospect costs {formatCents(USAGE_PRICE_CENTS.contacted)} and a
    prospect LeadAce finds costs {formatCents(USAGE_PRICE_CENTS.found)}. Credits never expire.
    {creditsCoverOverage(credits, USAGE_PRICE_CENTS.contacted)
      ? 'Sending continues past the allowance while the balance lasts.'
      : 'Sending and discovery stop at the allowance until you add credits.'}
  </p>

  {#if credits.autoTopUp.failedAt}
    <div class="mb-4 rounded border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
      Auto top-up was switched off on {new Date(credits.autoTopUp.failedAt).toLocaleDateString()}:
      the charge was declined. Update your card via Manage subscription, then switch it back on.
    </div>
  {/if}

  <div class="flex items-start gap-2 mb-3">
    <input id="auto-top-up" type="checkbox" bind:checked={enabled} disabled={saving} class="mt-0.5" />
    <label for="auto-top-up" class="text-sm text-text">
      Top up automatically
      <span class="block text-xs text-text-secondary">
        Charged to your subscription's card the moment the balance drops below the threshold,
        so it never runs out mid-run.
      </span>
    </label>
  </div>
  <div class="flex flex-wrap items-center gap-2 text-sm text-text mb-3">
    <span class="text-xs text-text-secondary">When below $</span>
    <input
      id="auto-top-up-threshold"
      type="text"
      inputmode="decimal"
      bind:value={thresholdDollars}
      disabled={saving || !enabled}
      class="w-16 rounded border border-border bg-page px-2 py-1.5 text-sm text-text disabled:opacity-50"
    />
    <span class="text-xs text-text-secondary">add</span>
    <select
      id="auto-top-up-amount"
      bind:value={amountCents}
      disabled={saving || !enabled}
      class="rounded border border-border bg-page px-2 py-1.5 text-sm text-text disabled:opacity-50"
    >
      {#each CREDIT_PACK_CENTS as pack (pack)}
        <option value={pack}>{formatCents(pack)}</option>
      {/each}
    </select>
    <button
      type="button"
      onclick={save}
      disabled={saving}
      class="rounded px-3 py-1.5 text-xs font-medium text-page bg-accent hover:bg-accent-strong transition-colors disabled:opacity-50"
    >
      {saving ? 'Saving...' : 'Save'}
    </button>
  </div>
  {#if message}
    <p class="text-xs {message.startsWith('Error') ? 'text-danger' : 'text-text-muted'}">{message}</p>
  {/if}
</div>
