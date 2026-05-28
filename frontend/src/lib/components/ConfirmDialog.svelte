<script lang="ts">
  let {
    title,
    message,
    confirmLabel = 'Confirm',
    danger = false,
    onconfirm,
    oncancel,
  }: {
    title: string;
    message: string;
    confirmLabel?: string;
    danger?: boolean;
    onconfirm: () => void;
    oncancel: () => void;
  } = $props();
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
  onkeydown={(e) => e.key === 'Escape' && oncancel()}
>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="fixed inset-0" onclick={oncancel}></div>
  <div class="relative z-10 w-full max-w-sm rounded-md bg-page border border-border p-6">
    <h3 class="text-sm font-semibold text-text mb-2">{title}</h3>
    <p class="text-xs text-text-secondary mb-6">{message}</p>
    <div class="flex justify-end gap-3">
      <button onclick={oncancel} class="text-xs text-text-muted hover:text-text transition-colors">
        Cancel
      </button>
      <button
        onclick={onconfirm}
        class="rounded px-3 py-1.5 text-xs font-medium transition-colors {danger
          ? 'bg-danger text-page hover:bg-accent-strong'
          : 'bg-text text-page hover:bg-text/90'}"
      >
        {confirmLabel}
      </button>
    </div>
  </div>
</div>
