<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { setActiveProject } from '$lib/active-project';
  import type { Project } from '$lib/types/projects';
  import { ChevronDown, Check, Plus } from '@lucide/svelte';
  import ProjectCreateDialog from './ProjectCreateDialog.svelte';

  let {
    projects,
    activeProjectId,
  }: { projects: Project[]; activeProjectId: string | null } = $props();

  let showCreate = $state(false);
  let open = $state(false);
  let buttonEl: HTMLButtonElement | null = $state(null);
  let menuEl: HTMLDivElement | null = $state(null);

  let activeProject = $derived(projects.find((p) => p.id === activeProjectId) ?? null);

  function toggle() {
    open = !open;
  }

  function close() {
    open = false;
  }

  async function selectProject(id: string) {
    close();
    if (id === activeProjectId) return;
    await setActiveProject(id);
    // Drop list-page-local query state (?page=, ?status=, etc.) on project
    // switch — those filters belong to the previous project and would
    // otherwise land us on an empty page in the new one.
    void goto(page.url.pathname, { replaceState: true, keepFocus: true, noScroll: true });
  }

  function openCreate() {
    close();
    showCreate = true;
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

<div class="relative inline-block">
  {#if projects.length === 0}
    <button
      type="button"
      onclick={openCreate}
      class="btn btn-ghost btn-sm"
    >
      <Plus size={16} />
      New project
    </button>
  {:else}
    <button
      bind:this={buttonEl}
      type="button"
      onclick={toggle}
      aria-haspopup="menu"
      aria-expanded={open}
      class="flex max-w-full items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold text-text transition-colors hover:bg-surface-2"
    >
      <span class="truncate">{activeProject?.name ?? 'Select project'}</span>
      <ChevronDown size={16} class="shrink-0 text-text-muted" />
    </button>
  {/if}

  {#if open}
    <div
      bind:this={menuEl}
      role="menu"
      class="absolute left-0 top-full z-40 mt-2 w-64 overflow-hidden rounded-2xl border border-border bg-surface shadow-lg"
    >
      <ul class="max-h-72 overflow-y-auto py-1">
        {#each projects as proj (proj.id)}
          {@const active = proj.id === activeProjectId}
          <li>
            <button
              type="button"
              role="menuitem"
              onclick={() => selectProject(proj.id)}
              class="flex w-full items-center gap-2 px-4 py-2 text-left text-sm transition-colors {active
                ? 'font-semibold text-text'
                : 'text-text-secondary hover:bg-surface-2 hover:text-text'}"
            >
              <span class="w-4 shrink-0 text-text">
                {#if active}
                  <Check size={14} />
                {/if}
              </span>
              <span class="truncate">{proj.name}</span>
            </button>
          </li>
        {/each}
      </ul>
      <button
        type="button"
        role="menuitem"
        onclick={openCreate}
        class="flex w-full items-center gap-2 border-t border-border px-4 py-2.5 text-left text-sm text-text-secondary transition-colors hover:bg-surface-2 hover:text-text"
      >
        <Plus size={16} />
        New project
      </button>
    </div>
  {/if}
</div>

{#if showCreate}
  <ProjectCreateDialog onclose={() => (showCreate = false)} />
{/if}
