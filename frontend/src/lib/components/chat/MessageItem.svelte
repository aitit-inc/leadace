<script lang="ts">
  import { Wrench } from '@lucide/svelte';
  import { renderInquiryMarkdown } from '$lib/markdown';
  import type { ChatContent } from '$lib/types/chat';

  let { content }: { content: ChatContent } = $props();
  let expanded = $state(false);

  function responseText(r: Record<string, unknown>): string {
    const v = r['result'] ?? r['error'];
    return typeof v === 'string' ? v : JSON.stringify(v);
  }
</script>

{#if content.role === 'user'}
  <div class="flex justify-end">
    <div class="max-w-[80%] whitespace-pre-wrap rounded-lg bg-text px-3 py-2 text-sm text-page">
      {content.parts.map((p) => p.text).join('')}
    </div>
  </div>
{:else if content.role === 'model'}
  {@const text = content.parts.flatMap((p) => ('text' in p ? [p.text] : [])).join('')}
  {@const calls = content.parts.flatMap((p) => ('functionCall' in p ? [p.functionCall] : []))}
  <div class="max-w-[85%] space-y-1">
    {#if text}
      <div class="prose-chat text-sm text-text">{@html renderInquiryMarkdown(text)}</div>
    {/if}
    {#each calls as call (call.id)}
      <div class="inline-flex items-center gap-1 rounded bg-surface px-2 py-0.5 font-mono text-[11px] text-text-secondary">
        <Wrench size={11} /> {call.name}
      </div>
    {/each}
  </div>
{:else if content.role === 'tool'}
  <div class="max-w-[85%]">
    <button type="button" class="text-[11px] text-text-muted hover:text-text" onclick={() => (expanded = !expanded)}>
      {content.parts.length} tool result{content.parts.length === 1 ? '' : 's'} {expanded ? '▾' : '▸'}
    </button>
    {#if expanded}
      {#each content.parts as p (p.functionResponse.id)}
        <pre class="mt-1 max-h-64 overflow-auto rounded bg-surface p-2 font-mono text-[11px] text-text-secondary">{p.functionResponse.name}
{responseText(p.functionResponse.response)}</pre>
      {/each}
    {/if}
  </div>
{:else}
  <div class="rounded border border-border bg-surface px-3 py-2 text-xs text-text-secondary">
    <span class="font-medium text-text">{content.kind}</span> {content.status}: {content.summary}
  </div>
{/if}

<style>
  .prose-chat :global(p) {
    margin: 0 0 0.5rem;
  }
  .prose-chat :global(ul),
  .prose-chat :global(ol) {
    margin: 0 0 0.5rem 1.1rem;
    list-style: disc;
  }
  .prose-chat :global(ol) {
    list-style: decimal;
  }
</style>
