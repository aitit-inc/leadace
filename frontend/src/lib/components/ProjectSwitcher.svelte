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
      class="flex items-center gap-1.5 rounded px-2 py-1 text-sm text-text-secondary hover:bg-surface hover:text-text transition-colors"
    >
      <Plus size={14} />
      New project
    </button>
  {:else}
    <button
      bind:this={buttonEl}
      type="button"
      onclick={toggle}
      aria-haspopup="menu"
      aria-expanded={open}
      class="flex items-center gap-1.5 rounded px-2 py-1 text-sm font-mono text-text hover:bg-surface transition-colors focus:outline-none focus:bg-surface"
    >
      <span class="truncate">{activeProject?.name ?? 'Select project'}</span>
      <ChevronDown size={14} class="text-text-muted" />
    </button>
  {/if}

  {#if open}
    <div
      bind:this={menuEl}
      role="menu"
      class="absolute left-0 top-full z-40 mt-1 w-56 rounded-md border border-border bg-page shadow-lg"
    >
      <ul class="max-h-72 overflow-y-auto py-1">
        {#each projects as proj (proj.id)}
          {@const active = proj.id === activeProjectId}
          <li>
            <button
              type="button"
              role="menuitem"
              onclick={() => selectProject(proj.id)}
              class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm font-mono transition-colors {active
                ? 'bg-surface text-text'
                : 'text-text-secondary hover:bg-surface hover:text-text'}"
            >
              <span class="w-3.5 shrink-0 text-accent">
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
        class="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-xs text-text-secondary hover:bg-surface hover:text-text transition-colors"
      >
        <Plus size={14} />
        New project
      </button>
    </div>
  {/if}
</div>

{#if showCreate}
  <ProjectCreateDialog onclose={() => (showCreate = false)} />
{/if}
