<script lang="ts">
  import { onMount } from 'svelte';
  import { invalidate } from '$app/navigation';
  import { page } from '$app/state';
  import { createCheckoutSession, createPortalSession } from '$lib/api/billing';
  import { formatQuota, QUOTA_WINDOW_LABEL } from '$lib/format';
  import { creditsCoverOverage } from '$lib/credits';
  import { USAGE_PRICE_CENTS } from '$lib/types/plan';
  import CreditsPanel from '$lib/components/plans/CreditsPanel.svelte';
  import PlanChange from '$lib/components/plans/PlanChange.svelte';
  import { EDITION } from '$lib/config';
  import { PAID_TIERS, isPaidPlan, type PaidTier } from '$lib/plans';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  let token = $derived(data.session?.access_token);
  let plan = $derived(data.plan);

  let checkoutLoading = $state<string | null>(null);
  let portalLoading = $state(false);
  let message = $state('');

  function resetLoadingState() {
    portalLoading = false;
    checkoutLoading = null;
  }

  // Stripe webhooks land at the API a few seconds after the redirect — poll
  // /me/plan via invalidate until the watched value changes, with an upper bound.
  async function pollPlanUntilChanged(
    read: () => string | number | null,
    maxAttempts = 8,
    intervalMs = 1500,
  ) {
    const before = read();
    for (let i = 0; i < maxAttempts; i++) {
      await invalidate('app:plan');
      if (read() !== before) return;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  const creditBalance = () =>
    data.plan?.quota.kind === 'capped' ? (data.plan.quota.credits?.balanceCents ?? null) : null;

  // An upgrade is mirrored by the webhook like a Checkout; a scheduled change
  // lives in Stripe and is re-read with the page data.
  async function handlePlanChanged(appliesNow: boolean) {
    if (appliesNow) {
      message = 'Plan upgraded. Waiting for confirmation…';
      await pollPlanUntilChanged(() => data.plan?.plan ?? null);
      message = 'Plan upgraded.';
    }
    await invalidate('app:subscription');
  }

  onMount(() => {
    if (EDITION === 'cloud') {
      const status = page.url.searchParams.get('checkout');
      if (status === 'success') {
        message = 'Subscription activated. Waiting for confirmation…';
        pollPlanUntilChanged(() => data.plan?.plan ?? null)
          .then(() => invalidate('app:subscription'))
          .then(() => {
            message = 'Subscription activated.';
          });
      } else if (status === 'cancel') {
        message = 'Checkout cancelled.';
      }
      const credits = page.url.searchParams.get('credits');
      if (credits === 'success') {
        message = 'Credits purchased. Waiting for confirmation…';
        pollPlanUntilChanged(creditBalance).then(() => {
          message = 'Credits added.';
        });
      } else if (credits === 'cancel') {
        message = 'Credit purchase cancelled.';
      }
    }
    window.addEventListener('pageshow', resetLoadingState);
    return () => window.removeEventListener('pageshow', resetLoadingState);
  });

  async function handleUpgrade(tier: PaidTier) {
    const priceId = tier.priceId;
    if (!priceId) {
      message = `Price ID for ${tier.name} is not configured.`;
      return;
    }
    checkoutLoading = tier.tier;
    try {
      const res = await createCheckoutSession(
        {
          priceId,
          successUrl: `${window.location.origin}/plans?checkout=success`,
          cancelUrl: `${window.location.origin}/plans?checkout=cancel`,
        },
        fetch,
        token,
      );
      window.location.href = res.url;
    } catch (e) {
      message = `Error: ${e instanceof Error ? e.message : 'Unknown error'}`;
      checkoutLoading = null;
    }
  }

  async function handlePortal() {
    portalLoading = true;
    try {
      const res = await createPortalSession(
        { returnUrl: `${window.location.origin}/plans` },
        fetch,
        token,
      );
      window.location.href = res.url;
    } catch (e) {
      message = `Error: ${e instanceof Error ? e.message : 'Unknown error'}`;
      portalLoading = false;
    }
  }
</script>

<svelte:head>
  <title>Plans · LeadAce</title>
</svelte:head>

<div class="mx-auto max-w-4xl">
  <h2 class="mb-6 font-display text-2xl font-semibold tracking-tight text-text">Plans</h2>

  {#if message}
    <div class="card mb-6 px-4 py-3 text-sm text-text">{message}</div>
  {/if}

  {#if !plan}
    <p class="text-sm text-danger">
      Couldn't load plan info{data.planError ? `: ${data.planError}` : '.'} Reload the page to try again.
    </p>
  {:else}
    <div class="card mb-6 p-6">
      <div class="mb-5 flex items-start justify-between">
        <div>
          <p class="mb-1 text-xs font-semibold text-text-muted">Current plan</p>
          <p class="font-display text-xl font-semibold capitalize text-text">
            {plan.plan}
            {#if plan.plan === 'free'}
              <span class="ml-1 font-sans text-xs font-normal text-text-muted">(trial)</span>
            {/if}
          </p>
        </div>
        {#if EDITION === 'cloud' && isPaidPlan(plan.plan)}
          <button onclick={handlePortal} disabled={portalLoading} class="btn btn-secondary btn-sm">
            {portalLoading ? 'Opening...' : 'Manage subscription'}
          </button>
        {/if}
      </div>

      {#if EDITION === 'cloud' && isPaidPlan(plan.plan)}
        <p class="-mt-2 mb-5 text-sm text-text-secondary">
          Update payment method, view invoices, or cancel via the Stripe Customer Portal.
        </p>
      {/if}
      {#if EDITION !== 'cloud'}
        <p class="-mt-2 mb-5 text-sm text-text-secondary">
          Self-hosted edition — unlimited usage. Billing is disabled on this install.
        </p>
      {/if}

      <div class="grid grid-cols-2 gap-6">
        <div class="space-y-3">
          {#if plan.quota.kind === 'unlimited'}
            <div>
              <p class="mb-1 text-xs font-semibold text-text-muted">Prospects</p>
              <p class="text-lg font-semibold text-text">unlimited</p>
            </div>
          {:else}
            {@const label = QUOTA_WINDOW_LABEL[plan.quota.window]}
            {@const allowances = [
              { label: `New prospects contacted (${label})`, usage: plan.quota.contacted },
              { label: `Found by LeadAce (${label})`, usage: plan.quota.found },
            ]}
            {#each allowances as { label, usage } (label)}
              <div>
                <p class="mb-1 text-xs font-semibold text-text-muted">{label}</p>
                <p class="font-display text-lg font-semibold tabular-nums text-text">
                  {formatQuota(usage.used, usage.limit)}
                </p>
                <div class="mt-1.5 h-1 w-full rounded-full bg-surface-2">
                  <div
                    class="h-1 rounded-full {usage.remaining === 0 && !creditsCoverOverage(plan.quota.credits, USAGE_PRICE_CENTS.contacted)
                      ? 'bg-warning'
                      : 'bg-text-muted'}"
                    style="width: {Math.min(100, (usage.used / usage.limit) * 100)}%"
                  ></div>
                </div>
              </div>
            {/each}
            <p class="text-xs text-text-muted">
              Follow-ups are free.{creditsCoverOverage(plan.quota.credits, USAGE_PRICE_CENTS.contacted)
                ? ' Usage past an allowance comes out of your credits.'
                : ''}
            </p>
          {/if}
        </div>
        {#if plan.prospects}
          <div>
            <p class="mb-1 text-xs font-semibold text-text-muted">Stored prospects</p>
            <p class="font-display text-lg font-semibold tabular-nums text-text">
              {formatQuota(plan.prospects.used, plan.prospects.limit)}
            </p>
            {#if plan.prospects.limit !== null}
              <div class="mt-1.5 h-1 w-full rounded-full bg-surface-2">
                <div
                  class="h-1 rounded-full {plan.prospects.remaining === 0 ? 'bg-warning' : 'bg-text-muted'}"
                  style="width: {Math.min(100, (plan.prospects.used / plan.prospects.limit) * 100)}%"
                ></div>
              </div>
            {/if}
          </div>
        {/if}
      </div>
    </div>

    {#if EDITION === 'cloud' && plan.quota.kind === 'capped' && plan.quota.credits}
      <CreditsPanel
        credits={plan.quota.credits}
        {token}
        onChanged={() => invalidate('app:plan')}
      />
    {/if}

    {#if EDITION === 'cloud' && isPaidPlan(plan.plan) && (data.subscription || data.subscriptionError)}
      <p class="mb-4 font-display text-lg font-semibold text-text">Change plan</p>
      {#if data.subscription}
        <PlanChange
          current={plan.plan}
          subscription={data.subscription}
          {token}
          onChanged={handlePlanChanged}
        />
      {:else}
        <p class="text-sm text-danger">
          Couldn't load subscription details: {data.subscriptionError}. Reload the page to try again.
        </p>
      {/if}
    {/if}

    {#if EDITION === 'cloud' && plan.plan === 'free'}
      <p class="mb-4 font-display text-lg font-semibold text-text">Upgrade</p>

      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
        {#each PAID_TIERS as tier (tier.tier)}
          <div class="card flex flex-col p-5">
            <p class="text-sm font-semibold text-text">{tier.name}</p>
            <p class="mt-1">
              <span class="font-display text-2xl font-semibold tabular-nums text-text">${tier.monthlyPrice}</span>
              <span class="text-sm text-text-muted">/month</span>
            </p>
            <ul class="mt-3 flex-1 space-y-1 text-sm text-text-secondary">
              <li>{tier.projects}</li>
              <li>{tier.outreach}</li>
            </ul>
            <button
              onclick={() => handleUpgrade(tier)}
              disabled={checkoutLoading !== null}
              class="btn btn-primary mt-4 w-full"
            >
              {checkoutLoading === tier.tier ? 'Redirecting...' : `Upgrade to ${tier.name}`}
            </button>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>
