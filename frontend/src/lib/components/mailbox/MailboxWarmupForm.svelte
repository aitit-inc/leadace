<script lang="ts">
  import { updateIdentityWarmup } from '$lib/api/sending-identities';
  import Hint from '$lib/components/Hint.svelte';
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

  // SMTP replies can carry HTML (some providers link the unblock page); show their text.
  function replyText(detail: string): string {
    return detail.replace(/<[^>]*>/g, '');
  }

  async function markRefusalResolved() {
    errorMsg = '';
    message = '';
    saving = true;
    try {
      await updateIdentityWarmup(identity.identityId, { resolveRefusal: true }, fetch, token);
      await onSaved();
      message = 'Marked resolved.';
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : 'Failed to mark it resolved.';
    } finally {
      saving = false;
    }
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

{#if identity.sendRefusal}
  <div class="space-y-1.5 rounded-xl bg-danger/10 px-3 py-2.5 text-sm text-danger">
    <p>
      Refused by the mail provider on {formatDateTime(identity.sendRefusal.lastAt)}.{#if identity.heldUntil}{' '}Sending
        held until {formatDateTime(identity.heldUntil)}.{/if}
    </p>
    <p class="line-clamp-2 break-words font-mono text-xs" title={identity.sendRefusal.detail}>
      {replyText(identity.sendRefusal.detail)}
    </p>
    <div class="flex flex-wrap items-center gap-2">
      <span>
        Unblock it with the provider{#if identity.sendRefusal.sentThatDay > 0}, or set a daily cap below {identity
            .sendRefusal.sentThatDay}{/if}.
      </span>
      <button
        type="button"
        onclick={markRefusalResolved}
        disabled={saving}
        class="btn btn-secondary btn-sm"
      >
        Mark resolved
      </button>
    </div>
  </div>
{/if}

{#if draft}
  <div class="space-y-4 {identity.sendRefusal ? 'mt-4' : ''}">
    <div>
      <label for="cap-override-{identity.identityId}" class="flex items-center gap-1.5 text-sm font-medium text-text">
        Daily cap override
        <Hint label="About the daily cap override">
          Blank follows the warmup ramp. A number sets a fixed daily cap right away and skips the
          ramp. 0 stops sending until you clear it.
        </Hint>
      </label>
      <div class="mt-1.5 flex items-center gap-2">
        <input
          id="cap-override-{identity.identityId}"
          type="text"
          inputmode="numeric"
          placeholder="Default"
          bind:value={draft.capOverrideInput}
          disabled={saving}
          class="field w-28 tabular-nums"
        />
        <span class="text-sm text-text-muted">/ day</span>
      </div>
    </div>

    <div>
      <span class="block text-sm font-medium text-text">Pause sending</span>
      <div class="mt-1.5 flex flex-wrap gap-2">
        {#each [1, 7, 30] as days (days)}
          <button
            type="button"
            onclick={() => pauseForDays(days)}
            disabled={saving}
            class="btn btn-secondary btn-sm"
          >
            {days} {days === 1 ? 'day' : 'days'}
          </button>
        {/each}
        {#if draft.pausedUntil}
          <button
            type="button"
            onclick={resumeSending}
            disabled={saving}
            class="btn btn-secondary btn-sm"
          >
            Resume
          </button>
        {/if}
      </div>
      {#if draft.pausedUntil !== identity.pausedUntil}
        <p class="mt-1.5 text-xs text-text-muted">
          {#if draft.pausedUntil}
            Pauses until {formatDateTime(draft.pausedUntil)} once saved.
          {:else}
            Resumes once saved.
          {/if}
        </p>
      {/if}
    </div>

    <div class="flex items-center gap-3">
      <button
        type="button"
        onclick={save}
        disabled={saving || !changed(draft)}
        class="btn btn-primary btn-sm"
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
      {#if message}
        <span class="text-sm text-text-muted">{message}</span>
      {/if}
      {#if errorMsg}
        <span class="text-sm text-danger">{errorMsg}</span>
      {/if}
    </div>
  </div>
{/if}
