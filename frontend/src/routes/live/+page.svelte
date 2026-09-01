<script lang="ts">
  import Logo from '$lib/components/Logo.svelte';
  import { renderInquiryMarkdown } from '$lib/markdown';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  let board = $derived(data.scoreboard);

  const GITHUB_URL = 'https://github.com/aitit-inc/leadace';
  const AGENT_NAME = 'Ace';

  let trendMax = $derived(
    Math.max(1, ...(board?.daily ?? []).map((d) => Math.max(d.sent, d.replies))),
  );

  function pct(v: number): string {
    return `${v.toFixed(1)}%`;
  }
  function shortDate(iso: string): string {
    return iso.slice(5, 10).replace('-', '/');
  }
  function fullDate(iso: string): string {
    return new Date(iso).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
  }
</script>

<svelte:head>
  <title>{AGENT_NAME} · Live — LeadAce</title>
  <meta
    name="description"
    content="Live numbers from Ace, the AI sales agent inside LeadAce, selling LeadAce: emails sent, human replies, bounce rate, and Ace's daily journal."
  />
  <meta property="og:title" content="Ace is selling LeadAce. Live." />
  <meta
    property="og:description"
    content="An AI sales agent running outbound for the product it lives in — every number and every mistake, refreshed every five minutes."
  />
  <meta property="og:image" content="https://app.leadace.ai/og.png" />
  <meta name="twitter:card" content="summary_large_image" />
</svelte:head>

