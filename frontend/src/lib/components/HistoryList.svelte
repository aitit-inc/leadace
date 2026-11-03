<script lang="ts">
  import type { HistoryRow } from '$lib/types/dashboard';

  let { rows }: { rows: HistoryRow[] } = $props();

  function fmtDay(day: string): string {
    return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  }
</script>

{#snippet line(row: HistoryRow)}
  <span class="w-12 shrink-0 text-xs tabular-nums text-text-muted">{fmtDay(row.date)}</span>
  <span class="min-w-0 break-words">
    {#if row.who}<span class="chip mr-1 text-text-secondary ring-1 ring-inset ring-border">{row.who}</span>{/if}
    <span class={row.who ? 'text-text' : 'text-text-secondary'}>{row.text}</span>
    {#if row.result}<span class="mt-0.5 block text-xs tabular-nums text-text-muted">{row.result}</span>{/if}
  </span>
{/snippet}

<ul class="space-y-2 text-sm">
  {#each rows as row}
    <li>
      {#if row.notes.length > 0 || row.who === null}
        <details>
          <summary class="flex cursor-pointer gap-3 rounded-lg hover:bg-surface-2">{@render line(row)}</summary>
          <div class="mt-1 space-y-1 pl-15 text-xs text-text-secondary">
            {#each row.notes as note}<p>{note}</p>{/each}
            {#if row.who === null}
              <p>
                <a href="/outreach" class="text-accent-strong hover:underline">Each message</a> ·
                <a href="/responses" class="text-accent-strong hover:underline">Each reply</a>
              </p>
            {/if}
          </div>
        </details>
      {:else}
        <div class="flex gap-3">{@render line(row)}</div>
      {/if}
    </li>
  {/each}
</ul>
