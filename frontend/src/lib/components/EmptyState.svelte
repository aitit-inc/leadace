<script lang="ts">
  let { message = 'No data' }: { message?: string } = $props();
</script>

<div class="flex items-center justify-center px-6 py-16">
  <p class="max-w-md text-center text-sm text-text-muted">{message}</p>
</div>
