<script lang="ts">
  import { Wrench } from '@lucide/svelte';
  import { renderChatMarkdown } from '$lib/chat-markdown';
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
    <div class="max-w-[80%] whitespace-pre-wrap rounded-lg bg-text px-3 py-2 text-base text-page">
      {content.parts.map((p) => p.text).join('')}
    </div>
  </div>
{:else if content.role === 'model'}
  {@const text = content.parts.flatMap((p) => ('text' in p ? [p.text] : [])).join('')}
  {@const calls = content.parts.flatMap((p) => ('functionCall' in p ? [p.functionCall] : []))}
  <div class="max-w-[85%] space-y-1">
    {#if text}
      <div class="prose-chat text-base text-text">{@html renderChatMarkdown(text)}</div>
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
  .prose-chat :global(h1),
  .prose-chat :global(h2),
  .prose-chat :global(h3) {
    margin: 0.7rem 0 0.3rem;
    font-weight: 600;
  }
  .prose-chat :global(h1) {
    font-size: 1.15em;
  }
  .prose-chat :global(h2) {
    font-size: 1.05em;
  }
  .prose-chat :global(a) {
    text-decoration: underline;
  }
  .prose-chat :global(code) {
    border-radius: 0.2rem;
    background: var(--color-surface);
    padding: 0.05rem 0.25rem;
    font-family: ui-monospace, monospace;
    font-size: 0.9em;
  }
  .prose-chat :global(pre) {
    margin: 0 0 0.5rem;
    overflow-x: auto;
    border-radius: 0.3rem;
    background: var(--color-surface);
    padding: 0.5rem;
  }
  .prose-chat :global(pre code) {
    background: none;
    padding: 0;
  }
  /* block, so a wide table scrolls inside the bubble instead of widening it */
  .prose-chat :global(table) {
    display: block;
    overflow-x: auto;
    margin: 0 0 0.5rem;
    border-collapse: collapse;
  }
  .prose-chat :global(th),
  .prose-chat :global(td) {
    border: 1px solid var(--color-border);
    padding: 0.2rem 0.45rem;
    text-align: left;
    white-space: nowrap;
  }
  .prose-chat :global(th) {
    font-weight: 600;
  }
  .prose-chat :global(blockquote) {
    margin: 0 0 0.5rem;
    border-left: 2px solid var(--color-border);
    padding-left: 0.6rem;
    color: var(--color-text-secondary);
  }
  .prose-chat :global(hr) {
    margin: 0.7rem 0;
    border: 0;
    border-top: 1px solid var(--color-border);
  }
</style>
