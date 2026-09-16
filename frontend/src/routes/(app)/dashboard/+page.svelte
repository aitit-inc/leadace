<script lang="ts">
  import { goto, invalidate } from '$app/navigation';
  import type { PageProps } from './$types';
  import type {
    AttentionItem,
    DashboardActivityKind,
    DashboardPeriod,
    FunnelStageKey,
    JournalEvent,
  } from '$lib/types/dashboard';
  import type { FunnelStageFilter } from '$lib/types/outreach';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import SuggestionsSection from '$lib/components/dashboard/SuggestionsSection.svelte';
  import {
    Send,
    MailCheck,
    MousePointerClick,
    MessagesSquare,
    Trophy,
    TrendingUp,
    TrendingDown,
    Banknote,
    Brain,
    FlaskConical,
    MessageSquareX,
    Lightbulb,
    UserPlus,
    Clock,
    Check,
    Target,
  } from '@lucide/svelte';
  import { attentionMeta, humanize, type AttentionMeta } from '$lib/attention-meta';

  let { data }: PageProps = $props();
  let summary = $derived(data.summary);
  let token = $derived(data.session?.access_token);

  const PERIODS = [
    { key: '7d', label: '7d' },
    { key: '30d', label: '30d' },
    { key: 'all', label: 'All' },
  ] as const;

  function setPeriod(p: string) {
    goto(`?period=${p}`, { replaceState: true, keepFocus: true, noScroll: true });
  }

  // One card per funnel stage: KPI count + period delta + conversion from the
  // previous stage, linking to the /outreach drill-down for the same events.
  // summary.funnel owns which stages exist — it drops 'reached' when the project
  // sends no inquiry link, so the card row follows it rather than a fixed list.
  // `stage` indexes summary.kpis and is the /outreach?stage= param.
  const STAGE_DEFS: Record<
    FunnelStageKey,
    { stage: FunnelStageFilter; label: string; icon: typeof Send; sub: string; inbound: boolean }
  > = {
    sent: { stage: 'approached', label: 'Approached', icon: Send, sub: 'prospects contacted', inbound: false },
    delivered: { stage: 'delivered', label: 'Delivered', icon: MailCheck, sub: 'no bounce came back', inbound: false },
    reached: { stage: 'reached', label: 'Reached', icon: MousePointerClick, sub: 'opened their page', inbound: true },
    engaged: { stage: 'engaged', label: 'Engaged', icon: MessagesSquare, sub: 'replied, chatted, or signed up', inbound: true },
    won: { stage: 'won', label: 'Won', icon: Trophy, sub: 'meetings + signups', inbound: true },
  };
  let stageCards = $derived(
    summary
      ? summary.funnel.map((s, i) => {
          const def = STAGE_DEFS[s.key];
          const prev = summary.funnel[i - 1];
          return {
            ...def,
            key: s.key,
            value: summary.kpis[def.stage],
            conversion: s.conversionFromPrev,
            prevLabel: prev ? STAGE_DEFS[prev.key].label.toLowerCase() : null,
          };
        })
      : [],
  );

  function stageHref(stage: string): string {
    return data.period === 'all' ? `/outreach?stage=${stage}` : `/outreach?stage=${stage}&period=${data.period}`;
  }

  const PERIOD_PHRASE: Record<DashboardPeriod, string> = {
    '7d': 'In the last 7 days',
    '30d': 'In the last 30 days',
    all: 'So far',
  };

  const LEARNING_STAGE_LABELS: Record<string, string> = {
    targeting: 'Targeting',
    body: 'Message',
    timing: 'Timing',
    channel: 'Channel',
    discovery: 'Discovery',
  };
  const LEARNINGS_SHOWN = 6;
  const JOURNAL_SHOWN = 5;

  function fmtDay(day: string): string {
    const d = new Date(`${day}T00:00:00Z`);
    return Number.isNaN(d.getTime())
      ? day
      : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  }

  function journalText(e: JournalEvent): { text: string; detail: string | null } {
    if (e.kind === 'variant_added') {
      return { text: `Started testing a new angle “${e.label ?? e.variantId}”`, detail: null };
    }
    if (e.kind === 'variant_archived') {
      const name = e.label ?? e.variantId;
      const detail =
        e.pBest !== null && e.n !== null ? `win chance ${Math.round(e.pBest * 100)}% · ${e.n} sends` : null;
      return e.reason === 'stagnation'
        ? { text: `Swapped out “${name}” — results stayed flat`, detail }
        : { text: `Retired “${name}” — a stronger angle won`, detail };
    }
    return { text: `Flagged for your review: ${e.title}`, detail: null };
  }
  let trendMax = $derived(Math.max(1, ...(summary?.trend ?? []).map((t) => t.sent)));
  let hasTrendActivity = $derived((summary?.trend ?? []).some((t) => t.sent > 0 || t.responses > 0));
  // Reply rate is the selected-window KPI, independent of the fixed 30-day trend bars below it.
  let hasReplyData = $derived((summary?.kpis.approached.current ?? 0) > 0);
  let rejectionMax = $derived(Math.max(1, ...(summary?.rejections.topReasons ?? []).map((r) => r.percentage)));

  // Opportunity/queue/degradation kinds don't stop sending — autopilot stays "on".
  const SENDING_BLOCKERS: AttentionItem['kind'][] = [
    'no_project',
    'compliance_incomplete',
    'gmail_disconnected',
    'gmail_auth_revoked',
    'no_outbound_channels',
    'quota_exhausted',
  ];
  let paused = $derived(summary?.attention.some((a) => SENDING_BLOCKERS.includes(a.kind)) ?? false);

  function timeAgo(iso: string): string {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '';
    const mins = Math.max(0, Math.floor((Date.now() - then) / 60000));
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }

  const TONE_CHIP: Record<AttentionMeta['tone'], string> = {
    accent: 'bg-accent/15 text-accent-strong',
    inbound: 'bg-inbound/15 text-inbound',
    danger: 'bg-danger/15 text-danger',
    warning: 'bg-warning/15 text-warning',
  };

  type ActivityMeta = { label: string; chip: string; muted: boolean };
  function activityMeta(kind: DashboardActivityKind): ActivityMeta {
    switch (kind) {
      case 'meeting':
        return { label: 'Meeting request', chip: 'bg-inbound/15 text-inbound', muted: false };
      case 'signup':
        return { label: 'Signed up', chip: 'bg-inbound/15 text-inbound', muted: false };
      case 'replied':
        return { label: 'Replied', chip: 'bg-inbound/15 text-inbound', muted: false };
      case 'inquired':
        return { label: 'Chatted', chip: 'bg-inbound/15 text-inbound', muted: false };
      case 'opened':
        return { label: 'Opened page', chip: 'bg-surface-2 text-text-secondary', muted: true };
      case 'unsubscribed':
        return { label: 'Unsubscribed', chip: 'bg-danger/15 text-danger', muted: false };
      case 'failed':
        return { label: 'Send failed', chip: 'bg-danger/15 text-danger', muted: false };
      case 'skipped':
        return { label: 'Skipped', chip: 'bg-surface-2 text-text-secondary', muted: true };
      case 'sent':
        return { label: 'Sent', chip: 'bg-surface-2 text-text-secondary', muted: true };
    }
  }
