<script lang="ts">
  import { goto, invalidate } from '$app/navigation';
  import { setActiveProject } from '$lib/active-project';
  import { formatQuotaCompact, OUTREACH_WINDOW_LABEL } from '$lib/format';
  import { EDITION } from '$lib/config';
  import type { PlanInfo } from '$lib/types/plan';
  import type { SupabaseClient, User } from '@supabase/supabase-js';
  import ThemeToggle from './ThemeToggle.svelte';
  import { CreditCard, Briefcase, User as UserIcon, LogOut } from '@lucide/svelte';

  let {
    user,
    plan,
    supabase,
  }: {
    user: User | null;
    plan: PlanInfo | null;
    supabase: SupabaseClient;
  } = $props();

  let open = $state(false);
  let buttonEl: HTMLButtonElement | null = $state(null);
  let menuEl: HTMLDivElement | null = $state(null);

  let avatarUrl = $derived.by(() => {
    const meta = (user?.user_metadata ?? {}) as Record<string, unknown>;
    const v = meta['avatar_url'] ?? meta['picture'];
    return typeof v === 'string' ? v : null;
  });
  let displayInitial = $derived((user?.email ?? '?').charAt(0).toUpperCase());

  function toggle() {
    open = !open;
  }

  function close() {
    open = false;
  }

  async function handleLogout() {
    close();
    await supabase.auth.signOut();
    await setActiveProject(null);
    await invalidate('supabase:auth');
    void goto('/login');
  }

  $effect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node;
      if (buttonEl?.contains(target) || menuEl?.contains(target)) return;
      close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  });
</script>

<div class="relative">
  <button
    bind:this={buttonEl}
    type="button"
    onclick={toggle}
    aria-haspopup="menu"
    aria-expanded={open}
    title={user?.email ?? 'Account'}
    class="block h-9 w-9 overflow-hidden rounded-full border border-border hover:ring-2 hover:ring-border focus:outline-none focus:ring-2 focus:ring-text/30"
  >
    {#if avatarUrl}
      <img src={avatarUrl} alt="" class="h-full w-full object-cover" referrerpolicy="no-referrer" />
    {:else}
      <span class="flex h-full w-full items-center justify-center bg-surface text-sm text-text-muted">
        {displayInitial}
      </span>
    {/if}
  </button>

  {#if open}
    <div
      bind:this={menuEl}
      role="menu"
      class="absolute bottom-12 left-0 z-40 w-60 rounded-md border border-border bg-page shadow-lg"
    >
      <div class="px-3 py-3 border-b border-border">
        <p class="truncate text-xs text-text-muted">Signed in as</p>
        <p class="truncate text-sm text-text font-mono">{user?.email ?? '—'}</p>
      </div>

      {#if plan}
        <a
          href="/plans"
          onclick={close}
          class="block px-3 py-2.5 border-b border-border hover:bg-surface transition-colors"
        >
          <div class="flex items-center justify-between mb-1">
            <span class="text-xs text-text-muted uppercase tracking-wider">Plan</span>
            <span class="text-[10px] text-text-muted uppercase tracking-wider">
              {plan.outreach.kind === 'unlimited'
                ? '∞'
                : OUTREACH_WINDOW_LABEL[plan.outreach.bindingConstraint]}
            </span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-sm font-medium text-text capitalize">{plan.plan}</span>
            <span class="font-mono text-[11px] text-text-muted">
              {formatQuotaCompact(
                plan.outreach.used,
                plan.outreach.kind === 'capped' ? plan.outreach.limit : null,
              )}
            </span>
          </div>
          {#if plan.outreach.kind === 'capped'}
            <div class="mt-1.5 h-0.5 w-full rounded-full bg-surface">
              <div
                class="h-0.5 rounded-full {plan.outreach.remaining === 0
                  ? 'bg-accent'
                  : 'bg-text-muted'}"
                style="width: {Math.min(100, (plan.outreach.used / plan.outreach.limit) * 100)}%"
              ></div>
            </div>
          {/if}
        </a>
      {/if}

      <nav class="py-1">
        <a
          href="/plans"
          onclick={close}
          role="menuitem"
          class="flex items-center gap-2.5 px-3 py-1.5 text-sm text-text-secondary hover:bg-surface hover:text-text transition-colors"
        >
          <CreditCard size={14} />
          Plans
        </a>
        <a
          href="/workspace-settings"
          onclick={close}
          role="menuitem"
          class="flex items-center gap-2.5 px-3 py-1.5 text-sm text-text-secondary hover:bg-surface hover:text-text transition-colors"
        >
          <Briefcase size={14} />
          Workspace
        </a>
        <a
          href="/account-settings"
          onclick={close}
          role="menuitem"
          class="flex items-center gap-2.5 px-3 py-1.5 text-sm text-text-secondary hover:bg-surface hover:text-text transition-colors"
        >
          <UserIcon size={14} />
          Account
        </a>
      </nav>

      <div class="border-t border-border px-3 py-2 flex items-center justify-between">
        <span class="text-xs text-text-muted">Theme</span>
        <ThemeToggle />
      </div>

      <button
        type="button"
        onclick={handleLogout}
        role="menuitem"
        class="flex w-full items-center gap-2.5 border-t border-border px-3 py-2 text-left text-sm text-text-secondary hover:bg-surface hover:text-text transition-colors"
      >
        <LogOut size={14} />
        Sign out
      </button>

      {#if EDITION === 'cloud'}
        <div class="flex gap-3 border-t border-border px-3 py-2 text-[11px] text-text-muted">
          <a href="/terms" onclick={close} class="hover:text-text transition-colors">Terms</a>
          <a href="/privacy" onclick={close} class="hover:text-text transition-colors">Privacy</a>
        </div>
      {/if}
    </div>
  {/if}
</div>
