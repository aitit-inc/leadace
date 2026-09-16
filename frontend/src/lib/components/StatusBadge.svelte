<script lang="ts">
  import type { ProspectStatus } from '$lib/types/prospects';

  let { status }: { status: ProspectStatus } = $props();

  const colors: Record<ProspectStatus, string> = {
    new: 'text-text-secondary ring-1 ring-inset ring-border',
    contacted: 'bg-surface-2 text-text-secondary',
    responded: 'bg-inbound/10 text-inbound',
    converted: 'bg-inbound text-page',
    rejected: 'bg-danger/12 text-danger',
    inactive: 'bg-surface-2 text-text-muted',
    deferred: 'bg-warning/15 text-warning',
  };
</script>

<span class="chip capitalize {colors[status]}">{status}</span>
