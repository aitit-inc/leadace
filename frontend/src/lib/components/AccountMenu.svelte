<script lang="ts">
  import { goto, invalidate } from '$app/navigation';
  import { setActiveProject } from '$lib/active-project';
  import { formatQuotaCompact, QUOTA_WINDOW_LABEL } from '$lib/format';
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

  let meta = $derived((user?.user_metadata ?? {}) as Record<string, unknown>);
  let avatarUrl = $derived.by(() => {
    const v = meta['avatar_url'] ?? meta['picture'];
    return typeof v === 'string' ? v : null;
  });
  let displayName = $derived.by(() => {
    const v = meta['full_name'] ?? meta['name'];
    return typeof v === 'string' && v.trim() ? v : (user?.email ?? 'Account');
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
    class="flex w-full items-center gap-2.5 rounded-full p-1.5 pr-3 text-left transition-colors hover:bg-surface-2"
  >
    <span class="h-8 w-8 shrink-0 overflow-hidden rounded-full bg-surface-2">
      {#if avatarUrl}
        <img src={avatarUrl} alt="" class="h-full w-full object-cover" referrerpolicy="no-referrer" />
      {:else}
        <span class="flex h-full w-full items-center justify-center text-sm font-semibold text-text-secondary">
          {displayInitial}
        </span>
      {/if}
    </span>
    <span class="min-w-0 flex-1">
      <span class="block truncate text-sm font-semibold text-text">{displayName}</span>
      {#if plan}
        <span class="block truncate text-xs capitalize text-text-muted">{plan.plan} plan</span>
      {/if}
    </span>
  </button>

  {#if open}
    <div
      bind:this={menuEl}
      role="menu"
      class="absolute bottom-full left-0 z-40 mb-2 w-64 overflow-hidden rounded-2xl border border-border bg-surface shadow-lg"
    >
      <div class="border-b border-border px-4 py-3">
        <p class="truncate text-xs text-text-muted">Signed in as</p>
        <p class="truncate text-sm text-text">{user?.email ?? '—'}</p>
      </div>

      {#if plan}
        <a
          href="/plans"
          onclick={close}
          class="block border-b border-border px-4 py-3 transition-colors hover:bg-surface-2"
        >
          <div class="flex items-center justify-between">
            <span class="text-sm font-semibold capitalize text-text">{plan.plan}</span>
            {#if plan.quota.kind === 'capped'}
              <span class="text-xs tabular-nums text-text-muted">
                {formatQuotaCompact(plan.quota.contacted.used, plan.quota.contacted.limit)}
              </span>
            {/if}
          </div>
          <p class="text-xs text-text-muted">
            {plan.quota.kind === 'unlimited' ? 'Unlimited prospects' : `Prospects ${QUOTA_WINDOW_LABEL[plan.quota.window]}`}
          </p>
          {#if plan.quota.kind === 'capped'}
            <div class="mt-2 h-1 w-full rounded-full bg-surface-2">
              <div
                class="h-1 rounded-full {plan.quota.contacted.remaining === 0 ? 'bg-warning' : 'bg-text-muted'}"
                style="width: {Math.min(100, (plan.quota.contacted.used / plan.quota.contacted.limit) * 100)}%"
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
          class="flex items-center gap-2.5 px-4 py-2 text-sm text-text-secondary transition-colors hover:bg-surface-2 hover:text-text"
        >
          <CreditCard size={16} />
          Plans
        </a>
        <a
          href="/workspace-settings"
          onclick={close}
          role="menuitem"
          class="flex items-center gap-2.5 px-4 py-2 text-sm text-text-secondary transition-colors hover:bg-surface-2 hover:text-text"
        >
          <Briefcase size={16} />
          Workspace
        </a>
        <a
          href="/account-settings"
          onclick={close}
          role="menuitem"
          class="flex items-center gap-2.5 px-4 py-2 text-sm text-text-secondary transition-colors hover:bg-surface-2 hover:text-text"
        >
          <UserIcon size={16} />
          Account
        </a>
      </nav>

      <div class="flex items-center justify-between border-t border-border px-4 py-2">
        <span class="text-sm text-text-secondary">Theme</span>
        <ThemeToggle />
      </div>

      <button
        type="button"
        onclick={handleLogout}
        role="menuitem"
        class="flex w-full items-center gap-2.5 border-t border-border px-4 py-2.5 text-left text-sm text-text-secondary transition-colors hover:bg-surface-2 hover:text-text"
      >
        <LogOut size={16} />
        Sign out
      </button>

      {#if EDITION === 'cloud'}
        <div class="flex gap-3 border-t border-border px-4 py-2 text-xs text-text-muted">
          <a href="/terms" onclick={close} class="hover:text-text">Terms</a>
          <a href="/privacy" onclick={close} class="hover:text-text">Privacy</a>
        </div>
      {/if}
    </div>
  {/if}
</div>
