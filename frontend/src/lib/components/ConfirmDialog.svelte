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
  <h3 id="confirm-dialog-title" class="font-display text-lg font-semibold text-text">{title}</h3>
  <p class="mt-2 text-sm text-text-secondary">{message}</p>
  <div class="mt-6 flex justify-end gap-2">
    <button type="button" onclick={oncancel} class="btn btn-ghost">Cancel</button>
    <button type="button" onclick={onconfirm} class="btn {danger ? 'btn-danger' : 'btn-primary'}">
      {confirmLabel}
    </button>
  </div>
</Modal>
