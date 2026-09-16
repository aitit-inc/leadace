<script lang="ts">
  import { goto, invalidate } from '$app/navigation';
  import { page } from '$app/state';
  import { createProject } from '$lib/api/projects';
  import { setActiveProject } from '$lib/active-project';
  import Modal from '$lib/components/Modal.svelte';
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

<Modal labelledBy="create-project-title" size="sm" closable={!saving} {onclose}>
  <form onsubmit={handleSubmit}>
    <h3 id="create-project-title" class="mb-4 font-display text-lg font-semibold text-text">Create project</h3>
    <label for="project-name" class="mb-1.5 block text-sm font-medium text-text-secondary">
      Project name
    </label>
    <!-- svelte-ignore a11y_autofocus -->
    <input
      id="project-name"
      bind:value={name}
      required
      autofocus
      placeholder="my-campaign"
      class="field"
    />
    {#if error}
      <p class="mt-2 text-sm text-danger">{error}</p>
    {/if}
    <div class="mt-6 flex justify-end gap-2">
      <button type="button" onclick={onclose} class="btn btn-ghost">
        Cancel
      </button>
      <button
        type="submit"
        disabled={saving || !name.trim()}
        class="btn btn-primary"
      >
        {saving ? 'Creating...' : 'Create'}
      </button>
    </div>
  </form>
</Modal>
