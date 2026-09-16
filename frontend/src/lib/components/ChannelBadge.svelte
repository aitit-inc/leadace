<script lang="ts">
  import type { Channel } from '$lib/types/outreach';

  let { channel }: { channel: Channel } = $props();

  const labels: Record<Channel, string> = {
    email: 'Email',
    form: 'Form',
    sns_twitter: 'X',
    sns_linkedin: 'LinkedIn',
    platform: 'Platform',
  };
</script>

<span class="chip bg-surface-2 text-text-secondary">{labels[channel]}</span>
