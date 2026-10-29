<script lang="ts">
  import { loadStripe } from '@stripe/stripe-js';
  import { cancelPlanChange, changePlan } from '$lib/api/billing';
  import { STRIPE_PUBLISHABLE_KEY } from '$lib/config';
  import { PAID_TIERS, tierName, tierRank, type PaidTier } from '$lib/plans';
  import type { PaidPlanTier, PlanChangeResult, SubscriptionInfo } from '$lib/types/plan';
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
  const endsAt = $derived(subscription.endsAt && new Date(subscription.endsAt).toLocaleDateString());

  function isUpgrade(tier: PaidTier): boolean {
    return tierRank(tier.tier) > tierRank(current);
  }

  async function keepCurrent() {
    busy = true;
    message = '';
    try {
      await cancelPlanChange(fetch, token);
      await onChanged(false);
    } catch (e) {
      message = e instanceof Error ? e.message : 'Unknown error';
      await onChanged(false);
    } finally {
      busy = false;
    }
  }

  async function confirmChange(tier: PaidTier) {
    if (!tier.priceId) return;
    message = '';
    let result: PlanChangeResult;
    try {
      result = await changePlan({ priceId: tier.priceId, fromPlan: current, periodEnd: subscription.periodEnd }, fetch, token);
    } catch (e) {
      await onChanged(false);
      throw e;
    }
    // The bank's step opens in Stripe's own frame, which this dialog would
    // sit over; the page holds still behind it instead.
    pending = null;
    busy = true;
    try {
      const paid = result.status === 'requires_action' ? await confirmWithBank(result.clientSecret) : 'paid';
      if (paid !== 'paid') {
        // An unpaid upgrade stays waiting at Stripe: the next plan change
        // drops it, and Stripe drops it after 23 hours.
        message = paid === 'unpaid'
          ? 'Your bank did not confirm the payment, so the plan did not change. Try again, or update the card under Manage subscription.'
          : 'The payment could not be confirmed. Reload the plans page to see your plan.';
        await onChanged(false);
        return;
      }
      await onChanged(isUpgrade(tier));
    } finally {
      busy = false;
    }
  }

  // Paid or not is what the payment says afterwards, not how the step ended:
  // one finished in another tab makes handleNextAction throw. A payment that
  // cannot be read is unknown, never unpaid.
  async function confirmWithBank(clientSecret: string): Promise<'paid' | 'unpaid' | 'unknown'> {
    try {
      const stripe = await loadStripe(STRIPE_PUBLISHABLE_KEY ?? '');
      if (!stripe) return 'unknown';
      await stripe.handleNextAction({ clientSecret }).catch(() => undefined);
      const { paymentIntent } = await stripe.retrievePaymentIntent(clientSecret);
      if (!paymentIntent) return 'unknown';
      return paymentIntent.status === 'succeeded' ? 'paid' : 'unpaid';
    } catch {
      return 'unknown';
    }
  }
</script>

{#if message}
  <div class="mb-4 rounded-2xl bg-danger/10 px-4 py-3 text-sm text-danger">{message}</div>
{/if}

{#if endsAt}
  <p class="mb-4 text-sm text-text-secondary">
    Your subscription ends on {endsAt}. Reactivate it in the Stripe Customer Portal to change plan.
  </p>
{:else if subscription.scheduledPlan}
  <div class="card mb-4 flex items-center justify-between gap-4 px-5 py-4">
    <p class="text-sm text-text">
      {tierName(subscription.scheduledPlan)} from {periodEnd}. {tierName(current)} stays active until
      then.
      <span class="text-xs text-text-muted">To upgrade, or to cancel the subscription instead, keep {tierName(current)} first.</span>
    </p>
    <button
      onclick={keepCurrent}
      disabled={busy}
      class="btn btn-secondary btn-sm shrink-0"
    >
      Keep {tierName(current)}
    </button>
  </div>
{/if}

<p class="mb-4 text-sm text-text-secondary">
  An upgrade starts today with a new monthly period and a fresh prospect allowance; you pay the new price
  less what is left of your current plan. A downgrade switches on {periodEnd}.
</p>

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
        <li>{tier.chat}</li>
      </ul>
      {#if tier.tier === current}
        <p class="mt-4 py-2 text-center text-sm font-semibold text-text-secondary">Current plan</p>
      {:else}
        <button
          onclick={() => (pending = tier)}
          disabled={busy || endsAt !== null || !tier.priceId || tier.tier === subscription.scheduledPlan || (isUpgrade(tier) && subscription.scheduledPlan !== null)}
          class="btn mt-4 w-full whitespace-normal {isUpgrade(tier) ? 'btn-primary' : 'btn-secondary'}"
        >
          {isUpgrade(tier) ? `Upgrade to ${tier.name}` : `Switch to ${tier.name} on ${periodEnd}`}
        </button>
      {/if}
    </div>
  {/each}
</div>

{#if pending}
  {@const tier = pending}
  {#if isUpgrade(tier)}
    <ConfirmDialog
      title={`Upgrade to ${tier.name}`}
      message={`${tier.name} starts today with a new monthly billing period, and your prospect allowance starts over. Your card is charged $${tier.monthlyPrice} today, less the unused part of ${tierName(current)}; it then renews monthly from today.`}
      confirmLabel="Upgrade now"
      onconfirm={() => confirmChange(tier)}
      oncancel={() => (pending = null)}
    />
  {:else}
    <ConfirmDialog
      title={`Switch to ${tier.name}`}
      message={`${tierName(current)} stays active until ${periodEnd}. From then on you are billed $${tier.monthlyPrice}/month for ${tier.name} (${tier.projects}, ${tier.outreach}, ${tier.chat}). You can undo this before ${periodEnd}.`}
      confirmLabel={`Switch on ${periodEnd}`}
      onconfirm={() => confirmChange(tier)}
      oncancel={() => (pending = null)}
    />
  {/if}
{/if}
