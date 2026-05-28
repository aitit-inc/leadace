<script lang="ts">
  import { onMount } from 'svelte';
  import { invalidate } from '$app/navigation';
  import { page } from '$app/state';
  import { createCheckoutSession, createPortalSession } from '$lib/api/billing';
  import { formatQuota } from '$lib/format';
  import { EDITION, STRIPE_PRICES } from '$lib/config';
  import type { PlanTier } from '$lib/types/plan';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  let token = $derived(data.session?.access_token);
  let plan = $derived(data.plan);

  let checkoutLoading = $state<string | null>(null);
  let portalLoading = $state(false);
  let message = $state('');
  let billingPeriod = $state<'monthly' | 'yearly'>('monthly');

  interface PaidTier {
    tier: Exclude<PlanTier, 'free'>;
    name: string;
    monthlyPrice: number;
    yearlyPrice: number;
    projects: string;
    outreach: string;
    priceIds: { monthly: string | undefined; yearly: string | undefined };
  }

  const TIERS: PaidTier[] = [
    {
      tier: 'starter',
      name: 'Starter',
      monthlyPrice: 29,
      yearlyPrice: 290,
      projects: '1 project',
      outreach: '1,500 outreach / month',
      priceIds: STRIPE_PRICES.starter,
    },
    {
      tier: 'pro',
      name: 'Pro',
      monthlyPrice: 79,
      yearlyPrice: 790,
      projects: '5 projects',
      outreach: '10,000 outreach / month',
      priceIds: STRIPE_PRICES.pro,
    },
    {
      tier: 'scale',
      name: 'Scale',
      monthlyPrice: 199,
      yearlyPrice: 1990,
      projects: 'Unlimited projects',
      outreach: 'Unlimited outreach',
      priceIds: STRIPE_PRICES.scale,
    },
  ];

  function resetLoadingState() {
    portalLoading = false;
    checkoutLoading = null;
  }

  // Stripe webhooks land at the API a few seconds after the redirect — poll
  // /me/plan via invalidate until plan changes, with an upper bound.
  async function pollPlanUntilUpdated(
    fromPlan: string | null,
    maxAttempts = 8,
    intervalMs = 1500,
  ) {
    for (let i = 0; i < maxAttempts; i++) {
      await invalidate('app:plan');
      const current = data.plan?.plan ?? null;
      if (current !== fromPlan) return;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  onMount(() => {
    if (EDITION === 'cloud') {
      const status = page.url.searchParams.get('checkout');
      if (status === 'success') {
        message = 'Subscription activated. Waiting for confirmation…';
        const fromPlan = data.plan?.plan ?? null;
        pollPlanUntilUpdated(fromPlan).then(() => {
          message = 'Subscription activated.';
        });
      } else if (status === 'cancel') {
        message = 'Checkout cancelled.';
      }
    }
    window.addEventListener('pageshow', resetLoadingState);
    return () => window.removeEventListener('pageshow', resetLoadingState);
  });

  async function handleUpgrade(tier: PaidTier) {
    const priceId = tier.priceIds[billingPeriod];
    if (!priceId) {
      message = `Price ID for ${tier.name} (${billingPeriod}) is not configured.`;
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

<h2 class="text-lg font-semibold text-text mb-6">Plans</h2>

{#if message}
  <div class="mb-6 rounded bg-surface px-4 py-3 text-sm text-text">{message}</div>
{/if}

{#if !plan}
  <p class="text-sm text-danger">
    Couldn't load plan info{data.planError ? `: ${data.planError}` : '.'} Reload the page to try again.
  </p>
{:else}
  <div class="rounded-md border border-border p-5 mb-6">
    <div class="flex items-start justify-between mb-5">
      <div>
        <p class="text-xs text-text-muted uppercase tracking-wider mb-1">Current plan</p>
        <p class="text-xl font-semibold text-text capitalize">
          {plan.plan}
          {#if plan.plan === 'free'}
            <span class="ml-1 text-xs font-normal text-text-muted">(trial)</span>
          {/if}
        </p>
      </div>
      {#if EDITION === 'cloud' && (plan.plan === 'starter' || plan.plan === 'pro' || plan.plan === 'scale')}
        <button
          onclick={handlePortal}
          disabled={portalLoading}
          class="rounded px-3 py-1.5 text-xs font-medium text-text border border-border hover:bg-surface transition-colors disabled:opacity-50"
        >
          {portalLoading ? 'Opening...' : 'Manage subscription'}
        </button>
      {/if}
    </div>

    {#if EDITION === 'cloud' && (plan.plan === 'starter' || plan.plan === 'pro' || plan.plan === 'scale')}
      <p class="text-xs text-text-muted mb-5 -mt-2">
        Change plan, update payment method, view invoices, or cancel via the Stripe Customer
        Portal.
      </p>
    {/if}
    {#if EDITION !== 'cloud'}
      <p class="text-xs text-text-muted mb-5 -mt-2">
        Self-hosted edition — unlimited usage. Billing is disabled on this install.
      </p>
    {/if}

    <div class="grid grid-cols-2 gap-6">
      <div class="space-y-3">
        {#if plan.outreach.kind === 'unlimited'}
          <div>
            <p class="text-xs text-text-muted mb-1">Outreach (unlimited)</p>
            <p class="font-mono text-lg text-text">
              {plan.outreach.used.toLocaleString()} used
            </p>
          </div>
        {:else}
          {@const windows = [
            { label: 'today', window: plan.outreach.daily },
            { label: 'lifetime', window: plan.outreach.lifetime },
            { label: 'this month', window: plan.outreach.monthly },
          ]}
          {#each windows as { label, window } (label)}
            {#if window}
              <div>
                <p class="text-xs text-text-muted mb-1">Outreach ({label})</p>
                <p class="font-mono text-lg text-text">
                  {formatQuota(window.used, window.limit)}
                </p>
                <div class="mt-1.5 h-1 w-full rounded-full bg-surface">
                  <div
                    class="h-1 rounded-full {window.remaining === 0 ? 'bg-accent' : 'bg-text'}"
                    style="width: {Math.min(100, (window.used / window.limit) * 100)}%"
                  ></div>
                </div>
              </div>
            {/if}
          {/each}
        {/if}
      </div>
      {#if plan.prospects}
        <div>
          <p class="text-xs text-text-muted mb-1">Prospects (lifetime)</p>
          <p class="font-mono text-lg text-text">
            {formatQuota(plan.prospects.used, plan.prospects.limit)}
          </p>
          {#if plan.prospects.limit !== null}
            <div class="mt-1.5 h-1 w-full rounded-full bg-surface">
              <div
                class="h-1 rounded-full {plan.prospects.remaining === 0 ? 'bg-accent' : 'bg-text'}"
                style="width: {Math.min(100, (plan.prospects.used / plan.prospects.limit) * 100)}%"
              ></div>
            </div>
          {/if}
        </div>
      {/if}
    </div>
  </div>

  {#if EDITION === 'cloud' && plan.plan === 'free'}
    <div class="flex items-center justify-between mb-4">
      <p class="text-xs font-medium text-text-secondary">Upgrade</p>
      <div class="inline-flex rounded border border-border text-xs">
        <button
          onclick={() => (billingPeriod = 'monthly')}
          class="px-3 py-1 {billingPeriod === 'monthly'
            ? 'bg-surface-2 text-text font-medium'
            : 'text-text-muted hover:text-text'}"
        >
          Monthly
        </button>
        <button
          onclick={() => (billingPeriod = 'yearly')}
          class="px-3 py-1 {billingPeriod === 'yearly'
            ? 'bg-surface-2 text-text font-medium'
            : 'text-text-muted hover:text-text'}"
        >
          Yearly
          <span class="ml-1 text-[10px] text-accent">−17%</span>
        </button>
      </div>
    </div>

    <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
      {#each TIERS as tier}
        {@const price = billingPeriod === 'monthly' ? tier.monthlyPrice : tier.yearlyPrice}
        {@const suffix = billingPeriod === 'monthly' ? '/month' : '/year'}
        <div class="rounded-md border border-border p-4 flex flex-col">
          <p class="text-sm font-medium text-text">{tier.name}</p>
          <p class="mt-1">
            <span class="font-mono text-xl font-semibold text-text">${price}</span>
            <span class="text-xs text-text-muted">{suffix}</span>
          </p>
          <ul class="mt-3 space-y-1 text-xs text-text-secondary flex-1">
            <li>{tier.projects}</li>
            <li>{tier.outreach}</li>
          </ul>
          <button
            onclick={() => handleUpgrade(tier)}
            disabled={checkoutLoading !== null}
            class="mt-4 w-full rounded px-3 py-1.5 text-xs font-medium text-page bg-accent hover:bg-accent-strong transition-colors disabled:opacity-50"
          >
            {checkoutLoading === tier.tier ? 'Redirecting...' : `Upgrade to ${tier.name}`}
          </button>
        </div>
      {/each}
    </div>
  {/if}
{/if}
