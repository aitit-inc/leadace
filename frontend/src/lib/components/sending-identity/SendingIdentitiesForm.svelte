<script lang="ts">
  import { registerSmtpIdentity, deleteSendingIdentity } from '$lib/api/sending-identities';
  import type { SendingIdentity, RegisterSmtpIdentityInput } from '$lib/types/sending-identity';
  import type { PlanTier } from '$lib/types/plan';

  let {
    identities,
    planTier,
    token,
    onChanged,
  }: {
    identities: SendingIdentity[];
    planTier: PlanTier | undefined;
    token: string | undefined;
    onChanged: () => void | Promise<void>;
  } = $props();

  // The connected Gmail lives in the section above; paid-plan caps are enforced server-side.
  let smtpIdentities = $derived(identities.filter((i) => i.provider === 'smtp_imap'));
  let freeBlocked = $derived(planTier === 'free');

  type Draft = {
    fromEmail: string;
    smtpHost: string;
    smtpPort: string;
    imapHost: string;
    imapPort: string;
    username: string;
    appPassword: string;
  };
  const EMPTY: Draft = {
    fromEmail: '',
    smtpHost: '',
    smtpPort: '465',
    imapHost: '',
    imapPort: '993',
    username: '',
    appPassword: '',
  };
  let draft = $state<Draft>({ ...EMPTY });

  let saving = $state(false);
  let addMessage = $state('');
  let addError = $state('');

  let deletingId = $state<string | null>(null);
  let listError = $state('');

  function parsePort(s: string): number | null {
    const n = Number(s.trim());
    if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
    return n;
  }

  async function add() {
    const smtpPort = parsePort(draft.smtpPort);
    const imapPort = parsePort(draft.imapPort);
    if (
      !draft.fromEmail.trim() ||
      !draft.smtpHost.trim() ||
      !draft.imapHost.trim() ||
      !draft.username.trim() ||
      !draft.appPassword
    ) {
      addError = 'Fill in every field.';
      return;
    }
    if (smtpPort === null || imapPort === null) {
      addError = 'Ports must be whole numbers between 1 and 65535.';
      return;
    }
    addError = '';
    addMessage = '';
    saving = true;
    try {
      const input: RegisterSmtpIdentityInput = {
        fromEmail: draft.fromEmail.trim(),
        smtpHost: draft.smtpHost.trim(),
        smtpPort,
        imapHost: draft.imapHost.trim(),
        imapPort,
        username: draft.username.trim(),
        appPassword: draft.appPassword,
      };
      await registerSmtpIdentity(input, fetch, token);
      draft = { ...EMPTY };
      // Awaited so `saving` keeps the inputs disabled through the reload.
      await onChanged();
      addMessage = 'Mailbox added.';
    } catch (e) {
      addError = e instanceof Error ? e.message : 'Failed to add mailbox.';
    } finally {
      saving = false;
    }
  }

  async function remove(identityId: string, fromEmail: string) {
    deletingId = identityId;
    listError = '';
    try {
      await deleteSendingIdentity(identityId, fetch, token);
      await onChanged();
    } catch (e) {
      listError = e instanceof Error ? e.message : `Failed to remove ${fromEmail}.`;
    } finally {
      deletingId = null;
    }
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString();
  }
</script>

<p class="text-sm text-text">
  Send cold outreach from a dedicated SMTP mailbox (e.g. a low-cost Zoho mailbox on a separate
  domain) instead of your primary Gmail — this keeps your main domain's sending reputation clean.
  LeadAce sends from this mailbox server-side; assign one to a project in its Project settings. The
  mailbox is verified when you add it.
</p>