</script>

<svelte:head>
  <title>Home · LeadAce</title>
</svelte:head>

{#if summary}
  {@const approached = summary.kpis.approached.current}
  {@const engaged = summary.kpis.engaged.current}
  {@const won = summary.kpis.won.current}
  <div class="mx-auto max-w-5xl space-y-6">
    <header class="space-y-4">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
        {#if paused}
          <span class="chip bg-warning/10 text-warning">
            <span class="h-1.5 w-1.5 rounded-full bg-warning"></span>
            Paused
          </span>
        {:else}
          <span class="chip bg-inbound/10 text-inbound">
            <span class="h-1.5 w-1.5 rounded-full bg-inbound"></span>
            Autopilot on
          </span>
        {/if}
        {#if summary.lastCycleDate}
          <span class="text-sm text-text-muted">Last cycle {fmtDay(summary.lastCycleDate)}</span>
        {/if}
        <div class="ml-auto inline-flex rounded-full bg-surface-2 p-0.5" role="group" aria-label="Period">
          {#each PERIODS as p}
            <button
              type="button"
              onclick={() => setPeriod(p.key)}
              aria-pressed={data.period === p.key}
              class="rounded-full px-3 py-1 text-sm transition-colors {data.period === p.key
                ? 'bg-surface font-semibold text-text'
                : 'text-text-secondary hover:text-text'}"
            >
              {p.label}
            </button>
          {/each}
        </div>
      </div>
      <h1 class="max-w-3xl font-display text-3xl font-semibold leading-tight tracking-tight text-balance text-text">
        <!-- Sends count by send date and engagement by reply date, so each is stated on its own. -->
        {#if approached > 0}
          {PERIOD_PHRASE[data.period]}, Ace contacted
          <span class="tabular-nums text-accent-strong">{approached}</span>
          {approached === 1 ? 'prospect' : 'prospects'}.
        {:else if data.period === 'all'}
          Ace hasn't contacted anyone yet.
        {:else}
          {PERIOD_PHRASE[data.period]}, Ace didn't contact any new prospects.
        {/if}
        {#if engaged > 0}
          <span class="tabular-nums text-inbound">{engaged}</span>
          {engaged === 1 ? 'prospect' : 'prospects'} engaged{#if won > 0}, and
            <span class="tabular-nums text-inbound">{won}</span>
            turned into {won === 1 ? 'a meeting or sign-up' : 'meetings or sign-ups'}{/if}.
        {:else if approached > 0}
          No one has engaged yet.
        {/if}
      </h1>
    </header>

    <div class="space-y-3">
      {#if summary.attention.length > 0}
        <section class="card overflow-hidden">
          <div class="flex items-center gap-2 px-5 pb-2 pt-4">
            <h2 class="font-display text-lg font-semibold text-text">Needs your attention</h2>
            <span class="chip bg-surface-2 tabular-nums text-text-secondary">{summary.attention.length}</span>
            <span class="ml-auto hidden text-sm text-text-muted sm:inline">Things the AI can't decide for you</span>
          </div>
          <div class="divide-y divide-border">
            {#each summary.attention as item}
              {@const meta = attentionMeta(item)}
              {@const Icon = meta.icon}
              <div class="flex items-center gap-3 px-5 py-3">
                <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full {TONE_CHIP[meta.tone]}">
                  <Icon size={18} />
                </span>
                <div class="min-w-0 flex-1">
                  <p class="text-sm font-semibold text-text">{meta.title}</p>
                  <p class="truncate text-sm text-text-secondary">{meta.desc}</p>
                </div>
                <a href={meta.href} class="btn btn-sm shrink-0 {meta.tone === 'accent' ? 'btn-primary' : 'btn-secondary'}">
                  {meta.ctaLabel}
                </a>
              </div>
            {/each}
          </div>
        </section>
      {/if}

      {#if data.suggestions.length > 0}
        <SuggestionsSection
          suggestions={data.suggestions}
          {token}
          onChanged={() => invalidate('app:suggestions')}
        />
      {/if}

      {#if summary.attention.length === 0 && data.suggestions.length === 0}
        <section class="card flex items-center gap-4 p-5">
          <span class="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-inbound/15 text-inbound">
            <Check size={24} />
          </span>
          <div>
            <h2 class="font-display text-lg font-semibold text-text">All clear — nothing needs you</h2>
            <p class="mt-0.5 text-sm text-text-secondary">
              Sit back. The AI keeps approaching prospects and surfaces anything that needs you here.
            </p>
          </div>
        </section>
      {/if}
    </div>

    <section
      class="grid grid-cols-2 gap-px overflow-hidden rounded-2xl bg-border {stageCards.length === 5
        ? 'lg:grid-cols-5'
        : 'lg:grid-cols-4'}"
    >
      {#each stageCards as card (card.key)}
        {@const Icon = card.icon}
        <a href={stageHref(card.stage)} class="flex flex-col gap-1 bg-surface p-5 transition-colors hover:bg-surface-2 focus-visible:-outline-offset-2">
          <span class="flex items-center justify-between text-sm font-medium text-text-secondary">
            {card.label}
            <Icon size={16} class="text-text-muted" />
          </span>
          <span class="flex items-baseline gap-2">
            <span
              class="font-display text-4xl font-semibold tabular-nums tracking-tight {card.inbound && card.value.current > 0
                ? 'text-inbound'
                : 'text-text'}"
            >
              {card.value.current}
            </span>
            {#if card.value.deltaPct !== null}
              {#if card.value.deltaPct >= 0}
                <span class="inline-flex items-center gap-0.5 text-xs font-semibold tabular-nums text-inbound">
                  <TrendingUp size={14} />{card.value.deltaPct}%
                </span>
              {:else}
                <span class="inline-flex items-center gap-0.5 text-xs font-semibold tabular-nums text-danger">
                  <TrendingDown size={14} />{card.value.deltaPct}%
                </span>
              {/if}
            {/if}
          </span>
          <span class="text-xs text-text-muted">
            {#if card.conversion !== null && card.prevLabel}
              <span class="font-semibold text-text-secondary">{card.conversion}% of {card.prevLabel}</span> ·
            {/if}
            {card.sub}
          </span>
        </a>
      {/each}
    </section>

    <section class="grid grid-cols-1 gap-3 lg:grid-cols-5">
      <div class="space-y-3 lg:col-span-3">
        <div class="card p-5">
          <div class="mb-1 flex items-center justify-between gap-3">
            <h3 class="font-display text-lg font-semibold text-text">Activity</h3>
            <div class="flex items-center gap-3 text-xs text-text-muted">
              <span class="flex items-center gap-1.5"><span class="inline-block h-2.5 w-2.5 rounded-sm bg-surface-2"></span>Sent</span>
              <span class="flex items-center gap-1.5"><span class="inline-block h-2.5 w-2.5 rounded-sm bg-inbound"></span>Replies</span>
            </div>
          </div>
          {#if hasReplyData}
            <div class="mb-4 flex items-center gap-2 text-sm">
              <span class="text-text-muted">Reply rate · {data.period === 'all' ? 'all-time' : data.period}</span>
              <span class="font-semibold tabular-nums text-text">
                {summary.replyRateTrend.previous}% → {summary.replyRateTrend.current}%
              </span>
              {#if summary.replyRateTrend.current >= summary.replyRateTrend.previous}
                <TrendingUp size={14} class="text-inbound" />
              {:else}
                <TrendingDown size={14} class="text-danger" />
              {/if}
            </div>
          {/if}
          {#if hasTrendActivity}
            <div class="flex h-32 gap-[3px]">
              {#each summary.trend as pt}
                <div class="flex h-full flex-1 flex-col justify-end" title="{pt.date}: {pt.sent} sent, {pt.responses} replies">
                  <div
                    class="flex w-full flex-col justify-end overflow-hidden rounded-sm bg-surface-2"
                    style="height: {Math.round((pt.sent / trendMax) * 100)}%"
                  >
                    <div class="w-full bg-inbound" style="height: {pt.sent ? Math.min(100, Math.round((pt.responses / pt.sent) * 100)) : 0}%"></div>
                  </div>
                </div>
              {/each}
            </div>
            <div class="mt-2 flex justify-between text-xs text-text-muted">
              <span>30 days ago</span><span>today</span>
            </div>
          {:else}
            <EmptyState message="No activity in the last 30 days." />
          {/if}
        </div>

        <div class="card overflow-hidden">
          <div class="flex items-center justify-between px-5 pb-2 pt-4">
            <h3 class="font-display text-lg font-semibold text-text">Recent activity</h3>
            <a href="/outreach" class="text-sm font-semibold text-accent-strong hover:underline">View all</a>
          </div>
          {#if summary.recentActivity.length > 0}
            <div class="divide-y divide-border text-sm">
              {#each summary.recentActivity as ev}
                {@const meta = activityMeta(ev.kind)}
                <div class="flex items-center gap-3 px-5 py-2.5">
                  <span class="w-16 shrink-0 text-xs tabular-nums text-text-muted">{timeAgo(ev.at)}</span>
                  <span class="w-40 shrink-0 truncate text-text">{ev.prospectName}</span>
                  <span class="chip {meta.chip}">{meta.label}</span>
                  <span class="ml-auto hidden truncate text-xs text-text-muted sm:inline">{ev.organizationDomain}</span>
                </div>
              {/each}
            </div>
          {:else}
            <EmptyState message="No activity yet." />
          {/if}
        </div>
      </div>

      <div class="space-y-3 lg:col-span-2">
        <div class="card p-5">
          <div class="mb-3 flex items-center gap-2">
            <Brain size={18} class="text-inbound" />
            <h3 class="font-display text-lg font-semibold text-text">What the AI is doing</h3>
          </div>
          {#if summary.learning.angles.length > 0 || summary.learning.bestSubject || summary.journal.length > 0 || summary.learning.log.length > 0}
            <ul class="space-y-4 text-sm">
              <li>
                <p class="flex items-center gap-2 text-text">
                  <FlaskConical size={16} class="text-inbound" />
                  {#if summary.learning.state === 'optimizing'}
                    Optimizing across {summary.learning.angles.length} message {summary.learning.angles.length === 1 ? 'angle' : 'angles'}
                  {:else}
                    Still learning — gathering data
                  {/if}
                </p>
                {#if summary.learning.needsNewAngle}
                  <p class="mt-0.5 text-xs text-text-muted">Recruiting a fresh angle — the next evaluation adds one.</p>
                {/if}
              </li>
              {#if summary.learning.angles.length > 0}
                <li class="border-t border-border pt-4">
                  <p class="text-xs font-semibold text-text-muted">Testing now</p>
                  <ul class="mt-2 space-y-1.5">
                    {#each summary.learning.angles as angle}
                      <li class="flex items-baseline justify-between gap-2">
                        <span class="min-w-0 truncate text-text" title={angle.variantId}>
                          {angle.label ?? angle.variantId}
                          {#if angle.leader}<span class="chip ml-1 bg-inbound/15 text-inbound">Leading</span>{/if}
                        </span>
                        <span class="shrink-0 text-xs tabular-nums text-text-secondary">
                          {angle.total} {angle.total === 1 ? 'send' : 'sends'} · {angle.mature ? `${angle.replyRate}%` : 'maturing'}
                        </span>
                      </li>
                    {/each}
                  </ul>
                </li>
              {/if}
              {#if summary.learning.bestSubject}
                <li class="border-t border-border pt-4">
                  <p class="text-xs font-semibold text-text-muted">Leading subject line</p>
                  <p class="mt-1 truncate text-text" title={summary.learning.bestSubject.pattern}>
                    “{summary.learning.bestSubject.pattern}”
                  </p>
                  <p class="text-xs tabular-nums text-inbound">
                    {summary.learning.bestSubject.replyRate}% reply rate · {summary.learning.bestSubject.n} sends{summary.learning.bestSubject.mature ? ' · winning' : ' · still testing'}
                  </p>
                </li>
              {/if}
              {#if summary.journal.length > 0}
                <li class="border-t border-border pt-4">
                  <p class="text-xs font-semibold text-text-muted">Recent decisions</p>
                  <ul class="mt-2 space-y-2">
                    {#each summary.journal.slice(0, JOURNAL_SHOWN) as event}
                      {@const j = journalText(event)}
                      <li class="flex gap-3">
                        <span class="w-12 shrink-0 text-xs tabular-nums text-text-muted">{fmtDay(event.date)}</span>
                        <span class="min-w-0 break-words text-text-secondary">
                          {j.text}{#if j.detail}{' '}<span class="text-text-muted">({j.detail})</span>{/if}
                        </span>
                      </li>
                    {/each}
                  </ul>
                  {#if summary.journal.length > JOURNAL_SHOWN}
                    <p class="mt-2 text-xs text-text-muted">+{summary.journal.length - JOURNAL_SHOWN} more in the last 30 days</p>
                  {/if}
                </li>
              {/if}
              {#if summary.learning.log.length > 0}
                <li class="border-t border-border pt-4">
                  <p class="text-xs font-semibold text-text-muted">Learnings</p>
                  <ul class="mt-2 space-y-2">
                    {#each summary.learning.log.slice(0, LEARNINGS_SHOWN) as entry}
                      <li class="flex items-start gap-2" title={entry.date}>
                        <span class="chip shrink-0 bg-surface-2 text-text-secondary">
                          {LEARNING_STAGE_LABELS[entry.stage] ?? humanize(entry.stage)}
                        </span>
                        <span class="min-w-0 break-words text-text-secondary">
                          {entry.claim}{#if entry.evidence}{' '}<span class="text-text-muted">· {entry.evidence}</span>{/if}
                        </span>
                      </li>
                    {/each}
                  </ul>
                  {#if summary.learning.log.length > LEARNINGS_SHOWN}
                    <p class="mt-2 text-xs text-text-muted">+{summary.learning.log.length - LEARNINGS_SHOWN} more</p>
                  {/if}
                </li>
              {/if}
            </ul>
          {:else}
            <p class="text-sm text-text-muted">
              Still learning. Once enough has been sent, the AI starts testing message angles and reports its decisions here.
            </p>
          {/if}
        </div>

        <div class="card p-5">
          <div class="mb-1 flex items-center gap-2">
            <MessageSquareX size={18} class="text-inbound" />
            <h3 class="font-display text-lg font-semibold text-text">What the market is telling you</h3>
          </div>
          <p class="mb-4 text-sm text-text-muted">
            From rejection replies. The AI can't fix these on its own — they're your business calls.
          </p>
          {#if summary.rejections.total > 0}
            <div class="space-y-3">
              {#each summary.rejections.topReasons as r}
                <div class="space-y-1">
                  <div class="flex justify-between text-sm">
                    <span class="text-text-secondary">{humanize(r.reason)}</span>
                    <span class="tabular-nums text-text-muted">{r.percentage}%</span>
                  </div>
                  <div class="h-2 rounded-full bg-surface-2">
                    <div class="h-2 rounded-full bg-inbound" style="width: {Math.round((r.percentage / rejectionMax) * 100)}%"></div>
                  </div>
                </div>
              {/each}
            </div>
            {#if summary.rejections.productSignal}
              <div class="mt-4 rounded-xl bg-warning/10 p-3">
                <div class="flex gap-2">
                  <Lightbulb size={16} class="mt-0.5 shrink-0 text-warning" />
                  <p class="text-sm text-text-secondary">
                    <span class="font-semibold text-text">Product signal:</span>
                    {summary.rejections.productSignal.count}
                    {summary.rejections.productSignal.count === 1 ? 'prospect' : 'prospects'} cited a missing feature. Worth a roadmap look.
                  </p>
                </div>
                {#if summary.rejections.productSignal.quotes.length > 0}
                  <ul class="mt-2 space-y-1 pl-6">
                    {#each summary.rejections.productSignal.quotes as q}
                      <li class="text-sm text-text-secondary">
                        <span class="italic">“{q.freeText}”</span>
                        <span class="text-text-muted">— {q.organizationName}</span>
                      </li>
                    {/each}
                  </ul>
                {/if}
              </div>
            {/if}
            {#if summary.rejections.budgetSignal}
              <div class="mt-3 rounded-xl bg-warning/10 p-3">
                <div class="flex gap-2">
                  <Banknote size={16} class="mt-0.5 shrink-0 text-warning" />
                  <p class="text-sm text-text-secondary">
                    <span class="font-semibold text-text">Pricing signal:</span>
                    {summary.rejections.budgetSignal.count}
                    {summary.rejections.budgetSignal.count === 1 ? 'prospect' : 'prospects'} said the price didn't fit. Worth a pricing look.
                  </p>
                </div>
                {#if summary.rejections.budgetSignal.quotes.length > 0}
                  <ul class="mt-2 space-y-1 pl-6">
                    {#each summary.rejections.budgetSignal.quotes as q}
                      <li class="text-sm text-text-secondary">
                        <span class="italic">“{q.freeText}”</span>
                        <span class="text-text-muted">— {q.organizationName}</span>
                      </li>
                    {/each}
                  </ul>
                {/if}
              </div>
            {/if}
            {#if summary.rejections.decisionMakers.length > 0}
              <div class="mt-4">
                <p class="flex items-center gap-1.5 text-xs font-semibold text-text-muted">
                  <UserPlus size={14} /> Who to reach instead
                </p>
                <ul class="mt-2 space-y-1.5">
                  {#each summary.rejections.decisionMakers as dm}
                    <li class="text-sm text-text-secondary">
                      <span class="font-semibold text-text">{dm.name ?? dm.role ?? dm.email}</span>
                      {#if dm.name && dm.role}<span> · {dm.role}</span>{/if}
                      {#if dm.email && (dm.name || dm.role)}<span class="text-text-muted"> · {dm.email}</span>{/if}
                      <span class="text-text-muted"> — via {dm.organizationName}</span>
                    </li>
                  {/each}
                </ul>
              </div>
            {/if}
            {#if summary.rejections.notRelevant.length > 0}
              <div class="mt-4">
                <p class="flex items-center gap-1.5 text-xs font-semibold text-text-muted">
                  <Target size={14} /> Wrong-fit notes
                </p>
                <ul class="mt-2 space-y-1.5">
                  {#each summary.rejections.notRelevant as n}
                    <li class="text-sm text-text-secondary">
                      <span class="italic">“{n.freeText}”</span>
                      <span class="text-text-muted">— {n.organizationName}{n.industry ? ` · ${n.industry}` : ''}</span>
                    </li>
                  {/each}
                </ul>
                <p class="mt-2 text-xs text-text-muted">The AI already folds these into its targeting.</p>
              </div>
            {/if}
            {#if summary.rejections.recontactSoon}
              <p class="mt-3 flex items-center gap-1.5 text-xs text-text-muted">
                <Clock size={14} />
                {summary.rejections.recontactSoon.count} set to re-approach in {humanize(summary.rejections.recontactSoon.window)}
              </p>
            {/if}
          {:else}
            <EmptyState message="No rejections yet." />
          {/if}
        </div>
      </div>
    </section>
  </div>
{:else}
  <EmptyState message="No data available." />
{/if}
