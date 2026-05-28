<script lang="ts">
  import type { ProspectStatus } from '$lib/types/prospects';

  let { status }: { status: ProspectStatus } = $props();

  const colors: Record<ProspectStatus, string> = {
    new: 'bg-surface-2 text-text-secondary',
    contacted: 'bg-info/15 text-info',
    responded: 'bg-info/15 text-info',
    converted: 'bg-success/15 text-success',
    rejected: 'bg-danger/15 text-danger',
    inactive: 'bg-surface-2 text-text-muted',
    deferred: 'bg-warning/15 text-warning',
  };
</script>

<span class="inline-block rounded px-1.5 py-0.5 text-[11px] font-medium font-mono {colors[status]}">{status}</span>