{#if smtpIdentities.length > 0}
  <ul class="mt-4 -my-1 divide-y divide-border">
    {#each smtpIdentities as id (id.identityId)}
      <li class="flex items-center justify-between gap-4 py-3">
        <div class="min-w-0">
          <p class="truncate font-mono text-sm text-text">{id.fromEmail}</p>
          <p class="mt-0.5 text-xs text-text-muted">
            {#if id.smtp}
              {id.smtp.smtpHost}:{id.smtp.smtpPort} · {id.smtp.username} · added {formatDate(
                id.grantedAt,
              )}
            {:else}
              SMTP · added {formatDate(id.grantedAt)}
            {/if}
          </p>
        </div>
        <button
          type="button"
          onclick={() => remove(id.identityId, id.fromEmail)}
          disabled={deletingId !== null}
          class="shrink-0 rounded border border-border bg-page px-2 py-1 text-xs text-text hover:bg-surface disabled:opacity-50"
        >
          {deletingId === id.identityId ? 'Removing…' : 'Remove'}
        </button>
      </li>
    {/each}
  </ul>
  {#if listError}
    <p class="mt-2 text-xs text-danger">{listError}</p>
  {/if}
{/if}

{#if freeBlocked}
  <p class="mt-4 rounded border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
    Custom SMTP mailboxes require a paid plan. Upgrade to Starter or higher to add one.
  </p>
{:else}
  <div class="mt-6 space-y-4">
    <p class="text-xs font-medium text-text-secondary">Add an SMTP mailbox</p>

    <div>
      <label for="si-from" class="block text-sm text-text">From address</label>
      <input
        id="si-from"
        type="email"
        placeholder="sales@yourdomain.com"
        bind:value={draft.fromEmail}
        disabled={saving}
        class="mt-1 w-full max-w-sm rounded border border-border bg-page px-2 py-1.5 font-mono text-sm text-text disabled:opacity-50"
      />
    </div>

    <div>
      <span class="block text-sm text-text">SMTP server (sending)</span>
      <div class="mt-1 flex max-w-sm gap-2">
        <input
          aria-label="SMTP host"
          type="text"
          placeholder="smtp.zoho.com"
          bind:value={draft.smtpHost}
          disabled={saving}
          class="w-full rounded border border-border bg-page px-2 py-1.5 font-mono text-sm text-text disabled:opacity-50"
        />
        <input
          aria-label="SMTP port"
          type="text"
          inputmode="numeric"
          placeholder="465"
          bind:value={draft.smtpPort}
          disabled={saving}
          class="w-20 rounded border border-border bg-page px-2 py-1.5 text-sm text-text disabled:opacity-50"
        />
      </div>
      <p class="mt-1 text-xs text-text-muted">Use port 465 (implicit TLS) — the only port supported.</p>
    </div>

    <div>
      <span class="block text-sm text-text">IMAP server (receiving)</span>
      <div class="mt-1 flex max-w-sm gap-2">
        <input
          aria-label="IMAP host"
          type="text"
          placeholder="imap.zoho.com"
          bind:value={draft.imapHost}
          disabled={saving}
          class="w-full rounded border border-border bg-page px-2 py-1.5 font-mono text-sm text-text disabled:opacity-50"
        />
        <input
          aria-label="IMAP port"
          type="text"
          inputmode="numeric"
          placeholder="993"
          bind:value={draft.imapPort}
          disabled={saving}
          class="w-20 rounded border border-border bg-page px-2 py-1.5 text-sm text-text disabled:opacity-50"
        />
      </div>
      <p class="mt-1 text-xs text-text-muted">Stored for future reply collection; sending uses SMTP only.</p>
    </div>

    <div>
      <label for="si-username" class="block text-sm text-text">Username</label>
      <input
        id="si-username"
        type="text"
        placeholder="usually your full email address"
        bind:value={draft.username}
        disabled={saving}
        class="mt-1 w-full max-w-sm rounded border border-border bg-page px-2 py-1.5 font-mono text-sm text-text disabled:opacity-50"
      />
    </div>

    <div>
      <label for="si-password" class="block text-sm text-text">App password</label>
      <input
        id="si-password"
        type="password"
        autocomplete="off"
        bind:value={draft.appPassword}
        disabled={saving}
        class="mt-1 w-full max-w-sm rounded border border-border bg-page px-2 py-1.5 font-mono text-sm text-text disabled:opacity-50"
      />
      <p class="mt-1 text-xs text-text-muted">
        Use a provider-issued app password, not your account login password. Stored encrypted and
        never shown again.
      </p>
    </div>

    <div class="flex items-center gap-3">
      <button
        type="button"
        onclick={add}
        disabled={saving}
        class="rounded bg-accent px-3 py-1.5 text-xs font-medium text-page transition-colors hover:bg-accent-strong disabled:opacity-50"
      >
        {saving ? 'Adding…' : 'Add mailbox'}
      </button>
      {#if addMessage}
        <span class="text-xs text-text-muted">{addMessage}</span>
      {/if}
      {#if addError}
        <span class="text-xs text-danger">{addError}</span>
      {/if}
    </div>
  </div>
{/if}
