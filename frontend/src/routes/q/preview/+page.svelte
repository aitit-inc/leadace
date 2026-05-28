<script lang="ts">
  import type { InquiryLandingPayload } from '$lib/api/inquiry';
  import InquiryLandingView from '$lib/components/inquiry/InquiryLandingView.svelte';
  import Logo from '$lib/components/Logo.svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  let landing = $derived<InquiryLandingPayload | null>(
    data.result.state === 'ready' ? data.result.landing : null,
  );
</script>

<svelte:head>
  <title>Inquiry preview · LeadAce</title>
  <meta name="robots" content="noindex" />
</svelte:head>

{#if data.result.state === 'invalid'}
  <div class="min-h-screen bg-page">
    <div class="mx-auto max-w-2xl px-6 py-10">
      <a href="/" class="inline-flex items-center gap-1.5 text-xs text-text-muted hover:text-text">
        <Logo size={14} class="text-accent" />
        ← LeadAce
      </a>
      <h1 class="mt-4 text-2xl font-semibold text-text">Preview unavailable</h1>
      <p class="mt-3 text-sm leading-relaxed text-text-secondary">{data.result.message}</p>
    </div>
  </div>
{:else if landing}
  <InquiryLandingView {landing} mode="preview" />
{/if}