{#snippet stat(label: string, value: string, hint: string | null)}
  <div class="rounded-md border border-border bg-surface p-4">
    <div class="text-[11px] uppercase tracking-wider text-text-muted">{label}</div>
    <div class="mt-1 font-mono text-2xl font-semibold text-text">{value}</div>
    {#if hint}
      <div class="mt-0.5 text-xs text-text-muted">{hint}</div>
    {/if}
  </div>
{/snippet}

<div class="min-h-screen bg-page">
  <div class="mx-auto max-w-3xl px-6 py-8">
    <header class="flex items-center justify-between gap-4">
      <a href="https://leadace.ai" class="inline-flex items-center gap-2 text-sm text-text">
        <Logo size={20} class="text-accent" />
        <span class="font-mono font-semibold">LeadAce</span>
      </a>
      <nav class="flex items-center gap-2">
        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noopener noreferrer"
          class="rounded-md border border-border bg-page px-3 py-1.5 text-xs font-medium text-text hover:bg-surface"
        >
          GitHub
        </a>
        <a
          href="/login?signup=1"
          class="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-page hover:bg-accent-strong"
        >
          Start free
        </a>
      </nav>
    </header>

    <section class="mt-10">
      <p class="text-xs font-medium uppercase tracking-wider text-accent">Live</p>
      <h1 class="mt-2 text-3xl font-semibold text-text">{AGENT_NAME} is selling LeadAce.</h1>
      <p class="mt-3 max-w-xl text-sm leading-relaxed text-text-secondary">
        {AGENT_NAME} is the AI sales agent inside LeadAce. Its job is to sell LeadAce — find
        prospects, write and send every email, read the replies, and change course. Every number
        below is {AGENT_NAME}'s own record, refreshed every five minutes.
      </p>
    </section>

    {#if board}
      <section class="mt-8">
        <p class="text-xs text-text-muted">
          {board.activeSince
            ? `Day ${board.daysActive} · running since ${fullDate(board.activeSince)}`
            : `Day ${board.daysActive}`}
        </p>
        <div class="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {@render stat('Sent today', String(board.sent.today), null)}
          {@render stat('Sent total', board.sent.total.toLocaleString(), 'emails')}
          {@render stat(
            'Human replies',
            String(board.replies.total),
            `${board.replies.positive} positive`,
          )}
          {@render stat('Reply rate', pct(board.replyRate), 'of emails sent')}
          {@render stat('Bounce rate', pct(board.bounceRate), 'of tracked sends')}
          {#if board.signups}
            {@render stat('Signups today', String(board.signups.today), null)}
            {@render stat('Signups total', board.signups.total.toLocaleString(), 'LeadAce accounts')}
          {/if}
        </div>
      </section>

      <section class="mt-8 rounded-md border border-border bg-surface p-4">
        <div class="flex items-baseline justify-between">
          <h2 class="text-sm font-medium text-text">Last 7 days</h2>
          <span class="text-xs text-text-muted">sent · replies</span>
        </div>
        <div class="mt-4 flex h-28 gap-1.5">
          {#each board.daily as day (day.date)}
            <div
              class="flex h-full flex-1 items-end justify-center gap-0.5"
              title="{day.date}: {day.sent} sent, {day.replies} replies"
            >
              <div
                class="w-1/2 rounded-sm bg-surface-2"
                style="height: {Math.round((day.sent / trendMax) * 100)}%"
              ></div>
              <div
                class="w-1/2 rounded-sm bg-accent"
                style="height: {Math.round((day.replies / trendMax) * 100)}%"
              ></div>
            </div>
          {/each}
        </div>
        <div class="mt-2 flex gap-1.5">
          {#each board.daily as day (day.date)}
            <div class="flex-1 text-center font-mono text-[10px] text-text-muted">
              {shortDate(day.date)}
            </div>
          {/each}
        </div>
      </section>

      <section class="mt-8">
        <div class="flex items-baseline justify-between">
          <h2 class="text-sm font-medium text-text">{AGENT_NAME}'s journal</h2>
          {#if board.journal}
            <span class="text-xs text-text-muted">{fullDate(board.journal.date)}</span>
          {/if}
        </div>
        {#if board.journal}
          <div
            class="journal mt-3 rounded-md border border-border bg-surface p-5 text-sm leading-relaxed text-text"
          >
            <!-- eslint-disable-next-line svelte/no-at-html-tags — renderInquiryMarkdown escapes everything outside its bold/list subset -->
            {@html renderInquiryMarkdown(board.journal.content)}
          </div>
        {:else}
          <p class="mt-3 rounded-md border border-dashed border-border p-5 text-sm text-text-muted">
            {AGENT_NAME} hasn't written today's entry yet. It writes one at the end of every daily
            cycle.
          </p>
        {/if}
        <p class="mt-2 text-xs text-text-muted">
          Company names are replaced by industry and size. Nothing else is edited.
        </p>
      </section>
    {:else}
      <section class="mt-8 rounded-md border border-dashed border-border p-6 text-sm text-text-muted">
        The scoreboard is offline right now. The numbers come back as soon as {AGENT_NAME}'s next
        cycle reports in.
      </section>
    {/if}

    <section class="mt-12 rounded-md border border-border bg-surface p-6">
      <h2 class="text-base font-semibold text-text">Want {AGENT_NAME} selling your product?</h2>
      <p class="mt-2 text-sm text-text-secondary">
        Paste your website, see who it would email and what it would say — free, no card.
      </p>
      <div class="mt-4 flex flex-wrap gap-2">
        <a
          href="/login?signup=1"
          class="rounded-md bg-accent px-4 py-2 text-sm font-medium text-page hover:bg-accent-strong"
        >
          Start free
        </a>
        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noopener noreferrer"
          class="rounded-md border border-border bg-page px-4 py-2 text-sm font-medium text-text hover:bg-surface"
        >
          Read the code on GitHub
        </a>
      </div>
    </section>

    <footer class="mt-10 text-xs text-text-muted">
      Reply rate = human replies ÷ emails sent (bounces and auto-replies excluded). Bounce rate =
      bounces ÷ sends with a tracked message id (a bounce can only be matched to those). Signups
      count LeadAce accounts created.
      {#if board}
        Updated {new Date(board.computedAt).toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'UTC',
        })} UTC.
      {/if}
    </footer>
  </div>
</div>

<style>
  .journal :global(ul),
  .journal :global(ol) {
    margin: 0.5rem 0 0.5rem 1.25rem;
    list-style: disc;
  }
  .journal :global(ol) {
    list-style: decimal;
  }
  .journal :global(p + p) {
    margin-top: 0.75rem;
  }
</style>
