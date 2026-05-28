<script lang="ts">
  import { goto, invalidate } from '$app/navigation';
  import { page } from '$app/state';
  import { createProject } from '$lib/api/projects';
  import { setActiveProject } from '$lib/active-project';
  import type { Project } from '$lib/types/projects';

  let {
    onclose,
    oncreated,
  }: {
    onclose: () => void;
    oncreated?: (project: Project) => void;
  } = $props();

  let name = $state('');
  let error = $state('');
  let saving = $state(false);

  async function handleSubmit(e: Event) {
    e.preventDefault();
    if (!name.trim()) return;
    saving = true;
    error = '';
    try {
      const token = page.data.session?.access_token;
      const project = await createProject(name.trim(), fetch, token);
      // Persist the new selection to the cookie before invalidating so the
      // server-side rerun of (app)/+layout.server.ts sees it.
      await setActiveProject(project.id);
      // Refresh the projects list so the new row is in /projects before
      // anyone (including this dialog's onclose path) reads it. Drop the
      // list-page query state so the user lands on a clean page-1 of the new
      // project instead of inheriting filters from wherever they were.
      await invalidate('app:projects');
      void goto(page.url.pathname, { replaceState: true, keepFocus: true, noScroll: true });
      oncreated?.(project);
      onclose();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to create project';
      saving = false;
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
  onkeydown={(e) => e.key === 'Escape' && onclose()}
>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="fixed inset-0" onclick={onclose}></div>
  <form
    onsubmit={handleSubmit}
    class="relative z-10 w-full max-w-sm rounded-md bg-page border border-border p-6"
  >
    <h3 class="text-sm font-semibold text-text mb-3">Create project</h3>
    <label for="project-name" class="block text-xs font-medium text-text-secondary mb-1">
      Project name
    </label>
    <!-- svelte-ignore a11y_autofocus -->
    <input
      id="project-name"
      bind:value={name}
      required
      autofocus
      placeholder="my-campaign"
      class="w-full rounded-md bg-surface px-3 py-2 text-sm text-text outline-none focus:ring-2 focus:ring-accent/30 placeholder:text-text-muted"
    />
    {#if error}
      <p class="text-danger text-xs mt-2">{error}</p>
    {/if}
    <div class="mt-5 flex justify-end gap-3">
      <button
        type="button"
        onclick={onclose}
        class="text-xs text-text-muted hover:text-text transition-colors"
      >
        Cancel
      </button>
      <button
        type="submit"
        disabled={saving || !name.trim()}
        class="rounded px-3 py-1.5 text-xs font-medium text-page bg-text hover:bg-text/90 transition-colors disabled:opacity-50"
      >
        {saving ? 'Creating...' : 'Create'}
      </button>
    </div>
  </form>
</div>
