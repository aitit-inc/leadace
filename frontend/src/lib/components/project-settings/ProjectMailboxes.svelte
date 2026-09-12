<script lang="ts">
  import { replaceProjectMailboxes } from '$lib/api/project-settings';
  import { updateIdentityWarmup } from '$lib/api/sending-identities';
  import type { SendingIdentity } from '$lib/types/sending-identity';

  type Props = {
    projectId: string;
    identities: SendingIdentity[];
    sendingIdentityIds: string[];
    token: string | undefined;
    onChanged: () => void | Promise<void>;
  };
  let { projectId, identities, sendingIdentityIds, token, onChanged }: Props = $props();

  // Priority order being edited, plus each mailbox's daily-cap input. Re-seeded
  // only when the stored values change, so an unrelated reload keeps edits.
  let pool = $state<string[]>([]);
  let capInputs = $state<Record<string, string>>({});
  let seededKey = $state('');
  $effect(() => {
    const key = JSON.stringify([projectId, sendingIdentityIds, identities.map((i) => [i.identityId, i.dailyCapOverride])]);
    if (key === seededKey) return;
    seededKey = key;
    pool = [...sendingIdentityIds];
    capInputs = Object.fromEntries(
      identities.map((i) => [i.identityId, i.dailyCapOverride === null ? '' : String(i.dailyCapOverride)]),
    );
  });

  let byId = $derived(new Map(identities.map((i) => [i.identityId, i])));
  let listed = $derived(pool.flatMap((id) => byId.get(id) ?? []));
  let available = $derived(identities.filter((i) => !pool.includes(i.identityId)));
  // What an empty list sends from (services/mailbox.ts loadProjectMailboxes).
  let signInGmail = $derived(identities.find((i) => i.signInAccount) ?? null);

  let dragIndex = $state<number | null>(null);
  let saving = $state(false);
  let message = $state('');

  function move(from: number, to: number) {
    if (to < 0 || to >= pool.length) return;
    const next = [...pool];
    next.splice(to, 0, ...next.splice(from, 1));
    pool = next;
  }

  // Mirrors the backend bound (plan-limits.ts MAX_DAILY_CAP_OVERRIDE).
  const MAX_DAILY_CAP = 100_000;

  function parsedCap(input: string): number | null | 'invalid' {
    const t = input.trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isInteger(n) && n >= 0 && n <= MAX_DAILY_CAP ? n : 'invalid';
  }

  // Only the listed mailboxes' caps are saved: an edit on a row that was then
  // removed is dropped, not applied to the other projects using that mailbox.
  function capChanges(): Array<{ identityId: string; cap: number | null }> {
    return listed.flatMap((i) => {
      const cap = parsedCap(capInputs[i.identityId] ?? '');
      return cap === 'invalid' || cap === i.dailyCapOverride ? [] : [{ identityId: i.identityId, cap }];
    });
  }

  let invalidCap = $derived(listed.some((i) => parsedCap(capInputs[i.identityId] ?? '') === 'invalid'));

  // The list and each cap are separate resources, so a failure midway leaves
  // the earlier writes in place; the reload below shows what was saved.
  async function save() {
    saving = true;
    message = '';
    try {
      await replaceProjectMailboxes(projectId, pool, fetch, token);
      for (const { identityId, cap } of capChanges()) {
        await updateIdentityWarmup(identityId, { dailyCapOverride: cap }, fetch, token);
      }
      message = 'Saved.';
    } catch (e) {
      message = `Error: ${e instanceof Error ? e.message : 'Unknown error'}`;
    }
    await onChanged();
    saving = false;
  }

  const kindLabel = (i: SendingIdentity) =>
    ({ gmail: 'Gmail', gmail_alias: 'Gmail alias', smtp: 'SMTP' })[i.kind];
  const capLabel = (i: SendingIdentity) =>
    i.dailyCapOverride !== null
      ? `fixed ${i.dailyCapOverride}/day`
      : i.rampWeek >= i.rampWeeks
        ? `steady ${i.steadyStatePerDay}/day`
        : `warmup week ${i.rampWeek} of ${i.rampWeeks}`;
</script>

