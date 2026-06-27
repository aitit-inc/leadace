<script lang="ts">
  import { updateIdentityWarmup } from '$lib/api/sending-identities';
  import type { SendingIdentity, MailboxWarmupPatch } from '$lib/types/sending-identity';

  let {
    identity,
    token,
    onSaved,
  }: {
    identity: SendingIdentity;
    token: string | undefined;
    onSaved: () => void | Promise<void>;
  } = $props();

  const DAY_MS = 24 * 60 * 60 * 1000;

  type Draft = {
    capOverrideInput: string;
    pausedUntil: string | null;
  };

  // Re-seed only when the warmup values change, so an unrelated reload of this
  // page (e.g. an MCP-session revoke shares the loader) keeps unsaved edits.
  let draft = $state<Draft | null>(null);
  let seededKey = $state('');

  $effect(() => {
    const key = JSON.stringify([identity.dailyCapOverride, identity.pausedUntil]);
    if (key === seededKey) return;
    seededKey = key;
    draft = {
      capOverrideInput: identity.dailyCapOverride === null ? '' : String(identity.dailyCapOverride),
      pausedUntil: identity.pausedUntil,
    };
  });

  let saving = $state(false);
  let message = $state('');
  let errorMsg = $state('');

  function parsedCapOverride(d: Draft): number | null | 'invalid' {
    const t = d.capOverrideInput.trim();
    if (t === '') return null;
    const n = Number(t);
    if (!Number.isInteger(n) || n < 0) return 'invalid';
    return n;
  }

  function pauseForDays(days: number) {
    if (draft) draft.pausedUntil = new Date(Date.now() + days * DAY_MS).toISOString();
  }

  function resumeSending() {
    if (draft) draft.pausedUntil = null;
  }

  function changed(d: Draft): boolean {
    return (
      parsedCapOverride(d) !== identity.dailyCapOverride ||
      d.pausedUntil !== identity.pausedUntil
    );
  }

  function formatDateTime(iso: string): string {
    return new Date(iso).toLocaleString();
  }

  async function save() {
    if (!draft) return;
    const cap = parsedCapOverride(draft);
    if (cap === 'invalid') {
      errorMsg = 'Daily cap override must be a whole number ≥ 0, or blank for the default.';
      return;
    }
    errorMsg = '';
    message = '';
    saving = true;
    try {
      const patch: MailboxWarmupPatch = {};
      if (cap !== identity.dailyCapOverride) patch.dailyCapOverride = cap;
      if (draft.pausedUntil !== identity.pausedUntil) patch.pausedUntil = draft.pausedUntil;
      await updateIdentityWarmup(identity.identityId, patch, fetch, token);
      // Awaited so `saving` keeps the inputs disabled through the reload.
      await onSaved();
      message = 'Saved.';
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : 'Failed to save warmup settings.';
    } finally {
      saving = false;
    }
  }
</script>

<p class="text-sm text-text">
  Per-mailbox safe daily send cap for <span class="font-mono">{identity.fromEmail}</span>. This protects
  your sending domain's reputation — it's separate from your plan's outreach quota.
</p>

<dl class="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
  <dt class="text-text-muted">Today's email sends</dt>
  <dd class="text-text">{identity.used} / {identity.cap} ({identity.remaining} left)</dd>
  <dt class="text-text-muted">Daily cap</dt>
  <dd class="text-text">
    {#if identity.dailyCapOverride !== null}
      Fixed at {identity.dailyCapOverride}/day (warmup ramp bypassed)
    {:else if identity.warmupStartedAt}
      Warmup week {identity.rampWeek} of {identity.rampWeeks} (toward {identity.steadyStatePerDay}/day)
    {:else}
      Warmup — ramps to {identity.steadyStatePerDay}/day once you send the first email
    {/if}
  </dd>
</dl>

{#if identity.pausedUntil}
  <p class="mt-4 rounded border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
    Sending is paused until {formatDateTime(identity.pausedUntil)}.
  </p>
{/if}

{#if draft}
  <div class="mt-6 space-y-6">
    <div>
      <label for="cap-override" class="block text-sm text-text">Daily cap override</label>
      <input
        id="cap-override"
        type="text"
        inputmode="numeric"
        placeholder="Default"
        bind:value={draft.capOverrideInput}
        disabled={saving}
        class="mt-1 w-full max-w-xs rounded border border-border bg-page px-2 py-1.5 text-sm text-text disabled:opacity-50"
      />
      <p class="mt-1 text-xs text-text-muted">
        Blank follows the warmup ramp (starts low, climbs to {identity.steadyStatePerDay}/day over
        {identity.rampWeeks} weeks). Set a number to use a fixed daily cap instead — it takes effect
        immediately and bypasses the ramp. 0 stops sending until you clear it.
      </p>
    </div>

    <div>
      <span class="block text-sm text-text">Pause sending</span>
      <div class="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          onclick={() => pauseForDays(1)}
          disabled={saving}
          class="rounded border border-border bg-page px-2.5 py-1 text-xs text-text hover:bg-surface disabled:opacity-50"
        >
          Pause 1 day
        </button>
        <button
          type="button"
          onclick={() => pauseForDays(7)}
          disabled={saving}
          class="rounded border border-border bg-page px-2.5 py-1 text-xs text-text hover:bg-surface disabled:opacity-50"
        >
          Pause 7 days
        </button>
        <button
          type="button"
          onclick={() => pauseForDays(30)}
          disabled={saving}
          class="rounded border border-border bg-page px-2.5 py-1 text-xs text-text hover:bg-surface disabled:opacity-50"
        >
          Pause 30 days
        </button>
        {#if draft.pausedUntil}
          <button
            type="button"
            onclick={resumeSending}
            disabled={saving}
            class="rounded border border-border bg-page px-2.5 py-1 text-xs text-text hover:bg-surface disabled:opacity-50"
          >
            Resume sending
          </button>
        {/if}
      </div>
      {#if draft.pausedUntil !== identity.pausedUntil}
        <p class="mt-2 text-xs text-text-muted">
          {#if draft.pausedUntil}
            Will pause until {formatDateTime(draft.pausedUntil)} once saved.
          {:else}
            Will resume sending once saved.
          {/if}
        </p>
      {/if}
    </div>

    <div class="flex items-center gap-3">
      <button
        type="button"
        onclick={save}
        disabled={saving || !changed(draft)}
        class="rounded px-3 py-1.5 text-xs font-medium text-page bg-accent hover:bg-accent-strong transition-colors disabled:opacity-50"
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
      {#if message}
        <span class="text-xs text-text-muted">{message}</span>
      {/if}
      {#if errorMsg}
        <span class="text-xs text-danger">{errorMsg}</span>
      {/if}
    </div>
  </div>
{/if}
