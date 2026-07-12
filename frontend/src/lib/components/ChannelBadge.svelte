<script lang="ts">
  import type { Channel } from '$lib/types/outreach';

  let { channel }: { channel: Channel } = $props();

  const labels: Record<Channel, string> = {
    email: 'email',
    form: 'form',
    sns_twitter: 'x',
    sns_linkedin: 'linkedin',
    platform: 'platform',
  };
</script>

<span class="inline-block rounded bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium font-mono text-text-secondary">{labels[channel]}</span>
