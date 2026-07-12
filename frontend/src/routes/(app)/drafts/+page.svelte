<script lang="ts">
  import { goto, invalidate } from '$app/navigation';
  import { page } from '$app/state';
  import {
    discardDraft,
    discardDrafts,
    markDraftSent,
    previewDraft,
    sendDraft,
    updateDraft,
  } from '$lib/api/drafts';
  import { ApiError } from '$lib/api';
  import { safeHttpUrl } from '$lib/redirect';
  import type { Channel, DraftFooter, OutreachDraft } from '$lib/types/outreach';
  import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import Pagination from '$lib/components/Pagination.svelte';
  import type { PageProps } from './$types';
  import { PAGE_SIZE } from '$lib/pagination';

  type EditState = { subject: string; body: string; saving: boolean };
  type PreviewState = { loading: boolean; footer: DraftFooter | null; error: string | null };
  type DeliverKind = 'send-email' | 'mark-sent';

  let { data }: PageProps = $props();
  let token = $derived(data.session?.access_token);

  let expandedId = $state<number | null>(null);
  let edits = $state<Record<number, EditState>>({});
  // Footer is independent of the editable body, so fetch once per draft.
  let previews = $state<Record<number, PreviewState>>({});
  let banner = $state<{ kind: 'info' | 'error'; text: string } | null>(null);
  let confirming = $state<
    | { kind: DeliverKind | 'discard'; draft: OutreachDraft }
    | { kind: 'discard-batch'; ids: number[] }
    | { kind: 'send-batch'; ids: number[] }
    | null
  >(null);
  let busyId = $state<number | null>(null);
  let copiedId = $state<number | null>(null);
  let selectedIds = $state<Set<number>>(new Set());
  let batchBusy = $state(false);

  // Drop per-row state for rows no longer in the visible page — a deleted
  // draft must not linger in selectedIds and resurrect on the next batch action.
  $effect(() => {
    const present = new Set(data.drafts.map((d) => d.id));

    let edMutated = false;
    const nextEdits: Record<number, EditState> = {};
    for (const [k, v] of Object.entries(edits)) {
      if (present.has(Number(k))) nextEdits[Number(k)] = v;
      else edMutated = true;
    }
    if (edMutated) edits = nextEdits;

    let pvMutated = false;
    const nextPreviews: Record<number, PreviewState> = {};
    for (const [k, v] of Object.entries(previews)) {
      if (present.has(Number(k))) nextPreviews[Number(k)] = v;
      else pvMutated = true;
    }
    if (pvMutated) previews = nextPreviews;

    let selMutated = false;
    const nextSel = new Set<number>();
    for (const id of selectedIds) {
      if (present.has(id)) nextSel.add(id);
      else selMutated = true;
    }
    if (selMutated) selectedIds = nextSel;

    if (expandedId !== null && !present.has(expandedId)) expandedId = null;
  });

  let allSelected = $derived(data.drafts.length > 0 && selectedIds.size === data.drafts.length);
  let someSelected = $derived(selectedIds.size > 0 && selectedIds.size < data.drafts.length);
  let sendableEmailCount = $derived.by(() => {
    if (selectedIds.size === 0) return 0;
    const byId = new Map(data.drafts.map((d) => [d.id, d]));
    let n = 0;
    for (const id of selectedIds) {
      const d = byId.get(id);
      if (d && d.channel === 'email' && d.prospectEmail) n += 1;
    }
    return n;
  });

  function onPageChange(n: number) {
    const sp = new URLSearchParams(page.url.searchParams);
    if (n > 1) sp.set('page', String(n));
    else sp.delete('page');
    const qs = sp.toString();
    void goto(qs ? `?${qs}` : '?', { replaceState: true, keepFocus: true, noScroll: true });
  }

  // Step back a page when a removal empties the current one — avoid an empty pager.
  async function refreshAfterMutation(removed: number) {
    const visibleCount = Math.max(0, data.drafts.length - removed);
    if (visibleCount === 0 && data.page > 1) {
      onPageChange(data.page - 1);
    } else {
      await invalidate('app:drafts');
    }
  }

  function toggleExpand(d: OutreachDraft) {
    if (expandedId === d.id) {
      expandedId = null;
      return;
    }
    expandedId = d.id;
    if (!edits[d.id]) {
      edits[d.id] = { subject: d.subject ?? '', body: d.body, saving: false };
    }
    void loadPreview(d);
  }

  // Form / SNS drafts already carry the footer in the (editable) body.
  async function loadPreview(d: OutreachDraft) {
    if (d.channel !== 'email') return;
    // A transient failure must not be cached for the rest of the session.
    const existing = previews[d.id];
    if (existing && (existing.loading || !existing.error)) return;
    previews[d.id] = { loading: true, footer: null, error: null };
    try {
      const res = await previewDraft(d.id, fetch, token);
      previews[d.id] = { loading: false, footer: res.footer, error: null };
    } catch (err) {
      previews[d.id] = {
        loading: false,
        footer: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  function isDirty(d: OutreachDraft): boolean {
    const e = edits[d.id];
    if (!e) return false;
    return e.subject !== (d.subject ?? '') || e.body !== d.body;
  }

  // Throws on failure so send / mark-sent paths can abort before dispatching
  // the pre-edit server-side body.
  async function saveEdits(d: OutreachDraft): Promise<void> {
    const e = edits[d.id];
    if (!e || !isDirty(d)) return;
    e.saving = true;
    try {
      const body = e.body;
      const patch: { subject?: string | null; body: string } = { body };
      if (d.channel === 'email') {
        patch.subject = e.subject || null;
      }
      await updateDraft(d.id, patch, fetch, token);
      await invalidate('app:drafts');
    } finally {
      e.saving = false;
    }
  }

  async function handleSaveEditsButton(d: OutreachDraft) {
    try {
      await saveEdits(d);
      banner = { kind: 'info', text: 'Draft saved.' };
    } catch (err) {
      banner = { kind: 'error', text: err instanceof Error ? err.message : String(err) };
    }
  }

  async function sendEmailDraft(d: OutreachDraft) {
    busyId = d.id;
    try {
      if (isDirty(d)) {
        try {
          await saveEdits(d);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          banner = { kind: 'error', text: `Save failed — content not sent (${msg})` };
          return;
        }
      }
      await sendDraft(d.id, fetch, token);
      banner = { kind: 'info', text: `Sent to ${d.prospectEmail}.` };
      await Promise.all([refreshAfterMutation(1), invalidate('app:plan')]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      banner = { kind: 'error', text: `Send failed — ${msg}` };
    } finally {
      busyId = null;
    }
  }

  async function handleMarkSent(d: OutreachDraft) {
    busyId = d.id;
    try {
      if (isDirty(d)) {
        try {
          await saveEdits(d);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          banner = { kind: 'error', text: `Save failed — not marked as sent (${msg})` };
          return;
        }
      }
      await markDraftSent(d.id, fetch, token);
      banner = { kind: 'info', text: `Marked as sent (${channelLabel(d.channel)}).` };
      await Promise.all([refreshAfterMutation(1), invalidate('app:plan')]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      banner = { kind: 'error', text: `Mark-sent failed — ${msg}` };
    } finally {
      busyId = null;
    }
  }

  async function handleDiscard(d: OutreachDraft) {
    busyId = d.id;
    try {
      await discardDraft(d.id, fetch, token);
      banner = { kind: 'info', text: 'Draft discarded.' };
      await refreshAfterMutation(1);
    } catch (err) {
      banner = { kind: 'error', text: err instanceof Error ? err.message : String(err) };
    } finally {
      busyId = null;
    }
  }

  async function discardSelected() {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    batchBusy = true;
    try {
      const res = await discardDrafts(ids, fetch, token);
      selectedIds = new Set();
      const skipNote = res.skippedIds.length > 0
        ? ` (${res.skippedIds.length} skipped — already sent or no longer pending)`
        : '';
      banner = { kind: 'info', text: `Discarded ${res.deletedIds.length} draft(s)${skipNote}.` };
      await refreshAfterMutation(res.deletedIds.length);
    } catch (err) {
      banner = { kind: 'error', text: err instanceof Error ? err.message : String(err) };
    } finally {
      batchBusy = false;
    }
  }

  // Email-only — form / SNS drafts use the per-row Mark-sent button after the
  // user submits the destination themselves.
  async function sendSelected() {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const draftsById = new Map(data.drafts.map((d) => [d.id, d]));
    batchBusy = true;
    let sentCount = 0;
    let failedCount = 0;
    let skippedCount = 0;
    let stopped: string | null = null;
    try {
      for (const id of ids) {
        const d = draftsById.get(id);
        if (!d) { skippedCount += 1; continue; }
        if (d.channel !== 'email' || !d.prospectEmail) {
          skippedCount += 1;
          continue;
        }
        if (isDirty(d)) {
          try {
            await saveEdits(d);
          } catch {
            failedCount += 1;
            continue;
          }
        }
        try {
          await sendDraft(d.id, fetch, token);
          sentCount += 1;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (err instanceof ApiError && (err.status === 403 || err.status === 412)) {
            stopped = msg;
            break;
          }
          if (err instanceof ApiError && (err.status === 404 || err.status === 409 || err.status === 422)) {
            skippedCount += 1;
          } else {
            failedCount += 1;
          }
        }
      }
    } finally {
      selectedIds = new Set();
      const parts = [`Sent ${sentCount}`];
      if (failedCount > 0) parts.push(`${failedCount} failed`);
      if (skippedCount > 0) parts.push(`${skippedCount} skipped`);
      const summary = parts.join(', ') + '.';
      banner = stopped
        ? { kind: 'error', text: `${summary} Stopped: ${stopped}` }
        : { kind: failedCount > 0 ? 'error' : 'info', text: summary };
      // Release before refresh so a failing loader can't strand the UI disabled.
      batchBusy = false;
      try {
        await Promise.all([refreshAfterMutation(sentCount), invalidate('app:plan')]);
      } catch { /* outcome already in summary banner */ }
    }
  }

  function toggleSelect(id: number) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selectedIds = next;
  }

  function toggleSelectAll() {
    selectedIds = allSelected ? new Set() : new Set(data.drafts.map((d) => d.id));
  }

  async function copyBody(d: OutreachDraft) {
    const e = edits[d.id];
    const text = e?.body ?? d.body;
    try {
      await navigator.clipboard.writeText(text);
      copiedId = d.id;
      setTimeout(() => {
        if (copiedId === d.id) copiedId = null;
      }, 1500);
    } catch (err) {
      banner = { kind: 'error', text: 'Copy failed: ' + (err instanceof Error ? err.message : String(err)) };
    }
  }

  function channelLabel(ch: Channel): string {
    switch (ch) {
      case 'email': return 'Email';
      case 'form': return 'Form';
      case 'sns_twitter': return 'X (Twitter) DM';
      case 'sns_linkedin': return 'LinkedIn DM';
      case 'platform': return 'Platform';
    }
  }

  function destinationFor(d: OutreachDraft): { label: string; href: string | null } {
    switch (d.channel) {
      case 'email':
        return { label: d.prospectEmail ?? '(no email)', href: null };
      case 'form':
        return {
          label: d.prospectContactFormUrl ?? '(no form URL)',
          // Legacy rows may carry a non-http(s) URL; the write path now refuses
          // them, but defense-in-depth keeps `javascript:` etc. out of href.
          href: safeHttpUrl(d.prospectContactFormUrl),
        };
      case 'sns_twitter': {
        const handle = d.prospectSnsAccounts?.x ?? null;
        return {
          label: handle ?? '(no X account)',
          href: handle ? `https://x.com/${handle.replace(/^@/, '')}` : null,
        };
      }
      case 'sns_linkedin': {
        const handle = d.prospectSnsAccounts?.linkedin ?? null;
        const rawHref = handle && /^https?:\/\//i.test(handle)
          ? handle
          : (handle ? `https://www.linkedin.com/in/${handle.replace(/^@/, '')}` : null);
        return {
          label: handle ?? '(no LinkedIn account)',
          href: safeHttpUrl(rawHref),
        };
      }
      case 'platform':
        return {
          label: d.prospectPlatformUrl ?? '(no platform URL)',
          href: safeHttpUrl(d.prospectPlatformUrl),
        };
    }
  }

  function deliverKind(ch: Channel): DeliverKind {
    return ch === 'email' ? 'send-email' : 'mark-sent';
  }

  function confirmCopy(
    c:
      | { kind: DeliverKind | 'discard'; draft: OutreachDraft }
      | { kind: 'discard-batch'; ids: number[] }
      | { kind: 'send-batch'; ids: number[] },
  ): { title: string; message: string; label: string } {
    if (c.kind === 'send-batch') {
      const draftsById = new Map(data.drafts.map((d) => [d.id, d]));
      let emails = 0;
      let skipped = 0;
      for (const id of c.ids) {
        const d = draftsById.get(id);
        if (!d) { skipped += 1; continue; }
        if (d.channel === 'email' && d.prospectEmail) emails += 1;
        else skipped += 1;
      }
      const skipNote = skipped > 0
        ? ` ${skipped} form / SNS draft${skipped === 1 ? '' : 's'} in the selection will be skipped — use the per-row "Mark sent" button after submitting.`
        : '';
      return {
        title: `Send ${emails} email draft${emails === 1 ? '' : 's'}?`,
        message:
          `${emails} email draft${emails === 1 ? '' : 's'} will be sent via your connected Gmail. Each one counts toward your outreach quota.${skipNote}`,
        label: `Send ${emails}`,
      };
    }
    if (c.kind === 'discard-batch') {
      const n = c.ids.length;
      return {
        title: `Discard ${n} draft${n === 1 ? '' : 's'}?`,
        message:
          'Selected drafts will be deleted. Any prospect whose only outreach was a discarded draft will be available for outbound again.',
        label: `Discard ${n}`,
      };
    }
    if (c.kind === 'discard') {
      return {
        title: 'Discard this draft?',
        message:
          'The draft will be deleted. If this was the only outreach for the prospect, they will be available for outbound again.',
        label: 'Discard',
      };
    }
    if (c.kind === 'send-email') {
      return {
        title: 'Send this draft?',
        message: `This sends the email to ${c.draft.prospectEmail} via your connected Gmail. It counts as one outreach action.`,
        label: 'Send',
      };
    }
    return {
      title: 'Mark as sent?',
      message: `Confirm you have sent the ${channelLabel(c.draft.channel).toLowerCase()} manually. This counts as one outreach action.`,
      label: 'Mark as sent',
    };
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function truncate(text: string, max = 100) {
    return text.length > max ? text.slice(0, max) + '…' : text;
  }
</script>

<h2 class="text-lg font-semibold text-text mb-1">Drafts</h2>
<p class="text-xs text-text-muted mb-4">
  Pending review from <span class="font-mono">/outbound</span> in draft mode. Email drafts send via your
  connected Gmail. Form / SNS drafts are sent manually — open the destination, paste the body, then
  mark as sent. Both count toward your outreach quota.
</p>

{#if banner}
  <div
    class="mb-4 rounded border px-3 py-2 text-xs {banner.kind === 'error'
      ? 'border-danger/40 text-danger'
      : 'border-border text-text-secondary'}"
  >
    {banner.text}
  </div>
{/if}

{#if !data.activeProjectId}
  <p class="text-text-muted text-sm">Select a project to view its drafts.</p>
{:else if data.drafts.length === 0}
  <EmptyState message="No drafts pending review" />
{:else}
  <div class="mb-3 flex items-center justify-between gap-3 rounded border border-border bg-surface px-3 py-2">
    <label class="flex items-center gap-2 text-xs text-text">
      <input
        type="checkbox"
        checked={allSelected}
        indeterminate={someSelected}
        onchange={toggleSelectAll}
      />
      <span>
        {#if selectedIds.size === 0}
          Select all ({data.drafts.length})
        {:else}
          {selectedIds.size} selected
        {/if}
      </span>
    </label>
    <div class="flex items-center gap-2">
      <button
        type="button"
        disabled={sendableEmailCount === 0 || batchBusy}
        title={sendableEmailCount === 0 && selectedIds.size > 0
          ? 'Batch send is email-only. Use "Mark sent" on each form / SNS draft instead.'
          : ''}
        onclick={() => (confirming = { kind: 'send-batch', ids: [...selectedIds] })}
        class="rounded bg-text px-3 py-1.5 text-xs font-medium text-page hover:bg-text/90 transition-colors disabled:opacity-40"
      >
        {batchBusy ? 'Working…' : 'Send selected'}
      </button>
      <button
        type="button"
        disabled={selectedIds.size === 0 || batchBusy}
        onclick={() => (confirming = { kind: 'discard-batch', ids: [...selectedIds] })}
        class="rounded px-3 py-1.5 text-xs text-danger hover:bg-page transition-colors disabled:opacity-40"
      >
        Discard selected
      </button>
    </div>
  </div>
  <div class="space-y-2">
    {#each data.drafts as draft (draft.id)}
      {@const expanded = expandedId === draft.id}
      {@const e = edits[draft.id]}
      {@const isEmail = draft.channel === 'email'}
      {@const dest = destinationFor(draft)}
      {@const dk = deliverKind(draft.channel)}
      {@const deliverDisabled = busyId === draft.id || (isEmail ? !draft.prospectEmail : !dest.href)}
      {@const isSelected = selectedIds.has(draft.id)}
      <div class="rounded border {isSelected ? 'border-text/40' : 'border-border'}">
        <div class="flex items-stretch">
          <label class="flex shrink-0 cursor-pointer items-center px-3 hover:bg-surface transition-colors">
            <input
              type="checkbox"
              checked={isSelected}
              onchange={() => toggleSelect(draft.id)}
            />
          </label>
          <button
            type="button"
            class="flex-1 text-left px-3 py-2.5 hover:bg-surface transition-colors"
            onclick={() => toggleExpand(draft)}
          >
          <div class="flex items-baseline justify-between gap-3">
            <span class="text-sm font-medium text-text truncate">{draft.prospectName}</span>
            <span class="text-[11px] text-text-muted font-mono shrink-0">
              {formatDate(draft.createdAt)}
            </span>
          </div>
          <div class="mt-0.5 flex items-baseline gap-2">
            <span class="rounded bg-surface px-1.5 py-0.5 text-[10px] font-medium text-text-secondary shrink-0">
              {channelLabel(draft.channel)}
            </span>
            <span class="text-[11px] text-text-muted font-mono truncate">
              {dest.label}
            </span>
            {#if isEmail && draft.subject}
              <span class="text-xs text-text-secondary truncate">— {draft.subject}</span>
            {/if}
          </div>
          {#if !expanded}
            <p class="mt-1 text-xs text-text-muted line-clamp-2">{truncate(draft.body, 200)}</p>
          {/if}
          </button>
        </div>

        {#if expanded && e}
          <div class="border-t border-border p-3 space-y-3">
            <a
              href="/prospects?q={encodeURIComponent(draft.prospectName)}"
              class="inline-flex items-center gap-1 text-xs text-accent hover:underline"
            >
              View prospect →
            </a>
            {#if !isEmail && dest.href}
              <a
                href={dest.href}
                target="_blank"
                rel="noopener noreferrer"
                class="block text-xs text-accent hover:underline font-mono break-all"
              >
                {dest.label} ↗
              </a>
            {/if}
            {#if isEmail}
              <div>
                <label class="block text-[11px] font-medium text-text-muted mb-1" for="subject-{draft.id}">
                  Subject
                </label>
                <input
                  id="subject-{draft.id}"
                  type="text"
                  bind:value={e.subject}
                  class="w-full rounded border border-border bg-page px-2 py-1.5 text-sm text-text"
                />
              </div>
            {/if}
            <div>
              <label class="block text-[11px] font-medium text-text-muted mb-1" for="body-{draft.id}">
                Body
              </label>
              <textarea
                id="body-{draft.id}"
                bind:value={e.body}
                rows="12"
                class="w-full rounded border border-border bg-page px-2 py-1.5 text-sm text-text font-mono resize-y"
              ></textarea>
            </div>
            {#if isEmail}
              {@const pv = previews[draft.id]}
              <div>
                <span class="block text-[11px] font-medium text-text-muted mb-1">
                  Signature &amp; footer — appended automatically at send (not editable)
                </span>
                {#if !pv || pv.loading}
                  <p class="text-xs text-text-muted">Loading footer…</p>
                {:else if pv.error}
                  <p class="text-xs text-danger">Couldn’t load footer preview — {pv.error}</p>
                {:else if pv.footer?.kind === 'rendered'}
                  <div
                    class="w-full rounded border border-border border-dashed bg-surface px-2 py-1.5 text-sm text-text-secondary font-mono whitespace-pre-wrap break-words"
                  >{pv.footer.text.replace(/^\n+/, '')}</div>
                {:else if pv.footer?.kind === 'unavailable'}
                  <p class="text-xs text-text-muted">
                    Footer preview unavailable — complete your
                    <a href="/workspace-settings" class="text-accent hover:underline">Workspace settings</a>,
                    or check that the recipient's country is supported.
                  </p>
                {/if}
              </div>
            {/if}
            <div class="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="button"
                disabled={!isDirty(draft) || e.saving || busyId === draft.id}
                onclick={() => handleSaveEditsButton(draft)}
                class="rounded border border-border bg-page px-3 py-1.5 text-xs text-text hover:bg-surface transition-colors disabled:opacity-40"
              >
                {e.saving ? 'Saving…' : 'Save edits'}
              </button>
              {#if !isEmail}
                <button
                  type="button"
                  onclick={() => copyBody(draft)}
                  class="rounded border border-border bg-page px-3 py-1.5 text-xs text-text hover:bg-surface transition-colors"
                >
                  {copiedId === draft.id ? 'Copied!' : 'Copy body'}
                </button>
              {/if}
              <button
                type="button"
                disabled={deliverDisabled}
                onclick={() => (confirming = { kind: dk, draft })}
                class="rounded bg-text px-3 py-1.5 text-xs font-medium text-page hover:bg-text/90 transition-colors disabled:opacity-40"
              >
                {#if busyId === draft.id}
                  {isEmail ? 'Sending…' : 'Marking…'}
                {:else if isEmail}
                  Send
                {:else}
                  Mark as sent
                {/if}
              </button>
              <button
                type="button"
                disabled={busyId === draft.id}
                onclick={() => (confirming = { kind: 'discard', draft })}
                class="ml-auto rounded px-3 py-1.5 text-xs text-danger hover:bg-surface transition-colors disabled:opacity-40"
              >
                Discard
              </button>
            </div>
            {#if isEmail && !draft.prospectEmail}
              <p class="text-xs text-danger">
                This prospect has no email address. Discard or update the prospect record.
              </p>
            {:else if !isEmail && !dest.href}
              <p class="text-xs text-danger">
                This prospect has no {channelLabel(draft.channel).toLowerCase()} destination. Discard or update the prospect record.
              </p>
            {/if}
          </div>
        {/if}
      </div>
    {/each}
  </div>
  <Pagination page={data.page} pageSize={PAGE_SIZE} total={data.total} onChange={onPageChange} />
{/if}

{#if confirming}
  {@const c = confirming}
  {@const copy = confirmCopy(c)}
  <ConfirmDialog
    title={copy.title}
    message={copy.message}
    confirmLabel={copy.label}
    danger={c.kind === 'discard' || c.kind === 'discard-batch'}
    onconfirm={() => {
      let action: Promise<void>;
      if (c.kind === 'send-batch') action = sendSelected();
      else if (c.kind === 'discard-batch') action = discardSelected();
      else if (c.kind === 'discard') action = handleDiscard(c.draft);
      else if (c.kind === 'send-email') action = sendEmailDraft(c.draft);
      else action = handleMarkSent(c.draft);
      confirming = null;
      void action;
    }}
    oncancel={() => (confirming = null)}
  />
{/if}
