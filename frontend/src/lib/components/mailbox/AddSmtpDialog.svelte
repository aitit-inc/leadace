<script lang="ts">
  import { registerSmtpIdentity } from '$lib/api/sending-identities';
  import Hint from '$lib/components/Hint.svelte';
  import Modal from '$lib/components/Modal.svelte';
  import type { RegisterSmtpIdentityInput } from '$lib/types/sending-identity';

  let {
    token,
    onAdded,
    onclose,
  }: {
    token: string | undefined;
    onAdded: () => void | Promise<void>;
    onclose: () => void;
  } = $props();

  let fromEmail = $state('');
  let smtpHost = $state('');
  let smtpPort = $state('465');
  let imapHost = $state('');
  let imapPort = $state('993');
  let username = $state('');
  let appPassword = $state('');
  let saving = $state(false);
  let error = $state('');

  function parsePort(s: string): number | null {
    const n = Number(s.trim());
    if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
    return n;
  }

  async function submit(e: Event) {
    e.preventDefault();
    const smtp = parsePort(smtpPort);
    const imap = parsePort(imapPort);
    if (!fromEmail.trim() || !smtpHost.trim() || !imapHost.trim() || !username.trim() || !appPassword) {
      error = 'Fill in every field.';
      return;
    }
    if (smtp === null || imap === null) {
      error = 'Ports must be whole numbers between 1 and 65535.';
      return;
    }
    error = '';
    saving = true;
    try {
      const input: RegisterSmtpIdentityInput = {
        fromEmail: fromEmail.trim(),
        smtpHost: smtpHost.trim(),
        smtpPort: smtp,
        imapHost: imapHost.trim(),
        imapPort: imap,
        username: username.trim(),
        appPassword,
      };
      await registerSmtpIdentity(input, fetch, token);
      await onAdded();
      onclose();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to add the mailbox.';
      saving = false;
    }
  }

  const input =
    'mt-1 rounded border border-border bg-page px-2 py-1.5 text-sm text-text disabled:opacity-50';
  const label = 'flex items-center gap-1.5 text-xs text-text-secondary';
</script>

<Modal labelledBy="add-smtp-title" closable={!saving} {onclose}>
  <form onsubmit={submit}>
    <h3 id="add-smtp-title" class="text-sm font-semibold text-text">Add an SMTP mailbox</h3>
    <p class="mt-1 text-xs text-text-secondary">
      For a provider other than Google. Both connections are checked when you add it. For a Google
      account, use "Connect a Google account" instead.
    </p>

    <div class="mt-4 space-y-4">
      <div>
        <label for="smtp-from" class={label}>From address</label>
        <!-- svelte-ignore a11y_autofocus -->
        <input
          id="smtp-from"
          type="email"
          autofocus
          placeholder="sales@yourdomain.com"
          bind:value={fromEmail}
          disabled={saving}
          class="{input} w-full font-mono"
        />
      </div>

      <div>
        <label for="smtp-host" class={label}>
          SMTP server
          <Hint label="SMTP port">Only port 465 (implicit TLS) is supported.</Hint>
        </label>
        <div class="flex gap-2">
          <input
            id="smtp-host"
            type="text"
            placeholder="smtp.example.com"
            bind:value={smtpHost}
            disabled={saving}
            class="{input} min-w-0 flex-1 font-mono"
          />
          <input
            aria-label="SMTP port"
            type="text"
            inputmode="numeric"
            bind:value={smtpPort}
            disabled={saving}
            class="{input} w-20 shrink-0"
          />
        </div>
      </div>

      <div>
        <label for="imap-host" class={label}>
          IMAP server
          <Hint label="What IMAP is for">Used to read replies. Sending uses SMTP only.</Hint>
        </label>
        <div class="flex gap-2">
          <input
            id="imap-host"
            type="text"
            placeholder="imap.example.com"
            bind:value={imapHost}
            disabled={saving}
            class="{input} min-w-0 flex-1 font-mono"
          />
          <input
            aria-label="IMAP port"
            type="text"
            inputmode="numeric"
            bind:value={imapPort}
            disabled={saving}
            class="{input} w-20 shrink-0"
          />
        </div>
      </div>

      <div>
        <label for="smtp-username" class={label}>Username</label>
        <input
          id="smtp-username"
          type="text"
          placeholder="Usually the full email address"
          bind:value={username}
          disabled={saving}
          class="{input} w-full font-mono"
        />
      </div>

      <div>
        <label for="smtp-password" class={label}>
          App password
          <Hint label="About the app password">
            A provider-issued app password, not your login password. Stored encrypted and never
            shown again.
          </Hint>
        </label>
        <input
          id="smtp-password"
          type="password"
          autocomplete="off"
          bind:value={appPassword}
          disabled={saving}
          class="{input} w-full font-mono"
        />
      </div>
    </div>

    {#if error}
      <p class="mt-3 text-xs text-danger">{error}</p>
    {/if}

    <div class="mt-6 flex justify-end gap-3">
      <button
        type="button"
        onclick={onclose}
        disabled={saving}
        class="text-xs text-text-muted hover:text-text disabled:opacity-50"
      >
        Cancel
      </button>
      <button
        type="submit"
        disabled={saving}
        class="rounded bg-accent px-3 py-1.5 text-xs font-medium text-page hover:bg-accent-strong disabled:opacity-50"
      >
        {saving ? 'Checking…' : 'Add mailbox'}
      </button>
    </div>
  </form>
</Modal>
