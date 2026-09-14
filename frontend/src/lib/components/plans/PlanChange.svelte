<script lang="ts">
  import { cancelPlanChange, changePlan } from '$lib/api/billing';
  import { PAID_TIERS, tierName, tierRank, type PaidTier } from '$lib/plans';
  import type { PaidPlanTier, SubscriptionInfo } from '$lib/types/plan';
  import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';

  let {
    current,
    subscription,
    token,
    onChanged,
  }: {
    current: PaidPlanTier;
    subscription: SubscriptionInfo;
    token: string | undefined;
    // `appliesNow` = an upgrade went through; the plan itself changes once
    // the Stripe webhook lands.
    onChanged: (appliesNow: boolean) => Promise<void>;
  } = $props();

  let busy = $state(false);
  let message = $state('');
  let pending = $state<PaidTier | null>(null);

  const periodEnd = $derived(new Date(subscription.periodEnd).toLocaleDateString());
  const locked = $derived(subscription.cancelAtPeriodEnd);

  function isUpgrade(tier: PaidTier): boolean {
    return tierRank(tier.tier) > tierRank(current);
  }

  async function run(action: () => Promise<unknown>, appliesNow: boolean) {
    busy = true;
    message = '';
    try {
      await action();
      await onChanged(appliesNow);
    } catch (e) {
      message = e instanceof Error ? e.message : 'Unknown error';
      await onChanged(false);
    } finally {
      busy = false;
    }
  }

  function confirmChange() {
    const tier = pending;
    pending = null;
    if (!tier?.priceId) return;
    const priceId = tier.priceId;
    void run(() => changePlan({ priceId, fromPlan: current, periodEnd: subscription.periodEnd }, fetch, token), isUpgrade(tier));
  }
</script>

{#if message}
  <div class="mb-4 rounded bg-surface px-4 py-3 text-sm text-danger">{message}</div>
{/if}

{#if locked}
  <p class="mb-4 text-xs text-text-muted">
    Your subscription ends on {periodEnd}. Reactivate it in the Stripe Customer Portal to change plan.
  </p>
{:else if subscription.scheduledPlan}
  <div class="mb-4 flex items-center justify-between rounded-md border border-border px-4 py-3">
    <p class="text-sm text-text">
      {tierName(subscription.scheduledPlan)} from {periodEnd}. {tierName(current)} stays active until
      then.
      <span class="text-xs text-text-muted">To cancel the subscription instead, keep {tierName(current)} first.</span>
    </p>
    <button
      onclick={() => run(() => cancelPlanChange(fetch, token), false)}
      disabled={busy}
      class="shrink-0 rounded px-3 py-1.5 text-xs font-medium text-text border border-border hover:bg-surface transition-colors disabled:opacity-50"
    >
      Keep {tierName(current)}
    </button>
  </div>
{/if}

<div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
  {#each PAID_TIERS as tier (tier.tier)}
    <div class="rounded-md border border-border p-4 flex flex-col">
      <p class="text-sm font-medium text-text">{tier.name}</p>
      <p class="mt-1">
        <span class="font-mono text-xl font-semibold text-text">${tier.monthlyPrice}</span>
        <span class="text-xs text-text-muted">/month</span>
      </p>
      <ul class="mt-3 space-y-1 text-xs text-text-secondary flex-1">
        <li>{tier.projects}</li>
        <li>{tier.outreach}</li>
      </ul>
      {#if tier.tier === current}
        <p class="mt-4 text-center text-xs text-text-muted py-1.5">Current plan</p>
      {:else}
        <button
          onclick={() => (pending = tier)}
          disabled={busy || locked || !tier.priceId || tier.tier === subscription.scheduledPlan}
          class="mt-4 w-full rounded px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 {isUpgrade(tier)
            ? 'text-page bg-accent hover:bg-accent-strong'
            : 'text-text border border-border hover:bg-surface'}"
        >
          {isUpgrade(tier) ? `Upgrade to ${tier.name}` : `Switch to ${tier.name} on ${periodEnd}`}
        </button>
      {/if}
    </div>
  {/each}
</div>

{#if pending}
  {#if isUpgrade(pending)}
    <ConfirmDialog
      title={`Upgrade to ${pending.name}`}
      message={`${pending.name} starts now. The difference for the rest of this billing period is charged to your card today, and the next renewal on ${periodEnd} is $${pending.monthlyPrice}.`}
      confirmLabel="Upgrade now"
      onconfirm={confirmChange}
      oncancel={() => (pending = null)}
    />
  {:else}
    <ConfirmDialog
      title={`Switch to ${pending.name}`}
      message={`${tierName(current)} stays active until ${periodEnd}. From then on you are billed $${pending.monthlyPrice}/month for ${pending.name} (${pending.projects}, ${pending.outreach}). You can undo this before ${periodEnd}.`}
      confirmLabel={`Switch on ${periodEnd}`}
      onconfirm={confirmChange}
      oncancel={() => (pending = null)}
    />
  {/if}
{/if}
