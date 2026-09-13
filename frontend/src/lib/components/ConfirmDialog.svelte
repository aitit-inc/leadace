<script lang="ts">
  import Modal from './Modal.svelte';

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

<Modal labelledBy="confirm-dialog-title" size="sm" onclose={oncancel}>
  <h3 id="confirm-dialog-title" class="text-sm font-semibold text-text mb-2">{title}</h3>
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
</Modal>
