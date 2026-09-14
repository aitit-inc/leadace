<script lang="ts">
  import { onMount } from 'svelte';
  import { invalidate } from '$app/navigation';
  import { page } from '$app/state';
  import { createCheckoutSession, createPortalSession } from '$lib/api/billing';
  import { formatQuota, QUOTA_WINDOW_LABEL } from '$lib/format';
  import { creditsCoverOverage } from '$lib/credits';
  import { USAGE_PRICE_CENTS } from '$lib/types/plan';
  import CreditsPanel from '$lib/components/plans/CreditsPanel.svelte';
  import { EDITION, STRIPE_PRICES } from '$lib/config';
  import type { PlanTier } from '$lib/types/plan';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  let token = $derived(data.session?.access_token);
  let plan = $derived(data.plan);

  let checkoutLoading = $state<string | null>(null);
  let portalLoading = $state(false);
  let message = $state('');

  interface PaidTier {
    tier: Exclude<PlanTier, 'free'>;
    name: string;
    monthlyPrice: number;
    projects: string;
    outreach: string;
    priceId: string | undefined;
  }

  const TIERS: PaidTier[] = [
    {
      tier: 'starter',
      name: 'Starter',
      monthlyPrice: 49,
      projects: '1 project · 1 mailbox',
      outreach: '100 prospects / month',
      priceId: STRIPE_PRICES.starter,
    },
    {
      tier: 'pro',
      name: 'Pro',
      monthlyPrice: 99,
      projects: '5 projects · 3 mailboxes',
      outreach: '300 prospects / month',
      priceId: STRIPE_PRICES.pro,
    },
    {
      tier: 'scale',
      name: 'Scale',
      monthlyPrice: 199,
      projects: 'Unlimited projects · 10 mailboxes',
      outreach: '800 prospects / month',
      priceId: STRIPE_PRICES.scale,
    },
  ];

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

  onMount(() => {
    if (EDITION === 'cloud') {
      const status = page.url.searchParams.get('checkout');
      if (status === 'success') {
        message = 'Subscription activated. Waiting for confirmation…';
        pollPlanUntilChanged(() => data.plan?.plan ?? null).then(() => {
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
        {#if plan.quota.kind === 'unlimited'}
          <div>
            <p class="text-xs text-text-muted mb-1">Prospects</p>
            <p class="font-mono text-lg text-text">unlimited</p>
          </div>
        {:else}
          {@const label = QUOTA_WINDOW_LABEL[plan.quota.window]}
          {@const allowances = [
            { label: `New prospects contacted (${label})`, usage: plan.quota.contacted },
            { label: `Found by LeadAce (${label})`, usage: plan.quota.found },
          ]}
          {#each allowances as { label, usage } (label)}
            <div>
              <p class="text-xs text-text-muted mb-1">{label}</p>
              <p class="font-mono text-lg text-text">
                {formatQuota(usage.used, usage.limit)}
              </p>
              <div class="mt-1.5 h-1 w-full rounded-full bg-surface">
                <div
                  class="h-1 rounded-full {usage.remaining === 0 && !creditsCoverOverage(plan.quota.credits, USAGE_PRICE_CENTS.contacted)
                    ? 'bg-accent'
                    : 'bg-text'}"
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
          <p class="text-xs text-text-muted mb-1">Stored prospects</p>
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

  {#if EDITION === 'cloud' && plan.quota.kind === 'capped' && plan.quota.credits}
    <CreditsPanel
      credits={plan.quota.credits}
      {token}
      onChanged={() => invalidate('app:plan')}
    />
  {/if}

  {#if EDITION === 'cloud' && plan.plan === 'free'}
    <p class="text-xs font-medium text-text-secondary mb-4">Upgrade</p>

    <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
      {#each TIERS as tier}
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
