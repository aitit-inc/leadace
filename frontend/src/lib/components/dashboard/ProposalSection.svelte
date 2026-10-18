<script lang="ts">
  import { ArrowRight, Check, MessagesSquare, X } from '@lucide/svelte';
  import { applyProposal, stopProposal } from '$lib/api/proposals';
  import { reachDiff, reachRows } from '$lib/format';
  import type { Proposal } from '$lib/types/proposals';

  let {
    proposal,
    token,
    onAsk,
    onChanged,
  }: {
    proposal: Proposal;
    token: string | undefined;
    onAsk: (instruction: string) => void;
    onChanged: () => void | Promise<void>;
  } = $props();

  let busy = $state(false);
  let error = $state('');
  let instructing = $state(false);
  let note = $state('');

  let change = $derived(proposal.change);
  let rows = $derived(change.kind === 'loosen' ? reachRows(change) : change.kind === 'frame' ? reachRows(reachDiff(change.reachFrom, change.reach)) : []);

  function fmtApplyDay(day: string): string {
    return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  }

  async function act(run: () => Promise<unknown>) {
    busy = true;
    error = '';
    try {
      await run();
      await onChanged();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Something went wrong. Try again.';
    } finally {
      busy = false;
    }
  }

  async function sendInstead() {
    const text = note.trim();
    if (!text) return;
    await act(async () => {
      await stopProposal(proposal.id, fetch, token);
      const what = rows.length > 0 ? ` (${rows.map((r) => `${r.label}: ${r.from} → ${r.to}`).join('; ')})` : '';
      onAsk(`I stopped your proposal "${proposal.title}"${what}. Instead: ${text}`);
    });
  }
</script>

<section class="card">
  <div class="flex flex-wrap items-center gap-2 px-5 pb-2 pt-4">
    {#if change.kind === 'loosen'}
      <h2 class="font-display text-lg font-semibold text-text">Proposed change</h2>
      <span class="chip bg-accent/10 text-accent">Applies {fmtApplyDay(change.applyOn)}</span>
      <span class="ml-auto hidden text-sm text-text-muted sm:inline">Ace makes it unless you stop it</span>
    {:else if change.kind === 'frame'}
      <h2 class="font-display text-lg font-semibold text-text">Proposed new frame</h2>
      <span class="chip bg-accent/10 text-accent">Applies {fmtApplyDay(change.applyOn)}</span>
      <span class="ml-auto hidden text-sm text-text-muted sm:inline">Ace starts it unless you stop it; measuring restarts</span>
    {:else}
      <h2 class="font-display text-lg font-semibold text-text">Proposed means</h2>
      <span class="chip bg-surface-2 text-text-secondary">Needs your setup</span>
      <span class="ml-auto hidden text-sm text-text-muted sm:inline">Ace sets it up with you</span>
    {/if}
  </div>
  <div class="flex flex-col gap-3 px-5 pb-5 pt-1">
    <div>
      <h3 class="text-sm font-semibold text-text">{proposal.title}</h3>
      <p class="mt-1 whitespace-pre-line text-sm text-text-secondary">{proposal.body}</p>
    </div>
    {#if rows.length > 0 || change.kind === 'frame'}
      <dl class="flex flex-col gap-1.5 rounded-xl bg-surface-2 px-3 py-2 text-sm">
        {#each rows as r (r.label)}
          <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <dt class="w-20 shrink-0 text-text-muted">{r.label}</dt>
            <dd class="flex min-w-0 flex-wrap items-center gap-1.5 text-text">
              <span class="text-text-secondary">{r.from}</span>
              <ArrowRight size={14} class="text-text-muted" />
              <span class="font-semibold">{r.to}</span>
            </dd>
          </div>
        {/each}
        {#if change.kind === 'frame'}
          <div class="flex flex-wrap gap-x-2 gap-y-0.5">
            <dt class="w-20 shrink-0 text-text-muted">Angles</dt>
            <dd class="min-w-0 flex-1 text-text">{change.variants.map((v) => v.label).join(' · ')}</dd>
          </div>
          <div class="flex flex-wrap gap-x-2 gap-y-0.5">
            <dt class="w-20 shrink-0 text-text-muted">Searches</dt>
            <dd class="min-w-0 flex-1 text-text">{change.strategies.map((st) => st.slug).join(' · ')}</dd>
          </div>
        {/if}
      </dl>
    {/if}
    {#if change.kind === 'frame'}
      <details class="text-sm">
        <summary class="cursor-pointer text-text-secondary">The new sales strategy</summary>
        <p class="mt-2 max-h-80 overflow-y-auto whitespace-pre-line rounded-xl bg-surface-2 px-3 py-2 text-text-secondary">{change.salesStrategy}</p>
      </details>
    {/if}
    {#if error}
      <p class="text-sm text-danger">{error}</p>
    {/if}
    {#if instructing}
      <div class="flex flex-col gap-2">
        <label for="proposal-instead-{proposal.id}" class="text-sm text-text-secondary">
          This proposal stops, and your message goes to Ace in the chat.
        </label>
        <textarea
          id="proposal-instead-{proposal.id}"
          rows={3}
          maxlength="2000"
          bind:value={note}
          disabled={busy}
          placeholder="Tell Ace what to do instead"
          class="field resize-none"
        ></textarea>
        <div class="flex justify-end gap-2">
          <button type="button" onclick={() => (instructing = false)} disabled={busy} class="btn btn-ghost btn-sm">Cancel</button>
          <button type="button" onclick={sendInstead} disabled={busy || !note.trim()} class="btn btn-primary btn-sm">
            <MessagesSquare size={14} /> Send to Ace
          </button>
        </div>
      </div>
    {:else}
      <div class="flex flex-wrap justify-end gap-2">
        <button type="button" onclick={() => act(() => stopProposal(proposal.id, fetch, token))} disabled={busy} class="btn btn-ghost btn-sm">
          <X size={14} /> Stop
        </button>
        <button type="button" onclick={() => (instructing = true)} disabled={busy} class="btn btn-secondary btn-sm">
          <MessagesSquare size={14} /> Something else
        </button>
        {#if change.kind !== 'add-means'}
          <button type="button" onclick={() => act(() => applyProposal(proposal.id, fetch, token))} disabled={busy} class="btn btn-primary btn-sm">
            <Check size={14} /> Apply now
          </button>
        {:else}
          {@const instruction = change.instruction}
          <button type="button" onclick={() => onAsk(instruction)} disabled={busy} class="btn btn-primary btn-sm">
            <MessagesSquare size={14} /> Set it up with Ace
          </button>
        {/if}
      </div>
    {/if}
  </div>
</section>