<div class="space-y-3">
  <div>
    <h3 class="text-sm font-medium text-text">Sending mailboxes</h3>
    <p class="mt-1 text-xs text-text-muted">
      Each email goes out from the first mailbox below with sends left today; when its daily cap is
      reached, the next one takes over. Drag or use the arrows to set the order. A mailbox's daily
      cap is shared by every project that lists it. Mailboxes are added in
      <a href="/account-settings" class="underline hover:text-text">Account settings</a>.
    </p>
  </div>

  {#if listed.length === 0}
    <p class="text-sm text-text-secondary">
      {#if signInGmail}
        None listed — every email goes out from the sign-in Gmail,
        <span class="font-mono">{signInGmail.fromEmail}</span>. List mailboxes to send from another
        Google account, an alias or a custom mailbox, or to spread sends over several.
      {:else}
        None listed and no Gmail connected — email sending is off until you list a mailbox.
      {/if}
    </p>
  {:else}
    <ol class="max-w-3xl divide-y divide-border rounded border border-border">
      {#each listed as i, idx (i.identityId)}
        <li
          draggable="true"
          ondragstart={() => (dragIndex = idx)}
          ondragover={(e) => e.preventDefault()}
          ondrop={() => {
            if (dragIndex !== null) move(dragIndex, idx);
            dragIndex = null;
          }}
          ondragend={() => (dragIndex = null)}
          class="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2 {dragIndex === idx ? 'opacity-50' : ''}"
        >
          <span class="cursor-grab select-none text-text-muted" aria-hidden="true">⋮⋮</span>
          <span class="w-5 text-xs text-text-muted">{idx + 1}</span>
          <div class="min-w-0 flex-1">
            <p class="truncate font-mono text-sm text-text">{i.fromEmail}</p>
            <p class="mt-0.5 text-xs text-text-muted">
              {kindLabel(i)} · today {i.used}/{i.cap} sent · {capLabel(i)}
              {#if i.pausedUntil}· paused{/if}
              {#if i.heldUntil}· held after a provider refusal{/if}
            </p>
          </div>
          <label class="flex items-center gap-1.5 text-xs text-text-secondary">
            Daily cap
            <input
              type="text"
              inputmode="numeric"
              placeholder="ramp"
              aria-label="Daily cap for {i.fromEmail}"
              bind:value={capInputs[i.identityId]}
              disabled={saving}
              class="w-16 rounded border border-border bg-page px-2 py-1 text-sm text-text disabled:opacity-50"
            />
          </label>
          <div class="flex gap-1">
            <button
              type="button"
              aria-label="Move {i.fromEmail} up"
              onclick={() => move(idx, idx - 1)}
              disabled={saving || idx === 0}
              class="rounded border border-border bg-page px-2 py-1 text-xs text-text hover:bg-surface disabled:opacity-50"
            >↑</button>
            <button
              type="button"
              aria-label="Move {i.fromEmail} down"
              onclick={() => move(idx, idx + 1)}
              disabled={saving || idx === listed.length - 1}
              class="rounded border border-border bg-page px-2 py-1 text-xs text-text hover:bg-surface disabled:opacity-50"
            >↓</button>
            <button
              type="button"
              onclick={() => (pool = pool.filter((id) => id !== i.identityId))}
              disabled={saving}
              class="rounded border border-border bg-page px-2.5 py-1 text-xs text-text hover:bg-surface disabled:opacity-50"
            >Remove</button>
          </div>
        </li>
      {/each}
    </ol>
  {/if}

  {#if available.length > 0}
    <p class="text-xs font-medium text-text-secondary">Available mailboxes</p>
    <ul class="max-w-3xl space-y-1">
      {#each available as i (i.identityId)}
        <li class="flex items-center gap-3 text-sm">
          <button
            type="button"
            onclick={() => (pool = [...pool, i.identityId])}
            disabled={saving}
            class="rounded border border-border bg-page px-2.5 py-1 text-xs text-text hover:bg-surface disabled:opacity-50"
          >Add</button>
          <span class="font-mono text-text-secondary">{i.fromEmail}</span>
          <span class="text-xs text-text-muted">{kindLabel(i)} · today {i.used}/{i.cap} sent</span>
        </li>
      {/each}
    </ul>
  {/if}

  <div class="flex items-center gap-3">
    <button
      type="button"
      onclick={save}
      disabled={saving || invalidCap}
      class="rounded px-3 py-1.5 text-xs font-medium text-page bg-accent hover:bg-accent-strong transition-colors disabled:opacity-50"
    >
      {saving ? 'Saving…' : 'Save mailboxes'}
    </button>
    {#if invalidCap}
      <span class="text-xs text-text-muted">A daily cap is a whole number from 0 to 100,000; blank follows the warmup ramp.</span>
    {:else if message}
      <span class="text-xs text-text-secondary">{message}</span>
    {/if}
  </div>
</div>
