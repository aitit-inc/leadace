<script lang="ts">
  import { page } from '$app/state';
  import ProjectSwitcher from '$lib/components/ProjectSwitcher.svelte';
  import Logo from '$lib/components/Logo.svelte';
  import AccountMenu from '$lib/components/AccountMenu.svelte';
  import AlertBell from '$lib/components/AlertBell.svelte';
  import {
    House,
    Users,
    Building2,
    Send,
    Mail,
    Reply,
    ChartBar,
    FileText,
    Inbox,
    Settings,
    Menu,
    X,
    TriangleAlert,
    Rocket,
    MessageCircle,
    Ellipsis,
    ChevronDown,
  } from '@lucide/svelte';
  import type { Component } from 'svelte';
  import { connectGmail } from '$lib/gmail-oauth';
  import type { LayoutProps } from './$types';

  let { data, children }: LayoutProps = $props();
  let drawerOpen = $state(false);
  let moreOpen = $state(false);
  let connectingGmail = $state(false);
  let gmailConnectError = $state<string | null>(null);

  let bellItems = $derived(data.attention);
  let gmailBannerItem = $derived(
    data.attention.find((i) => i.kind === 'gmail_disconnected' || i.kind === 'gmail_auth_revoked'),
  );

  async function handleConnectGmail() {
    connectingGmail = true;
    gmailConnectError = null;
    const err = await connectGmail(data.supabase);
    // Success path navigates to Google and never resolves here; only error
    // returns reach this branch.
    if (err) {
      gmailConnectError = err;
      connectingGmail = false;
    }
  }

  type NavItem = { href: string; label: string; icon: Component };
  const primaryNav: NavItem[] = [
    { href: '/chat', label: 'Chat', icon: MessageCircle },
    { href: '/dashboard', label: 'Home', icon: House },
    { href: '/prospects', label: 'Prospects', icon: Users },
    { href: '/drafts', label: 'Drafts', icon: Mail },
    { href: '/responses', label: 'Replies', icon: Reply },
  ];
  const moreNav: NavItem[] = [
    { href: '/organizations', label: 'Organizations', icon: Building2 },
    { href: '/outreach', label: 'Outreach', icon: Send },
    { href: '/evaluations', label: 'Evaluations', icon: ChartBar },
    { href: '/documents', label: 'Documents', icon: FileText },
    { href: '/inquiry-settings', label: 'Inquiry page', icon: Inbox },
  ];
  const settingsNav: NavItem = { href: '/project-settings', label: 'Settings', icon: Settings };

  // Pages NOT listed here (prospects, organizations' siblings, project-
  // settings, etc.) are hidden behind the "No projects yet" CTA below when
  // projects.length === 0 — the +layout.server.ts reconciliation guarantees
  // activeProjectId is non-null whenever any project exists.
  const tenantScopedPaths = [
    '/chat',
    '/onboarding',
    '/organizations',
    '/workspace-settings',
    '/account-settings',
    '/plans',
  ];
  function isTenantScoped(pathname: string): boolean {
    return tenantScopedPaths.some((p) => pathname === p || pathname.startsWith(p + '/'));
  }

  function isActive(href: string) {
    return page.url.pathname === href || page.url.pathname.startsWith(href + '/');
  }

  // Close drawer on route change so nav taps dismiss the overlay automatically.
  $effect(() => {
    void page.url.pathname;
    drawerOpen = false;
  });

  // Keep the current page visible in the nav.
  $effect(() => {
    if (moreNav.some((i) => isActive(i.href))) moreOpen = true;
  });
</script>

{#snippet navLink(item: NavItem)}
  {@const Icon = item.icon}
  {@const active = isActive(item.href)}
  <a
    href={item.href}
    aria-current={active ? 'page' : undefined}
    class="flex items-center gap-3 rounded-full px-3 py-2 text-sm transition-colors {active
      ? 'bg-surface font-semibold text-text'
      : 'text-text-secondary hover:bg-surface-2 hover:text-text'}"
  >
    <Icon size={18} class="shrink-0" />
    <span class="min-w-0 flex-1 truncate">{item.label}</span>
  </a>
{/snippet}

