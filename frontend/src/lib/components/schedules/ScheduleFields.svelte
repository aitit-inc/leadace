<script lang="ts">
  import { DAY_LABELS, EVERY_DAY, type DayOfWeek } from '$lib/types/schedules';

  type Props = { days: DayOfWeek[]; hour: number; timezone: string };
  let { days = $bindable(), hour = $bindable(), timezone = $bindable() }: Props = $props();

  const HOURS = Array.from({ length: 24 }, (_, h) => h);
  const ZONES = Intl.supportedValuesOf('timeZone');

  function toggle(day: DayOfWeek) {
    days = days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort((a, b) => a - b);
  }
</script>

{#each EVERY_DAY as day (day)}
  <label class="flex items-center gap-1">
    <input type="checkbox" checked={days.includes(day)} onchange={() => toggle(day)} />
    {DAY_LABELS[day]}
  </label>
{/each}
<select bind:value={hour} class="field w-auto tabular-nums">
  {#each HOURS as h (h)}
    <option value={h}>{String(h).padStart(2, '0')}:00</option>
  {/each}
</select>
<select bind:value={timezone} class="field w-auto">
  {#each ZONES as zone (zone)}
    <option value={zone}>{zone}</option>
  {/each}
</select>
