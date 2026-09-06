<script lang="ts">
  import { ShieldAlert } from '@lucide/svelte';
  import type { PendingCall } from '$lib/types/chat';

  let {
    pending,
    busy,
    onrespond,
  }: { pending: PendingCall; busy: boolean; onrespond: (approve: boolean) => void } = $props();

  const TOOL_LABELS: Record<string, string> = {
    send_email_and_record: 'Send this email',
    start_job: 'Start this job',
    apply_strategy_draft: 'Save the strategy setup',
    delete_prospects: 'Delete prospects',
    delete_organizations: 'Delete organizations',
    delete_project: 'Delete the project',
    discard_drafts: 'Discard drafts',
    set_prospect_do_not_contact: 'Mark do-not-contact',
    update_prospect_status: 'Change prospect status',
  };
  let label = $derived(TOOL_LABELS[pending.name] ?? pending.name);
</script>

<div class="my-2 rounded border border-accent/50 bg-accent/10 px-3 py-2 text-xs">
  <div class="flex items-center gap-2 text-text">
    <ShieldAlert size={14} class="text-accent" />
    <span class="font-medium">Approve: {label}?</span>
  </div>
  <pre class="mt-2 max-h-48 overflow-auto rounded bg-page p-2 font-mono text-[11px] text-text-secondary">{JSON.stringify(pending.args, null, 2)}</pre>
  <div class="mt-2 flex gap-2">
    <button
      type="button"
      disabled={busy}
      onclick={() => onrespond(true)}
      class="rounded bg-accent px-3 py-1 font-medium text-page hover:bg-accent-strong disabled:opacity-50"
    >
      Approve
    </button>
    <button
      type="button"
      disabled={busy}
      onclick={() => onrespond(false)}
      class="rounded border border-border px-3 py-1 text-text hover:bg-surface disabled:opacity-50"
    >
      Decline
    </button>
  </div>
</div>
