<script lang="ts">
  let { message = 'No data' }: { message?: string } = $props();
</script>

<div class="flex items-center justify-center py-16">
  <p class="text-text-muted text-sm">{message}</p>
</div>
