<script lang="ts">
  import { startInboxTest, updateIdentityWarmup } from '$lib/api/sending-identities';
  import Hint from '$lib/components/Hint.svelte';
  import type { SendingIdentity, MailboxWarmupPatch } from '$lib/types/sending-identity';

  let {
    identity,
    inboxTests,
    token,
    onSaved,
  }: {
    identity: SendingIdentity;
    // The server can run inbox tests (it has seed mailboxes).
    inboxTests: boolean;
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

  async function resumeAfterInboxTest() {
    errorMsg = '';
    message = '';
    saving = true;
    try {
      await updateIdentityWarmup(identity.identityId, { resumeInboxTest: true }, fetch, token);
      await onSaved();
      message = 'Sending resumed.';
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : 'Failed to resume sending.';
    } finally {
      saving = false;
    }
  }

  async function testInbox() {
    errorMsg = '';
    message = '';
    saving = true;
    try {
      await startInboxTest(identity.identityId, fetch, token);
      message = 'Test started. Reload in about 2 minutes for the result.';
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : 'Failed to start an inbox test.';
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
        Unblock it with the provider{#if identity.sendRefusal.sentThatDay > 1}, or set a daily cap below {identity
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

{#if identity.inboxTestResult}
  {@const t = identity.inboxTestResult}
  {#if identity.inboxTestHeld}
    <div
      class="space-y-1.5 rounded-xl bg-danger/10 px-3 py-2.5 text-sm text-danger {identity.sendRefusal
        ? 'mt-2'
        : ''}"
    >
      <p>
        The inbox test on {formatDateTime(t.testedAt)} put {t.spam} of {t.inbox + t.spam} copies of this
        mailbox's latest cold email in spam. Sending from it is held.
      </p>
      <div class="flex flex-wrap items-center gap-2">
        <span>
          A test that lands in the inbox lifts the hold; run one below. To send before then, change what you
          send and resume.
        </span>
        <button
          type="button"
          onclick={resumeAfterInboxTest}
          disabled={saving}
          class="btn btn-secondary btn-sm"
        >
          Resume sending
        </button>
      </div>
    </div>
  {:else}
    <p class="text-xs text-text-muted {identity.sendRefusal ? 'mt-2' : ''}">
      Inbox test on {formatDateTime(t.testedAt)}: {t.inbox} of {t.inbox + t.spam + t.missing} copies in the
      inbox{#if t.spam > 0}, {t.spam} in spam{/if}{#if t.missing > 0}, {t.missing} not arrived{/if}.
    </p>
  {/if}
{/if}

{#if inboxTests}
  <div
    class="flex flex-wrap items-center gap-2 text-xs text-text-muted {identity.sendRefusal || identity.inboxTestResult
      ? 'mt-2'
      : ''}"
  >
    <span>
      Once a day while this mailbox sends, its latest cold email goes to LeadAce's own test inboxes to see where it
      lands. The copies show in your Sent folder and don't count toward the daily cap.
    </span>
    <button type="button" onclick={testInbox} disabled={saving} class="btn btn-secondary btn-sm">Test now</button>
  </div>
{/if}

{#if draft}
  <div class="space-y-4 {identity.sendRefusal || identity.inboxTestResult || inboxTests ? 'mt-4' : ''}">
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
