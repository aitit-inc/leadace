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
  <div class="mb-4 rounded-2xl bg-danger/10 px-4 py-3 text-sm text-danger">{message}</div>
{/if}

{#if locked}
  <p class="mb-4 text-sm text-text-secondary">
    Your subscription ends on {periodEnd}. Reactivate it in the Stripe Customer Portal to change plan.
  </p>
{:else if subscription.scheduledPlan}
  <div class="card mb-4 flex items-center justify-between gap-4 px-5 py-4">
    <p class="text-sm text-text">
      {tierName(subscription.scheduledPlan)} from {periodEnd}. {tierName(current)} stays active until
      then.
      <span class="text-xs text-text-muted">To cancel the subscription instead, keep {tierName(current)} first.</span>
    </p>
    <button
      onclick={() => run(() => cancelPlanChange(fetch, token), false)}
      disabled={busy}
      class="btn btn-secondary btn-sm shrink-0"
    >
      Keep {tierName(current)}
    </button>
  </div>
{/if}

<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
  {#each PAID_TIERS as tier (tier.tier)}
    <div class="card flex flex-col p-5 {tier.tier === current ? 'ring-2 ring-text/40' : ''}">
      <p class="text-sm font-semibold text-text">{tier.name}</p>
      <p class="mt-1">
        <span class="font-display text-2xl font-semibold tabular-nums text-text">${tier.monthlyPrice}</span>
        <span class="text-sm text-text-muted">/month</span>
      </p>
      <ul class="mt-3 flex-1 space-y-1 text-sm text-text-secondary">
        <li>{tier.projects}</li>
        <li>{tier.outreach}</li>
      </ul>
      {#if tier.tier === current}
        <p class="mt-4 py-2 text-center text-sm font-semibold text-text-secondary">Current plan</p>
      {:else}
        <button
          onclick={() => (pending = tier)}
          disabled={busy || locked || !tier.priceId || tier.tier === subscription.scheduledPlan}
          class="btn mt-4 w-full whitespace-normal {isUpgrade(tier) ? 'btn-primary' : 'btn-secondary'}"
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
