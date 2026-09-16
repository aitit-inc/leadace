<script lang="ts">
  import {
    sendChatMessage,
    unsubscribeInquiry,
    requestMeeting,
    recordSignupClick,
    type InquiryLandingPayload,
    type InquiryPrimaryReason,
  } from '$lib/api/inquiry';
  import { browserLocale } from '$lib/browser-locale';
  import InquiryLandingView from '$lib/components/inquiry/InquiryLandingView.svelte';
  import Logo from '$lib/components/Logo.svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  let landing = $derived<InquiryLandingPayload | null>(
    data.result.state === 'ready' ? data.result.landing : null,
  );
  let shortId = $derived(data.shortId);

  function chatHandler(message: string) {
    return sendChatMessage(shortId, message, browserLocale());
  }

  async function meetingHandler() {
    await requestMeeting(shortId, undefined);
  }

  async function signupHandler() {
    await recordSignupClick(shortId);
  }

  async function unsubscribeHandler(reason: InquiryPrimaryReason | null) {
    await unsubscribeInquiry(shortId, reason ? { primary_reason: reason } : {});
  }
</script>

<svelte:head>
  <title>LeadAce</title>
  <meta name="robots" content="noindex" />
</svelte:head>

{#if data.result.state === 'invalid'}
  <div class="min-h-screen bg-page">
    <div class="mx-auto max-w-2xl px-6 py-10">
      <a href="/" class="inline-flex items-center gap-2 text-text hover:text-text-secondary">
        <Logo size={22} class="text-accent" />
        <span class="font-display text-lg font-semibold tracking-tight">LeadAce</span>
      </a>
      <h1 class="mt-10 font-display text-3xl font-semibold tracking-tight text-text">Link expired</h1>
      <p class="mt-3 text-base leading-relaxed text-text-secondary">{data.result.message}</p>
      <p class="mt-3 text-sm text-text-muted">
        If you got here from one of our partners' emails and the link is broken, just reply to that
        email and they'll follow up directly.
      </p>
    </div>
  </div>
{:else if landing}
  <InquiryLandingView
    {landing}
    onSendChat={chatHandler}
    onRequestMeeting={meetingHandler}
    onSignupClick={signupHandler}
    onUnsubscribe={unsubscribeHandler}
  />
{/if}
