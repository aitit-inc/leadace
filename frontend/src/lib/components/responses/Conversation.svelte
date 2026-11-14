<script lang="ts">
  import type { ConversationMessage } from '$lib/types/responses';
  import ChannelBadge from '$lib/components/ChannelBadge.svelte';
  import SentimentBadge from '$lib/components/SentimentBadge.svelte';
  import AnswerState from './AnswerState.svelte';

  let {
    messages,
    prospectName,
    token,
    onChanged,
  }: { messages: ConversationMessage[]; prospectName: string; token: string | undefined; onChanged: () => void } = $props();

  function formatDate(iso: string) {
    return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
</script>

<ol class="space-y-3">
  {#each messages as m}
    <li class="rounded-xl px-4 py-3 {m.kind === 'received' ? 'bg-inbound/10' : 'bg-page'}">
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
        {#if m.kind === 'received'}
          <span class="text-sm font-semibold text-inbound">{prospectName}</span>
        {:else}
          <span class="text-sm font-semibold text-text">{m.from ?? 'You'}</span>
        {/if}
        <span class="tabular-nums">{formatDate(m.at)}</span>
        <ChannelBadge channel={m.channel} />
        {#if m.kind === 'received'}
          <SentimentBadge sentiment={m.sentiment} />
          <span>{m.responseType.replace(/_/g, ' ')}</span>
        {/if}
      </div>
      {#if m.kind === 'sent'}
        {#if m.subject}<p class="mt-2 break-words text-sm font-medium text-text">{m.subject}</p>{/if}
        <p class="mt-1 whitespace-pre-wrap break-words text-sm text-text-secondary">{m.body}</p>
      {:else}
        <p class="mt-2 whitespace-pre-wrap break-words text-sm text-text">{m.text}</p>
        {#if m.quoted}
          <details class="mt-2 text-sm">
            <summary class="cursor-pointer text-text-muted">Quoted text</summary>
            <p class="mt-1 whitespace-pre-wrap break-words text-text-muted">{m.quoted}</p>
          </details>
        {/if}
        <AnswerState response={m} {token} {onChanged} />
      {/if}
    </li>
  {/each}
</ol>