<div class="flex h-screen">
  {#if drawerOpen}
    <button
      type="button"
      class="fixed inset-0 z-20 bg-black/40 md:hidden"
      aria-label="Close menu"
      onclick={() => (drawerOpen = false)}
    ></button>
  {/if}

  <aside
    class="fixed inset-y-0 left-0 z-30 flex w-64 flex-col bg-page px-3 py-4 transition-[translate,visibility] duration-200 ease-spring md:static md:w-56 md:translate-x-0 md:border-r md:border-border {drawerOpen
      ? 'translate-x-0'
      : '-translate-x-full max-md:invisible'}"
  >
    <div class="flex items-center justify-between px-2 pb-5">
      <a href="/dashboard" class="flex items-center gap-2.5 text-text">
        <Logo size={24} class="text-accent" />
        <span class="font-display text-lg font-semibold tracking-tight">LeadAce</span>
      </a>
      <button
        type="button"
        class="btn-ghost rounded-full p-1.5 md:hidden"
        aria-label="Close menu"
        onclick={() => (drawerOpen = false)}
      >
        <X size={18} />
      </button>
    </div>

    <nav class="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto" aria-label="Main">
      {#each primaryNav as item (item.href)}
        {@render navLink(item)}
      {/each}
      <button
        type="button"
        onclick={() => (moreOpen = !moreOpen)}
        aria-expanded={moreOpen}
        class="flex items-center gap-3 rounded-full px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-surface-2 hover:text-text"
      >
        <Ellipsis size={18} class="shrink-0" />
        <span class="flex-1 text-left">More</span>
        <ChevronDown size={16} class="transition-transform duration-200 {moreOpen ? 'rotate-180' : ''}" />
      </button>
      {#if moreOpen}
        <div class="flex flex-col gap-0.5 pl-3">
          {#each moreNav as item (item.href)}
            {@render navLink(item)}
          {/each}
        </div>
      {/if}
      <div class="mx-3 my-2 h-px bg-border"></div>
      {@render navLink(settingsNav)}
    </nav>

    <div class="pt-3">
      <AccountMenu user={data.user} plan={data.plan} supabase={data.supabase} />
    </div>
  </aside>

  <div class="flex flex-1 flex-col overflow-hidden">
    <header class="flex items-center gap-2 border-b border-border px-3 py-2.5 md:px-6">
      <button
        type="button"
        class="btn-ghost rounded-full p-1.5 md:hidden"
        aria-label="Open menu"
        aria-expanded={drawerOpen}
        onclick={() => (drawerOpen = true)}
      >
        <Menu size={22} />
      </button>
      <div class="min-w-0 flex-1">
        <ProjectSwitcher projects={data.projects} activeProjectId={data.activeProjectId} />
      </div>
      <AlertBell items={bellItems} notifications={data.notifications} token={data.session?.access_token} />
    </header>

    {#if data.projects.length === 0 && page.url.pathname !== '/chat' && page.url.pathname !== '/dashboard'}
      <div class="mx-4 mt-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-2xl bg-accent/12 px-4 py-3 md:mx-8">
        <div class="flex items-center gap-2.5 text-sm text-text">
          <Rocket size={18} class="shrink-0 text-accent-strong" />
          <span>Paste your website URL in the chat to set up your first project.</span>
        </div>
        <a href="/chat" class="btn btn-primary btn-sm">Finish setup</a>
      </div>
    {/if}

    {#if gmailBannerItem && page.url.pathname !== '/dashboard'}
      <div class="mx-4 mt-4 rounded-2xl bg-danger/10 px-4 py-3 md:mx-8">
        <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div class="flex items-center gap-2.5 text-sm text-danger">
            <TriangleAlert size={18} class="shrink-0" />
            <span>
              {gmailBannerItem.kind === 'gmail_auth_revoked'
                ? 'Google access was revoked — sending and reply collection are stopped until you reconnect.'
                : 'Gmail is not connected — outbound email sending is disabled.'}
            </span>
          </div>
          <button type="button" onclick={handleConnectGmail} disabled={connectingGmail} class="btn btn-danger btn-sm">
            {connectingGmail ? 'Connecting…' : 'Connect Gmail'}
          </button>
        </div>
        {#if gmailConnectError}
          <p class="mt-1 text-xs text-danger">Error: {gmailConnectError}</p>
        {/if}
      </div>
    {/if}

    <main class="flex-1 overflow-y-auto px-4 py-5 md:px-8 md:py-6">
      {#if data.activeProjectId || isTenantScoped(page.url.pathname)}
        {@render children()}
      {:else}
        <div class="flex h-full flex-col items-center justify-center gap-4 text-center">
          <Logo size={40} class="text-accent" />
          <div>
            <p class="font-display text-xl font-semibold text-text">No projects yet</p>
            <p class="mt-1 text-sm text-text-secondary">
              Paste your website URL in the chat — Ace proposes who to contact and what to say.
            </p>
          </div>
          <a href="/chat" class="btn btn-primary">Set up in chat</a>
        </div>
      {/if}
    </main>
  </div>
</div>
