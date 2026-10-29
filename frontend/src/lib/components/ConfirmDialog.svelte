<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Loader2 } from '@lucide/svelte';
  import Modal from './Modal.svelte';

  let {
    title,
    message,
    confirmLabel = 'Confirm',
    danger = false,
    onconfirm,
    oncancel,
    children,
  }: {
    title: string;
    message: string;
    confirmLabel?: string;
    danger?: boolean;
    // A returned promise locks the dialog until it settles; a rejection is
    // shown in it.
    onconfirm: () => void | Promise<void>;
    oncancel: () => void;
    children?: Snippet;
  } = $props();

  let busy = $state(false);
  let error = $state('');

  async function confirm() {
    const result = onconfirm();
    if (!result) return;
    busy = true;
    error = '';
    try {
      await result;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Unknown error';
    } finally {
      busy = false;
    }
  }
</script>

<Modal labelledBy="confirm-dialog-title" size="sm" closable={!busy} onclose={oncancel}>
  <h3 id="confirm-dialog-title" class="font-display text-lg font-semibold text-text">{title}</h3>
  <p class="mt-2 text-sm text-text-secondary">{message}</p>
  {@render children?.()}
  {#if error}
    <p role="alert" class="mt-4 rounded-2xl bg-danger/10 px-4 py-3 text-sm text-danger">{error}</p>
  {/if}
  <div class="mt-6 flex justify-end gap-2">
    <button type="button" onclick={oncancel} disabled={busy} class="btn btn-ghost">Cancel</button>
    <button type="button" onclick={confirm} disabled={busy} class="btn {danger ? 'btn-danger' : 'btn-primary'}">
      {#if busy}<Loader2 size={16} class="animate-spin" />{/if}
      {confirmLabel}
    </button>
  </div>
</Modal>
