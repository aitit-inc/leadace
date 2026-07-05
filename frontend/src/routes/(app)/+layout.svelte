<script lang="ts">
  import { page } from '$app/state';
  import ProjectSwitcher from '$lib/components/ProjectSwitcher.svelte';
  import ProjectCreateDialog from '$lib/components/ProjectCreateDialog.svelte';
  import Logo from '$lib/components/Logo.svelte';
  import AccountMenu from '$lib/components/AccountMenu.svelte';
  import {
    LayoutDashboard,
    Users,
    Building2,
    Send,
    FilePen,
    MessageSquare,
    ChartBar,
    FileText,
    Inbox,
    Settings,
    Menu,
    X,
    TriangleAlert,
    Rocket,
  } from '@lucide/svelte';
  import type { Component } from 'svelte';
  import { connectGmail } from '$lib/gmail-oauth';
  import type { LayoutProps } from './$types';

  let { data, children }: LayoutProps = $props();
  let showCreate = $state(false);
  let drawerOpen = $state(false);
  let connectingGmail = $state(false);
  let gmailConnectError = $state<string | null>(null);

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
  const nav: NavItem[] = [
    { href: '/dashboard', label: 'Home', icon: LayoutDashboard },
    { href: '/prospects', label: 'Prospects', icon: Users },
    { href: '/organizations', label: 'Orgs', icon: Building2 },
    { href: '/outreach', label: 'Outreach', icon: Send },
    { href: '/drafts', label: 'Drafts', icon: FilePen },
    { href: '/responses', label: 'Replies', icon: MessageSquare },
    { href: '/evaluations', label: 'Eval', icon: ChartBar },
    { href: '/documents', label: 'Docs', icon: FileText },
    { href: '/inquiry-settings', label: 'Inquiry', icon: Inbox },
    { href: '/project-settings', label: 'Settings', icon: Settings },
  ];

  // Pages NOT listed here (prospects, organizations' siblings, project-
  // settings, etc.) are hidden behind the "No projects yet" CTA below when
  // projects.length === 0 — the +layout.server.ts reconciliation guarantees
  // activeProjectId is non-null whenever any project exists.
  const tenantScopedPaths = [
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
</script>

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
    class="fixed inset-y-0 left-0 z-30 flex w-16 flex-col justify-between border-r border-border bg-page py-3 transition-transform md:static md:translate-x-0 {drawerOpen
      ? 'translate-x-0'
      : '-translate-x-full'}"
    aria-hidden={!drawerOpen}
  >
    <div>
      <div class="mb-5 flex items-center justify-center px-1 relative">
        <a
          href="/dashboard"
          title="LeadAce"
          class="text-accent hover:text-accent-strong transition-colors"
        >
          <Logo size={22} />
        </a>
        <button
          type="button"
          class="md:hidden absolute right-1 top-0 p-1 text-text-muted hover:text-text"
          aria-label="Close menu"
          onclick={() => (drawerOpen = false)}
        >
          <X size={18} />
        </button>
      </div>
      <nav class="space-y-0.5 px-1.5">
        {#each nav as item}
          {@const Icon = item.icon}
          <a
            href={item.href}
            title={item.label}
            class="flex flex-col items-center gap-0.5 rounded px-1 py-2 transition-colors {isActive(
              item.href,
            )
              ? 'bg-surface-2 text-text'
              : 'text-text-secondary hover:text-text hover:bg-surface'}"
          >
            <Icon size={18} />
            <span class="text-[10px] leading-none">{item.label}</span>
          </a>
        {/each}
      </nav>
    </div>

    <div class="flex justify-center">
      <AccountMenu user={data.user} plan={data.plan} supabase={data.supabase} />
    </div>
  </aside>

  <div class="flex flex-1 flex-col overflow-hidden">
    {#if showCreate}
      <ProjectCreateDialog
        onclose={() => (showCreate = false)}
        oncreated={() => window.location.reload()}
      />
    {/if}
    <header class="flex items-center gap-3 border-b border-border px-4 py-3 md:px-6">
      <button
        type="button"
        class="-ml-1 p-1 text-text-muted hover:text-text md:hidden"
        aria-label="Open menu"
        aria-expanded={drawerOpen}
        onclick={() => (drawerOpen = true)}
      >
        <Menu size={22} />
      </button>
      <div class="min-w-0 flex-1">
        <ProjectSwitcher projects={data.projects} activeProjectId={data.activeProjectId} />
      </div>
    </header>

    {#if !data.mcpConnected && page.url.pathname !== '/onboarding' && page.url.pathname !== '/dashboard'}
      <div class="border-b border-accent/40 bg-accent/10 px-4 py-2 md:px-6">
        <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <div class="flex items-center gap-2 text-sm text-text">
            <Rocket size={16} class="text-accent" />
            <span>Connect the LeadAce plugin in Claude Code to start finding and emailing prospects.</span>
          </div>
          <a
            href="/onboarding"
            class="rounded border border-accent/60 bg-page px-3 py-1 text-xs font-medium text-accent hover:bg-accent/10"
          >
            Finish setup
          </a>
        </div>
      </div>
    {/if}

    {#if data.gmailStatus.state === 'disconnected' && page.url.pathname !== '/dashboard'}
      <!--
        Gmail send permission lapsed (never granted, refresh token revoked, or
        scope dropped). Surface globally rather than only on /account-settings
        so the user notices before triggering a send that would silently fail.
        Backend deletes the credential row on token revoke (auth/google.ts),
        so this state is reachable mid-session, not just on first sign-in.
      -->
      <div class="border-b border-danger/40 bg-danger/10 px-4 py-2 md:px-6">
        <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <div class="flex items-center gap-2 text-sm text-danger">
            <TriangleAlert size={16} />
            <span>Gmail is not connected — outbound email sending is disabled.</span>
          </div>
          <button
            type="button"
            onclick={handleConnectGmail}
            disabled={connectingGmail}
            class="rounded border border-danger/60 bg-page px-3 py-1 text-xs font-medium text-danger hover:bg-danger/10 disabled:opacity-50"
          >
            {connectingGmail ? 'Connecting…' : 'Connect Gmail'}
          </button>
        </div>
        {#if gmailConnectError}
          <p class="mt-1 text-xs text-danger">Error: {gmailConnectError}</p>
        {/if}
      </div>
    {/if}

    <main class="flex-1 overflow-y-auto px-4 py-4 md:px-6 md:py-5">
      {#if data.activeProjectId || isTenantScoped(page.url.pathname)}
        {@render children()}
      {:else}
        <div class="flex flex-col items-center justify-center h-full gap-4">
          <div class="text-center">
            <p class="text-sm text-text">No projects yet</p>
            <p class="text-xs text-text-muted mt-1">
              Create your first project to start tracking prospects and outreach.
            </p>
          </div>
          <button
            onclick={() => (showCreate = true)}
            class="rounded bg-text px-4 py-1.5 text-xs font-medium text-page hover:bg-text/90 transition-colors disabled:opacity-50"
          >
            Create your first project
          </button>
        </div>
      {/if}
    </main>
  </div>
</div>
