<script lang="ts">
  import { untrack } from 'svelte';
  import { deleteSchedule, updateSchedule } from '$lib/api/schedules';
  import { DAY_LABELS, WEEKDAYS, type Schedule } from '$lib/types/schedules';
  import ScheduleFields from './ScheduleFields.svelte';

  type Props = { schedule: Schedule; token: string | undefined; onChanged: () => void };
  let { schedule, token, onChanged }: Props = $props();

  // Seeded once: what the person types stays theirs while they type it. The
  // parent keys this component on the fields below, so a row whose stored
  // values changed is a new component with the newer seed — an untouched row
  // can never sit on a stale value, and a save can never write one back.
  let form = $state(
    untrack(() => ({
      prompt: schedule.prompt,
      hour: schedule.hour,
      timezone: schedule.timezone,
      days: [...schedule.days],
    })),
  );
  let busy = $state(false);
  let error = $state('');

  let dirty = $derived(
    form.prompt !== schedule.prompt ||
      form.hour !== schedule.hour ||
      form.timezone !== schedule.timezone ||
      form.days.join() !== schedule.days.join(),
  );
  let when = $derived(
    `${
      form.days.length === 7
        ? 'Every day'
        : form.days.length === 5 && WEEKDAYS.every((d) => form.days.includes(d))
          ? 'Weekdays'
          : form.days.map((d) => DAY_LABELS[d]).join(' ')
    } at ${String(form.hour).padStart(2, '0')}:00 · ${form.timezone}`,
  );

  async function run(fn: () => Promise<unknown>) {
    busy = true;
    error = '';
    try {
      await fn();
      onChanged();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Unknown error';
    }
    busy = false;
  }
</script>

<div class="rounded border border-border p-3 {schedule.enabled ? '' : 'opacity-60'}">
  <div class="flex items-start justify-between gap-2">
    <span class="text-xs font-medium text-text">{when}</span>
    <div class="flex shrink-0 gap-3 text-xs">
      <button
        type="button"
        class="text-accent hover:text-accent-strong transition-colors"
        disabled={busy}
        onclick={() => run(() => updateSchedule(schedule.id, { enabled: !schedule.enabled }, fetch, token))}
        >{schedule.enabled ? 'Turn off' : 'Turn on'}</button>
      <button
        type="button"
        class="text-text-muted hover:text-danger transition-colors"
        disabled={busy}
        onclick={() => run(() => deleteSchedule(schedule.id, fetch, token))}>Delete</button>
    </div>
  </div>

  <textarea
    rows="2"
    maxlength="2000"
    bind:value={form.prompt}
    class="mt-2 w-full rounded border border-border bg-page px-2 py-1 text-sm text-text"
  ></textarea>

  <div class="mt-2 flex flex-wrap items-center gap-2 text-xs text-text-secondary">
    <ScheduleFields bind:days={form.days} bind:hour={form.hour} bind:timezone={form.timezone} />
    {#if dirty}
      <button
        type="button"
        class="rounded bg-accent px-2 py-0.5 text-xs text-white hover:bg-accent-strong transition-colors disabled:opacity-50"
        disabled={busy || form.prompt.trim() === '' || form.days.length === 0}
        onclick={() => run(() => updateSchedule(schedule.id, form, fetch, token))}>Save</button>
    {/if}
  </div>

  {#if error}
    <p class="mt-2 text-xs text-danger">{error}</p>
  {:else if schedule.lastError}
    <p class="mt-2 text-xs text-danger">
      Last run failed: {schedule.lastError}
      {#if !schedule.enabled}— turned off after {schedule.consecutiveFailures} failures.{/if}
    </p>
  {:else if schedule.lastRunAt}
    <p class="mt-2 text-xs text-text-muted">Last ran {new Date(schedule.lastRunAt).toLocaleString()}</p>
  {/if}
</div>
