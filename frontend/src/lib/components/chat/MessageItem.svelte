<script lang="ts">
  import { renderChatMarkdown } from '$lib/chat-markdown';
  import { humanize } from '$lib/attention-meta';
  import AttachmentChip from './AttachmentChip.svelte';
  import type { ChatAttachment, ChatContent } from '$lib/types/chat';

  let {
    content,
    onopenfile,
  }: { content: Exclude<ChatContent, { role: 'job' }>; onopenfile?: (file: ChatAttachment) => void } = $props();
  let expanded = $state(false);

  function stepResult(r: Record<string, unknown>): string {
    const v = r['result'] ?? r['error'];
    return typeof v === 'string' ? v : '';
  }
</script>

{#if content.role === 'user'}
  {@const files = content.parts.flatMap((p) => ('file' in p ? [p.file] : []))}
  {@const text = content.parts.flatMap((p) => ('text' in p ? [p.text] : [])).join('')}
  <div class="flex flex-col items-end gap-1.5">
    {#if files.length > 0}
      <div class="flex max-w-[80%] flex-wrap justify-end gap-1.5">
        {#each files as file (file.id)}
          <AttachmentChip name={file.name} size={file.size} onopen={onopenfile && (() => onopenfile(file))} />
        {/each}
      </div>
    {/if}
    {#if text}
      <div class="max-w-[80%] whitespace-pre-wrap rounded-3xl rounded-br-lg bg-surface-2 px-4 py-2.5 text-base text-text">{text}</div>
    {/if}
  </div>
{:else if content.role === 'model'}
  {@const text = content.parts.flatMap((p) => ('text' in p ? [p.text] : [])).join('')}
  {#if text}
    <div class="prose-chat max-w-[85%] text-base leading-relaxed text-text">{@html renderChatMarkdown(text)}</div>
  {/if}
{:else}
  <div class="max-w-[85%]">
    <button type="button" class="text-xs font-semibold text-text-muted hover:text-text" onclick={() => (expanded = !expanded)}>
      {content.parts.length} step{content.parts.length === 1 ? '' : 's'} {expanded ? '▾' : '▸'}
    </button>
    {#if expanded}
      <dl class="mt-1 space-y-1 border-l-2 border-border pl-3 text-xs text-text-muted">
        {#each content.parts as p (p.functionResponse.id)}
          <dt class="text-text-secondary">{humanize(p.functionResponse.name)}</dt>
          <dd class="max-h-40 overflow-auto whitespace-pre-wrap">{stepResult(p.functionResponse.response)}</dd>
        {/each}
      </dl>
    {/if}
  </div>
{/if}

<style>
  .prose-chat :global(p) {
    margin: 0 0 0.5rem;
  }
  /* padding, not margin: an outside marker sits left of the content edge, where the scrolling column clips it */
  .prose-chat :global(ul),
  .prose-chat :global(ol) {
    margin: 0 0 0.5rem;
    padding-left: 2rem;
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
