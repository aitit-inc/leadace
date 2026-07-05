<script lang="ts">
  import { goto } from '$app/navigation';
  import type { Component } from 'svelte';
  import type { PageProps } from './$types';
  import type { AttentionItem, DashboardActivityKind, FunnelStageKey } from '$lib/types/dashboard';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import {
    Send,
    MousePointerClick,
    MessagesSquare,
    Trophy,
    TrendingUp,
    TrendingDown,
    Brain,
    FlaskConical,
    MessageSquareX,
    Lightbulb,
    UserPlus,
    Clock,
    Check,
    BellRing,
    Target,
    Mail,
    Unplug,
    ShieldAlert,
    Megaphone,
    FileWarning,
    Zap,
    Rocket,
    ChevronRight,
  } from '@lucide/svelte';

  let { data }: PageProps = $props();
  let summary = $derived(data.summary);

  const PERIODS = [
    { key: '7d', label: '7d' },
    { key: '30d', label: '30d' },
    { key: 'all', label: 'All' },
  ] as const;

  function setPeriod(p: string) {
    goto(`?period=${p}`, { replaceState: true, keepFocus: true, noScroll: true });
  }

  type Kpi = {
    label: string;
    icon: Component;
    value: { current: number; deltaPct: number | null };
    sub: string;
    highlight: boolean;
  };
  let kpis = $derived<Kpi[]>(
    summary
      ? [
          { label: 'Approached', icon: Send, value: summary.kpis.approached, sub: 'prospects contacted', highlight: false },
          { label: 'Reached', icon: MousePointerClick, value: summary.kpis.reached, sub: 'opened their page', highlight: false },
          { label: 'Engaged', icon: MessagesSquare, value: summary.kpis.engaged, sub: 'replied, chatted, or signed up', highlight: false },
          { label: 'Won', icon: Trophy, value: summary.kpis.won, sub: 'meetings + signups', highlight: true },
        ]
      : [],
  );

  const FUNNEL_LABELS: Record<FunnelStageKey, string> = {
    sent: 'Approached',
    reached: 'Reached',
    engaged: 'Engaged',
    won: 'Won',
  };
  const CHANNEL_LABELS: Record<string, string> = {
    email: 'Email',
    form: 'Form',
    sns_twitter: 'X/Twitter',
    sns_linkedin: 'LinkedIn',
  };
  const LEARNING_STAGE_LABELS: Record<string, string> = {
    targeting: 'Targeting',
    body: 'Message',
    timing: 'Timing',
    channel: 'Channel',
  };
  const LEARNINGS_SHOWN = 6;
  const FUNNEL_BAR: Record<FunnelStageKey, string> = {
    sent: 'bg-accent/85',
    reached: 'bg-accent/65',
    engaged: 'bg-accent/45',
    won: 'bg-success',
  };

  // Scale bars to the largest stage, not to "sent": a lagged open/reply can land in-period
  // while its send was earlier, so a later stage can exceed sent.
  let funnelMax = $derived(Math.max(1, ...(summary?.funnel ?? []).map((s) => s.count)));
  let trendMax = $derived(Math.max(1, ...(summary?.trend ?? []).map((t) => t.sent)));
  let hasTrendActivity = $derived((summary?.trend ?? []).some((t) => t.sent > 0 || t.responses > 0));
  // Reply rate is the selected-window KPI, independent of the fixed 30-day trend bars below it.
  let hasReplyData = $derived((summary?.kpis.approached.current ?? 0) > 0);
  let rejectionMax = $derived(Math.max(1, ...(summary?.rejections.topReasons ?? []).map((r) => r.percentage)));

  // Only the opportunity/queue kinds (hot leads, outreach drafts) leave autopilot "on".
  const SENDING_BLOCKERS: AttentionItem['kind'][] = [
    'mcp_not_connected',
    'compliance_incomplete',
    'gmail_disconnected',
    'no_outbound_channels',
    'email_template_missing',
    'quota_exhausted',
  ];
  let paused = $derived(summary?.attention.some((a) => SENDING_BLOCKERS.includes(a.kind)) ?? false);

  function humanize(s: string): string {
    // snake_case (reasons/windows) and camelCase (compliance fields like legalName) → sentence case.
    const t = s.replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
  }

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

  type AttentionMeta = {
    icon: Component;
    tone: 'accent' | 'info' | 'danger' | 'warning';
    title: string;
    desc: string;
    ctaLabel: string;
    href: string;
  };
  function attentionMeta(item: AttentionItem): AttentionMeta {
    switch (item.kind) {
      case 'hot_leads':
        return {
          icon: Target,
          tone: 'accent',
          title: `${item.count} meeting ${item.count === 1 ? 'request' : 'requests'} waiting`,
          desc: 'Prospects asked to talk — book the call',
          ctaLabel: 'Review',
          href: '/responses',
        };
      case 'outreach_drafts':
        return {
          icon: Mail,
          tone: 'info',
          title: `${item.count} ${item.count === 1 ? 'draft' : 'drafts'} ready to review`,
          desc: 'AI-drafted outreach — review & send',
          ctaLabel: 'Review',
          href: '/drafts',
        };
      case 'mcp_not_connected':
        return {
          icon: Rocket,
          tone: 'accent',
          title: 'Connect the LeadAce plugin',
          desc: 'Connect in Claude Code to start finding and emailing prospects',
          ctaLabel: 'Set up',
          href: '/onboarding',
        };
      case 'compliance_incomplete':
        return {
          icon: ShieldAlert,
          tone: 'danger',
          title: 'Compliance details missing',
          desc: `Sending is blocked until you add: ${item.missing.map(humanize).join(', ')}`,
          ctaLabel: 'Fix',
          href: '/workspace-settings',
        };
      case 'gmail_disconnected':
        return {
          icon: Unplug,
          tone: 'danger',
          title: 'Gmail disconnected',
          desc: 'Email sending is paused until you reconnect',
          ctaLabel: 'Reconnect',
          href: '/account-settings',
        };
      case 'no_outbound_channels':
        return {
          icon: Megaphone,
          tone: 'warning',
          title: 'Outbound is paused',
          desc: 'No channels enabled — turn one on to start reaching prospects',
          ctaLabel: 'Enable',
          href: '/project-settings',
        };
      case 'email_template_missing':
        return {
          icon: FileWarning,
          tone: 'warning',
          title: 'Email template missing',
          desc: 'Email outreach is disabled until you add a template',
          ctaLabel: 'Add',
          href: '/documents',
        };
      case 'quota_exhausted':
        return {
          icon: Zap,
          tone: 'warning',
          title: 'Outreach quota reached',
          desc:
            item.constraint === 'daily'
              ? "Today's sending limit is used up — it resets tomorrow"
              : 'Your plan limit is used up — upgrade to keep sending',
          ctaLabel: item.constraint === 'daily' ? 'View plan' : 'Upgrade',
          href: '/plans',
        };
    }
  }

  const TONE_CHIP: Record<AttentionMeta['tone'], string> = {
    accent: 'bg-accent/15 text-accent',
    info: 'bg-info/15 text-info',
    danger: 'bg-danger/15 text-danger',
    warning: 'bg-warning/15 text-warning',
  };

  type ActivityMeta = { label: string; chip: string; muted: boolean };
  function activityMeta(kind: DashboardActivityKind): ActivityMeta {
    switch (kind) {
      case 'meeting':
        return { label: 'Meeting request', chip: 'bg-success/15 text-success', muted: false };
      case 'signup':
        return { label: 'Signed up', chip: 'bg-success/15 text-success', muted: false };
      case 'replied':
        return { label: 'Replied', chip: 'bg-success/15 text-success', muted: false };
      case 'inquired':
        return { label: 'Chatted', chip: 'bg-info/15 text-info', muted: false };
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

{#if summary}
  <div class="mx-auto max-w-5xl space-y-6">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold text-text">Sales Dashboard</h1>
        <p class="mt-0.5 text-sm text-text-secondary">How your AI sales rep is doing</p>
      </div>
      <div class="flex items-center gap-3">
        {#if paused}
          <span class="inline-flex items-center gap-1.5 rounded-full bg-warning/15 px-2.5 py-1 text-xs font-medium text-warning">
            <span class="h-1.5 w-1.5 rounded-full bg-warning"></span>
            Paused
          </span>
        {:else}
          <span class="inline-flex items-center gap-1.5 rounded-full bg-success/15 px-2.5 py-1 text-xs font-medium text-success">
            <span class="h-1.5 w-1.5 rounded-full bg-success"></span>
            Autopilot on
          </span>
        {/if}
        <div class="flex items-center rounded-md border border-border bg-surface p-0.5 text-xs font-medium">
          {#each PERIODS as p}
            <button
              type="button"
              onclick={() => setPeriod(p.key)}
              class="rounded px-2.5 py-1 {data.period === p.key ? 'bg-surface-2 text-text' : 'text-text-muted hover:text-text'}"
            >
              {p.label}
            </button>
          {/each}
        </div>
      </div>
    </div>

    {#if summary.attention.length > 0}
      <section class="overflow-hidden rounded-xl border border-border bg-surface">
        <div class="flex items-center gap-2 border-b border-border px-5 py-3">
          <span class="flex h-6 w-6 items-center justify-center rounded-full bg-warning/15 text-warning">
            <BellRing size={14} />
          </span>
          <h2 class="text-sm font-semibold text-text">Needs your attention</h2>
          <span class="rounded-full bg-warning/15 px-2 py-0.5 text-xs font-semibold text-warning">
            {summary.attention.length}
          </span>
          <span class="ml-auto hidden text-xs text-text-muted sm:inline">Things the AI can't decide for you</span>
        </div>
        <div class="divide-y divide-border">
          {#each summary.attention as item}
            {@const meta = attentionMeta(item)}
            {@const Icon = meta.icon}
            <div class="flex items-center gap-3 px-5 py-3">
              <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg {TONE_CHIP[meta.tone]}">
                <Icon size={18} />
              </span>
              <div class="min-w-0 flex-1">
                <p class="text-sm font-medium text-text">{meta.title}</p>
                <p class="truncate text-xs text-text-secondary">{meta.desc}</p>
              </div>
              <a
                href={meta.href}
                class="shrink-0 rounded-md px-3 py-1.5 text-xs font-semibold {meta.tone === 'accent'
                  ? 'bg-accent text-white hover:bg-accent-strong'
                  : 'border border-border bg-surface text-text hover:bg-surface-2'}"
              >
                {meta.ctaLabel}
              </a>
            </div>
          {/each}
        </div>
      </section>
    {:else}
      <section class="flex items-center gap-4 rounded-xl border border-success/30 bg-success/10 px-5 py-5">
        <span class="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-success/20 text-success">
          <Check size={26} />
        </span>
        <div>
          <h2 class="text-base font-semibold text-text">All clear — nothing needs you</h2>
          <p class="mt-0.5 text-sm text-text-secondary">
            Sit back. The AI keeps approaching prospects and surfaces anything that needs you here.
          </p>
        </div>
      </section>
    {/if}

    <section class="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {#each kpis as kpi}
        {@const Icon = kpi.icon}
        <div class="rounded-xl border p-4 {kpi.highlight ? 'border-accent/30 bg-accent/5' : 'border-border bg-surface'}">
          <div class="flex items-center justify-between">
            <span class="text-xs font-medium uppercase tracking-wider {kpi.highlight ? 'text-accent-strong' : 'text-text-muted'}">
              {kpi.label}
            </span>
            <Icon size={15} class={kpi.highlight ? 'text-accent' : 'text-text-muted'} />
          </div>
          <div class="mt-2 flex items-baseline gap-2">
            <span class="font-mono text-3xl font-semibold text-text">{kpi.value.current}</span>
            {#if kpi.value.deltaPct !== null}
              {#if kpi.value.deltaPct >= 0}
                <span class="inline-flex items-center gap-0.5 text-xs font-medium text-success">
                  <TrendingUp size={13} />{kpi.value.deltaPct}%
                </span>
              {:else}
                <span class="inline-flex items-center gap-0.5 text-xs font-medium text-danger">
                  <TrendingDown size={13} />{kpi.value.deltaPct}%
                </span>
              {/if}
            {/if}
          </div>
          <p class="mt-1 text-xs text-text-muted">{kpi.sub}</p>
        </div>
      {/each}
    </section>

    <section class="grid grid-cols-1 gap-3 lg:grid-cols-5">
      <div class="space-y-3 lg:col-span-3">
        <div class="rounded-xl border border-border bg-surface p-5">
          <div class="mb-4 flex items-center justify-between">
            <h3 class="text-sm font-semibold text-text">Funnel</h3>
            <span class="text-xs text-text-muted">selected period</span>
          </div>
          {#if summary.funnel.some((s) => s.count > 0)}
            <div class="space-y-2.5">
              {#each summary.funnel as stage}
                <div class="flex items-center gap-3">
                  <span class="w-20 shrink-0 text-xs {stage.key === 'won' ? 'font-medium text-text' : 'text-text-secondary'}">
                    {FUNNEL_LABELS[stage.key]}
                  </span>
                  <div class="h-7 flex-1 rounded-md bg-surface-2">
                    <div
                      class="flex h-7 items-center rounded-md pl-2.5 text-xs font-medium text-white {FUNNEL_BAR[stage.key]} {stage.count > 0 ? 'min-w-10' : ''}"
                      style="width: {Math.round((stage.count / funnelMax) * 100)}%"
                    >
                      {stage.count}
                    </div>
                  </div>
                  <span class="w-10 shrink-0 text-right font-mono text-xs text-text-muted">
                    {stage.conversionFromPrev !== null ? `${stage.conversionFromPrev}%` : ''}
                  </span>
                </div>
              {/each}
            </div>
            <p class="mt-3 border-t border-border pt-3 text-xs text-text-muted">
              Each step shows conversion from the one above. The job is to keep
              <span class="text-text-secondary">Won</span> growing.
            </p>
          {:else}
            <EmptyState message="No activity in this period yet." />
          {/if}
        </div>

        <div class="rounded-xl border border-border bg-surface p-5">
          <div class="mb-1 flex items-center justify-between">
            <h3 class="text-sm font-semibold text-text">Activity</h3>
            <div class="flex items-center gap-3 text-xs">
              <span class="flex items-center gap-1 text-text-muted"><span class="inline-block h-2 w-2 rounded-sm bg-surface-2"></span>Sent</span>
              <span class="flex items-center gap-1 text-text-muted"><span class="inline-block h-2 w-2 rounded-sm bg-accent"></span>Replies</span>
            </div>
          </div>
          {#if hasReplyData}
            <div class="mb-3 flex items-baseline gap-2">
              <span class="text-xs text-text-muted">Reply rate · {data.period === 'all' ? 'all-time' : data.period}</span>
              <span class="font-mono text-sm font-medium text-text">
                {summary.replyRateTrend.previous}% → {summary.replyRateTrend.current}%
              </span>
              {#if summary.replyRateTrend.current >= summary.replyRateTrend.previous}
                <TrendingUp size={13} class="text-success" />
              {:else}
                <TrendingDown size={13} class="text-danger" />
              {/if}
            </div>
          {/if}
          {#if hasTrendActivity}
            <div class="flex h-28 gap-[3px]">
              {#each summary.trend as pt}
                <div class="flex h-full flex-1 flex-col justify-end" title="{pt.date}: {pt.sent} sent, {pt.responses} replies">
                  <div
                    class="flex w-full flex-col justify-end overflow-hidden rounded-sm bg-surface-2"
                    style="height: {Math.round((pt.sent / trendMax) * 100)}%"
                  >
                    <div class="w-full bg-accent" style="height: {pt.sent ? Math.min(100, Math.round((pt.responses / pt.sent) * 100)) : 0}%"></div>
                  </div>
                </div>
              {/each}
            </div>
            <div class="mt-1.5 flex justify-between text-[10px] text-text-muted">
              <span>30 days ago</span><span>today</span>
            </div>
          {:else}
            <EmptyState message="No activity in the last 30 days." />
          {/if}
        </div>
      </div>

      <div class="space-y-3 lg:col-span-2">
        <div class="rounded-xl border border-border bg-surface p-5">
          <div class="mb-3 flex items-center gap-2">
            <Brain size={16} class="text-accent" />
            <h3 class="text-sm font-semibold text-text">What the AI is learning</h3>
          </div>
          {#if summary.learning.bestSubject || summary.learning.channelOrder.length > 0 || summary.learning.log.length > 0}
            <ul class="space-y-3 text-sm">
              {#if summary.learning.bestSubject}
                <li>
                  <p class="text-xs uppercase tracking-wider text-text-muted">Best subject line</p>
                  <p class="mt-0.5 truncate text-text" title={summary.learning.bestSubject.pattern}>
                    "{summary.learning.bestSubject.pattern}"
                  </p>
                  <p class="text-xs text-success">
                    {summary.learning.bestSubject.replyRate}% reply rate{summary.learning.bestSubject.mature ? ' · winning' : ' · still testing'}
                  </p>
                </li>
              {/if}
              {#if summary.learning.channelOrder.length > 0}
                <li class="border-t border-border pt-3">
                  <p class="text-xs uppercase tracking-wider text-text-muted">Best channel</p>
                  <div class="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                    {#each summary.learning.channelOrder.slice(0, 3) as ch, i}
                      {#if i > 0}<ChevronRight size={12} class="text-text-muted" />{/if}
                      <span class="rounded bg-surface-2 px-1.5 py-0.5 {i === 0 ? 'font-medium text-text' : 'text-text-secondary'}">
                        {CHANNEL_LABELS[ch.channel] ?? humanize(ch.channel.replace('sns_', ''))}
                      </span>
                    {/each}
                  </div>
                </li>
              {/if}
              <li class="border-t border-border pt-3">
                <p class="text-xs uppercase tracking-wider text-text-muted">Status</p>
                <p class="mt-0.5 flex items-center gap-1.5 text-text">
                  <FlaskConical size={14} class="text-info" />
                  {#if summary.learning.state === 'optimizing'}
                    Optimizing across {summary.learning.testing.activeVariants} subject {summary.learning.testing.activeVariants === 1 ? 'line' : 'lines'}
                  {:else}
                    Still learning — gathering data
                  {/if}
                </p>
              </li>
              {#if summary.learning.log.length > 0}
                <li class="border-t border-border pt-3">
                  <p class="text-xs uppercase tracking-wider text-text-muted">Learnings</p>
                  <ul class="mt-1.5 space-y-1.5">
                    {#each summary.learning.log.slice(0, LEARNINGS_SHOWN) as entry}
                      <li class="flex gap-2 text-xs" title={entry.date}>
                        <span class="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 font-medium text-text-secondary">
                          {LEARNING_STAGE_LABELS[entry.stage] ?? humanize(entry.stage)}
                        </span>
                        <span class="min-w-0 break-words text-text-secondary">{entry.claim}</span>
                      </li>
                    {/each}
                  </ul>
                  {#if summary.learning.log.length > LEARNINGS_SHOWN}
                    <p class="mt-1.5 text-xs text-text-muted">+{summary.learning.log.length - LEARNINGS_SHOWN} more</p>
                  {/if}
                </li>
              {/if}
            </ul>
          {:else}
            <p class="text-sm text-text-muted">
              Still learning. Once enough has been sent, the AI starts optimizing subject lines and channels here.
            </p>
          {/if}
        </div>

        <div class="rounded-xl border border-border bg-surface p-5">
          <div class="mb-3 flex items-center gap-2">
            <MessageSquareX size={16} class="text-text-muted" />
            <h3 class="text-sm font-semibold text-text">Why prospects said no</h3>
          </div>
          {#if summary.rejections.total > 0}
            <div class="space-y-2">
              {#each summary.rejections.topReasons as r}
                <div class="space-y-1">
                  <div class="flex justify-between text-xs">
                    <span class="text-text-secondary">{humanize(r.reason)}</span>
                    <span class="font-mono text-text-muted">{r.percentage}%</span>
                  </div>
                  <div class="h-1.5 rounded-full bg-surface-2">
                    <div class="h-1.5 rounded-full bg-text-muted" style="width: {Math.round((r.percentage / rejectionMax) * 100)}%"></div>
                  </div>
                </div>
              {/each}
            </div>
            {#if summary.rejections.productSignal}
              <div class="mt-3 rounded-lg bg-warning/10 p-2.5">
                <div class="flex gap-2">
                  <Lightbulb size={14} class="mt-0.5 shrink-0 text-warning" />
                  <p class="text-xs text-text-secondary">
                    <span class="font-medium text-text">Product signal:</span>
                    {summary.rejections.productSignal.count}
                    {summary.rejections.productSignal.count === 1 ? 'prospect' : 'prospects'} cited a missing feature. Worth a roadmap look.
                  </p>
                </div>
                {#if summary.rejections.productSignal.quotes.length > 0}
                  <ul class="mt-2 space-y-1 pl-6">
                    {#each summary.rejections.productSignal.quotes as q}
                      <li class="text-xs text-text-secondary">
                        <span class="italic">"{q.freeText}"</span>
                        <span class="text-text-muted">— {q.organizationName}</span>
                      </li>
                    {/each}
                  </ul>
                {/if}
              </div>
            {/if}
            {#if summary.rejections.decisionMakers.length > 0}
              <div class="mt-3">
                <p class="flex items-center gap-1.5 text-xs uppercase tracking-wider text-text-muted">
                  <UserPlus size={13} /> Who to reach instead
                </p>
                <ul class="mt-1.5 space-y-1.5">
                  {#each summary.rejections.decisionMakers as dm}
                    <li class="text-xs text-text-secondary">
                      <span class="font-medium text-text">{dm.name ?? dm.role ?? dm.email}</span>
                      {#if dm.name && dm.role}<span> · {dm.role}</span>{/if}
                      {#if dm.email && (dm.name || dm.role)}<span class="text-text-muted"> · {dm.email}</span>{/if}
                      <span class="text-text-muted"> — via {dm.organizationName}</span>
                    </li>
                  {/each}
                </ul>
              </div>
            {/if}
            {#if summary.rejections.notRelevant.length > 0}
              <div class="mt-3">
                <p class="flex items-center gap-1.5 text-xs uppercase tracking-wider text-text-muted">
                  <Target size={13} /> Wrong-fit notes
                </p>
                <ul class="mt-1.5 space-y-1.5">
                  {#each summary.rejections.notRelevant as n}
                    <li class="text-xs text-text-secondary">
                      <span class="italic">"{n.freeText}"</span>
                      <span class="text-text-muted">— {n.organizationName}{n.industry ? ` · ${n.industry}` : ''}</span>
                    </li>
                  {/each}
                </ul>
              </div>
            {/if}
            {#if summary.rejections.recontactSoon}
              <p class="mt-2.5 flex items-center gap-1.5 text-xs text-text-muted">
                <Clock size={13} />
                {summary.rejections.recontactSoon.count} set to re-approach in {humanize(summary.rejections.recontactSoon.window)}
              </p>
            {/if}
          {:else}
            <EmptyState message="No rejections yet." />
          {/if}
        </div>
      </div>
    </section>

    <section class="rounded-xl border border-border bg-surface">
      <div class="flex items-center justify-between border-b border-border px-5 py-3">
        <h3 class="text-sm font-semibold text-text">Recent activity</h3>
        <a href="/outreach" class="text-xs font-medium text-accent hover:text-accent-strong">View all</a>
      </div>
      {#if summary.recentActivity.length > 0}
        <div class="divide-y divide-border text-sm">
          {#each summary.recentActivity as ev}
            {@const meta = activityMeta(ev.kind)}
            <div class="flex items-center gap-3 px-5 py-2.5">
              <span class="w-16 shrink-0 text-xs text-text-muted">{timeAgo(ev.at)}</span>
              <span class="w-40 shrink-0 truncate text-text">{ev.prospectName}</span>
              <span class="rounded px-1.5 py-0.5 text-[11px] font-medium {meta.chip}">{meta.label}</span>
              <span class="ml-auto hidden truncate text-xs text-text-muted sm:inline">{ev.organizationDomain}</span>
            </div>
          {/each}
        </div>
      {:else}
        <EmptyState message="No activity yet." />
      {/if}
    </section>
  </div>
{:else}
  <EmptyState message="No data available." />
{/if}
