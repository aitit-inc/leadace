<script lang="ts">
  import type { DailyTarget } from '$lib/types/project-settings';

  let {
    value = $bindable(),
    daily,
  }: {
    value: number | null;
    daily: DailyTarget;
  } = $props();

  // Mirrors runnableNewProspects (backend domain/daily-target.ts) so the bound
  // shows before saving.
  let wanted = $derived(value ?? daily.planDefault);
  let runnable = $derived(
    Math.max(0, Math.min(wanted, daily.mailboxCapacity ?? Infinity, daily.planCap ?? Infinity)),
  );
  let limitedBy = $derived(
    runnable === wanted ? null : runnable === daily.mailboxCapacity ? 'mailbox' : 'plan',
  );

  function onInput(e: Event) {
    const n = (e.currentTarget as HTMLInputElement).valueAsNumber;
    value = Number.isNaN(n) ? null : n;
  }
</script>

<div>
  <label for="daily-new-prospects" class="mb-2 block text-sm font-medium text-text">
    New prospects per day
  </label>
  <div class="flex items-center gap-2 text-sm text-text">
    <input
      id="daily-new-prospects"
      type="number"
      min="1"
      max="200"
      step="1"
      value={value ?? ''}
      oninput={onInput}
      placeholder={String(daily.planDefault)}
      class="field w-20 tabular-nums"
    />
    <span class="text-text-muted">
      {value === null ? `Following your plan: ${daily.planDefault} a day` : 'a day'}
    </span>
  </div>
  {#if limitedBy === 'mailbox'}
    <p class="mt-2 text-xs text-warning">
      At most {runnable} a day can go out: this project's mailboxes send {daily.mailboxCapacity} emails
      a day, follow-ups included. Add a mailbox or lower the number.
    </p>
  {:else if limitedBy === 'plan'}
    <p class="mt-2 text-xs text-warning">
      At most {runnable} a day can go out: that is your plan's allowance left for this period,
      spread over its remaining weekdays. Credits or a larger plan lift it.
    </p>
  {/if}
  <p class="mt-2 text-xs text-text-muted">
    How many prospects the daily run contacts for the first time. Follow-ups and re-approaches go
    out on top and don't count. Leave it empty to follow your plan's pace. A number you give Ace in
    the chat applies to that run only.
  </p>
</div>
