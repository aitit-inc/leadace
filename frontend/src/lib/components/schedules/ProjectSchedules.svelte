<script lang="ts">
  import { createSchedule } from '$lib/api/schedules';
  import { EVERY_DAY, MAX_SCHEDULES_PER_PROJECT, type Schedule } from '$lib/types/schedules';
  import ScheduleFields from './ScheduleFields.svelte';
  import ScheduleRow from './ScheduleRow.svelte';

  type Props = {
    projectId: string;
    schedules: Schedule[];
    token: string | undefined;
    onChanged: () => void;
  };
  let { projectId, schedules, token, onChanged }: Props = $props();

  const blank = () => ({
    prompt: '',
    hour: 9,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    days: [...EVERY_DAY],
  });

  let draft = $state(blank());
  let adding = $state(false);
  let busy = $state(false);
  let error = $state('');

  async function add() {
    busy = true;
    error = '';
    try {
      await createSchedule({ projectId, ...draft, prompt: draft.prompt.trim() }, fetch, token);
      draft = blank();
      adding = false;
      onChanged();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Unknown error';
    }
    busy = false;
  }
</script>

<div class="space-y-3">
  <div>
    <h3 class="text-sm font-medium text-text">Scheduled runs</h3>
    <p class="mt-1 text-xs text-text-muted">
      An instruction the server runs on its own, written the way you would say it in the
      <a href="/chat" class="underline hover:text-text">chat</a>. A run reads your data and starts
      jobs; outreach follows the outbound mode above (held as drafts, or sent) and your plan's quota
      still caps sends. It never deletes anything, never sets do-not-contact, and never changes a
      schedule. Each run is logged to its own chat thread. Up to {MAX_SCHEDULES_PER_PROJECT} per project.
    </p>
  </div>

  <!-- Keyed on the stored values the row edits, so a schedule changed
       elsewhere (the chat, another tab) reseeds the row instead of leaving a
       stale draft over it. -->
  {#each schedules as schedule (`${schedule.id}:${schedule.prompt}:${schedule.hour}:${schedule.timezone}:${schedule.days.join()}`)}
    <ScheduleRow {schedule} {token} {onChanged} />
  {/each}

  {#if adding}
    <div class="rounded border border-border p-3">
      <textarea
        rows="2"
        maxlength="2000"
        bind:value={draft.prompt}
        placeholder="Run today's cycle for up to 30 prospects."
        class="w-full rounded border border-border bg-page px-2 py-1 text-sm text-text"
      ></textarea>
      <div class="mt-2 flex flex-wrap items-center gap-2 text-xs text-text-secondary">
        <ScheduleFields bind:days={draft.days} bind:hour={draft.hour} bind:timezone={draft.timezone} />
        <button
          type="button"
          class="rounded bg-accent px-2 py-0.5 text-xs text-white hover:bg-accent-strong transition-colors disabled:opacity-50"
          disabled={busy || draft.prompt.trim() === '' || draft.days.length === 0}
          onclick={add}>Add</button>
        <button
          type="button"
          class="text-xs text-text-muted hover:text-text transition-colors"
          onclick={() => (adding = false)}>Cancel</button>
      </div>
    </div>
  {:else if schedules.length < MAX_SCHEDULES_PER_PROJECT}
    <button
      type="button"
      class="text-xs text-accent hover:text-accent-strong transition-colors"
      onclick={() => (adding = true)}>+ add a scheduled run</button>
  {/if}

  {#if error}
    <p class="text-xs text-danger">{error}</p>
  {/if}
</div>
