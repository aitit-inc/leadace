<script lang="ts">
  import { untrack } from 'svelte';
  import { createCreditCheckoutSession, updateAutoTopUp, type AutoTopUpPatch } from '$lib/api/billing';
  import { creditsCoverOverage, formatCents, formatDollars, parseDollars } from '$lib/credits';
  import {
    CREDIT_AMOUNT_CENTS,
    CREDIT_PACK_CENTS,
    TOP_UP_THRESHOLD_CENTS,
    USAGE_PRICE_CENTS,
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

  let buying = $state<number | null>(null);
  let saving = $state(false);
  let message = $state('');
  let customPackText = $state('');

  // Seeded once: the plan reloads several times after a Stripe redirect and
  // must not overwrite what the user is typing. Save writes these same values.
  const seed = untrack(() => credits.autoTopUp);
  let enabled = $state(seed.enabled);
  let amountText = $state(String(seed.amountCents / 100));
  let thresholdText = $state(String(seed.thresholdCents / 100));

  const customPack = $derived(parseDollars(customPackText, CREDIT_AMOUNT_CENTS, 100));
  const amount = $derived(parseDollars(amountText, CREDIT_AMOUNT_CENTS, 100));
  const threshold = $derived(parseDollars(thresholdText, TOP_UP_THRESHOLD_CENTS, 1));
  const customPackInvalid = $derived(customPackText.trim() !== '' && customPack.cents === null);
  const amountInvalid = $derived(enabled && amount.cents === null);
  const thresholdInvalid = $derived(enabled && threshold.cents === null);
  const patch = $derived.by((): AutoTopUpPatch | null => {
    if (!enabled) return { enabled: false };
    if (amount.cents === null || threshold.cents === null) return null;
    return { enabled: true, amountCents: amount.cents, thresholdCents: threshold.cents };
  });

  const inputClass = 'rounded border bg-page px-2 py-1.5 text-sm text-text disabled:opacity-50';

  async function buy(packCents: number) {
    buying = packCents;
    message = '';
    try {
      const res = await createCreditCheckoutSession(
        {
          packCents,
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
    if (!patch) return;
    saving = true;
    message = '';
    try {
      await updateAutoTopUp(patch, fetch, token);
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
    <div class="flex flex-col items-end gap-2">
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
      <div class="flex items-center gap-2 text-sm text-text">
        <label for="credit-custom-pack" class="text-xs text-text-secondary">or $</label>
        <input
          id="credit-custom-pack"
          type="text"
          inputmode="numeric"
          placeholder="10–500"
          bind:value={customPackText}
          disabled={buying !== null}
          aria-invalid={customPackInvalid}
          class="w-20 {inputClass} {customPackInvalid ? 'border-danger' : 'border-border'}"
        />
        <button
          type="button"
          onclick={() => customPack.cents !== null && buy(customPack.cents)}
          disabled={buying !== null || customPack.cents === null}
          class="rounded px-3 py-1.5 text-xs font-medium text-text border border-border hover:bg-surface transition-colors disabled:opacity-50"
        >
          {customPack.cents !== null && buying === customPack.cents ? 'Redirecting...' : 'Add'}
        </button>
      </div>
      {#if customPackInvalid}
        <p class="text-xs text-danger">{customPack.error}</p>
      {/if}
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
      {#if credits.autoTopUp.enabled}
        The charge on {new Date(credits.autoTopUp.failedAt).toLocaleDateString()} was declined.
        Update your card via Manage subscription if you have not. Auto top-up is on again, and
        this notice clears once a top-up succeeds.
      {:else}
        Auto top-up was switched off on {new Date(credits.autoTopUp.failedAt).toLocaleDateString()}:
        the charge was declined. Update your card via Manage subscription, then switch it back on.
      {/if}
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
  <div class="flex flex-wrap items-center gap-2 text-sm text-text mb-1">
    <label for="auto-top-up-threshold" class="text-xs text-text-secondary">When below $</label>
    <input
      id="auto-top-up-threshold"
      type="text"
      inputmode="decimal"
      bind:value={thresholdText}
      disabled={saving || !enabled}
      aria-invalid={thresholdInvalid}
      class="w-16 {inputClass} {thresholdInvalid ? 'border-danger' : 'border-border'}"
    />
    <label for="auto-top-up-amount" class="text-xs text-text-secondary">add $</label>
    <input
      id="auto-top-up-amount"
      type="text"
      inputmode="numeric"
      list="auto-top-up-packs"
      bind:value={amountText}
      disabled={saving || !enabled}
      aria-invalid={amountInvalid}
      class="w-20 {inputClass} {amountInvalid ? 'border-danger' : 'border-border'}"
    />
    <datalist id="auto-top-up-packs">
      {#each CREDIT_PACK_CENTS as pack (pack)}
        <option value={pack / 100}></option>
      {/each}
    </datalist>
    <button
      type="button"
      onclick={save}
      disabled={saving || patch === null}
      class="rounded px-3 py-1.5 text-xs font-medium text-page bg-accent hover:bg-accent-strong transition-colors disabled:opacity-50"
    >
      {saving ? 'Saving...' : 'Save'}
    </button>
  </div>
  <p class="text-xs mb-3 {thresholdInvalid || amountInvalid ? 'text-danger' : 'text-text-muted'}">
    {#if thresholdInvalid}
      Threshold: {threshold.error}
    {:else if amountInvalid}
      Amount: {amount.error}
    {:else}
      Threshold {formatDollars(TOP_UP_THRESHOLD_CENTS.min)}–{formatDollars(TOP_UP_THRESHOLD_CENTS.max)};
      amount {formatDollars(CREDIT_AMOUNT_CENTS.min)}–{formatDollars(CREDIT_AMOUNT_CENTS.max)} in whole dollars.
    {/if}
  </p>
  {#if message}
    <p class="text-xs {message.startsWith('Error') ? 'text-danger' : 'text-text-muted'}">{message}</p>
  {/if}
</div>
