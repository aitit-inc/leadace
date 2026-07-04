<script lang="ts">
  import { goto, invalidate } from '$app/navigation';
  import { updateProjectSettings } from '$lib/api/project-settings';
  import { deleteProject } from '$lib/api/projects';
  import { setActiveProject } from '$lib/active-project';
  import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
  import {
    ALLOWED_SEND_COUNTRIES,
    OUTBOUND_CHANNELS,
    type AllowedSendCountry,
    type FollowUpSequence,
    type OutboundChannel,
  } from '$lib/types/project-settings';
  import type { PageProps } from './$types';
  import type { ProjectSettingsData } from './types';
  import type { SendingIdentity } from '$lib/types/sending-identity';

  const CHANNEL_LABELS: Record<OutboundChannel, string> = {
    email: 'Email',
    form: 'Contact form',
    sns_twitter: 'X (Twitter) DM',
    sns_linkedin: 'LinkedIn DM',
  };
  const CHANNEL_HINTS: Record<OutboundChannel, string> = {
    email: 'Most stable. Default channel.',
    form: 'Browser-driven submission via claude-in-chrome. Less stable.',
    sns_twitter: 'Browser-driven DM via claude-in-chrome. Less stable; rate-limited.',
    sns_linkedin: 'Browser-driven DM via claude-in-chrome. Less stable; rate-limited.',
  };
  const COUNTRY_LABELS: Record<AllowedSendCountry, string> = {
    US: 'United States',
    CA: 'Canada',
    JP: 'Japan',
  };

  let { data }: PageProps = $props();
  let token = $derived(data.session?.access_token);
  let activeProjectId = $derived(data.activeProjectId);

  // Only custom SMTP mailboxes are selectable (default null = the connected Gmail);
  // with none, the selector stays hidden.
  let smtpIdentities = $derived(
    data.sendingIdentities.filter((i: SendingIdentity) => i.provider === 'smtp_imap'),
  );
  let sendingIdentitiesError = $derived(data.sendingIdentitiesError);

  let projectSettings = $state<ProjectSettingsData | null>(null);
  // Sent back only when actually edited — an unrelated save must not materialize
  // the resolved defaults into the overrides-only follow_up_sequence cell.
  let followUpLoaded = $state<FollowUpSequence | null>(null);

  // When sending from a custom SMTP mailbox, the Gmail Send-As alias doesn't apply.
  // A non-null sendingIdentityId is always a custom SMTP mailbox (the selector only
  // sets smtp ids; null = default Gmail). Kept independent of the identities list so
  // a failed list load can't wrongly re-enable the Gmail alias control.
  let usingSmtpMailbox = $derived(!!projectSettings?.sendingIdentityId);

  function onSendingMailboxChange() {
    if (!projectSettings) return;
    if (projectSettings.sendingIdentityId) projectSettings.senderEmailAlias = null;
  }
  $effect(() => {
    const loaded = data.projectSettings;
    if (!loaded) {
      projectSettings = null;
      followUpLoaded = null;
      return;
    }
    projectSettings = {
      ...loaded,
      followUpSequence: {
        ...loaded.followUpSequence,
        gapDays: [...loaded.followUpSequence.gapDays],
      },
    };
    followUpLoaded = {
      ...loaded.followUpSequence,
      gapDays: [...loaded.followUpSequence.gapDays],
    };
  });

  let savingSettings = $state(false);
  let settingsMessage = $state('');
  let message = $state('');

  let showDeleteDialog = $state(false);
  let deleting = $state(false);

  // Look up the active project's name from the layout-loaded projects list
  // instead of refetching /projects here.
  let projectName = $derived.by(() => {
    if (!data.projectId) return null;
    const proj = data.projects.find((p) => p.id === data.projectId);
    return proj?.name ?? data.projectId;
  });

  async function saveProjectSettings() {
    if (!projectSettings || !data.projectId) return;
    savingSettings = true;
    settingsMessage = '';
    try {
      const body = {
        outboundMode: projectSettings.outboundMode,
        sendingIdentityId: projectSettings.sendingIdentityId,
        senderEmailAlias: projectSettings.senderEmailAlias?.trim() || null,
        senderDisplayName: projectSettings.senderDisplayName?.trim() || null,
        unsubscribeEnabled: projectSettings.unsubscribeEnabled,
        ...(followUpChanged() ? { followUpSequence: projectSettings.followUpSequence } : {}),
        outboundChannels: projectSettings.outboundChannels,
        targetCountries: projectSettings.targetCountries,
      };
      await updateProjectSettings<ProjectSettingsData>(
        data.projectId,
        body,
        fetch,
        token,
      );
      await invalidate('app:project-settings');
      settingsMessage = 'Saved.';
    } catch (e) {
      settingsMessage = `Error: ${e instanceof Error ? e.message : 'Unknown error'}`;
    }
    savingSettings = false;
  }

  function toggleChannel(ch: OutboundChannel, checked: boolean) {
    if (!projectSettings) return;
    const set = new Set(projectSettings.outboundChannels);
    if (checked) set.add(ch);
    else set.delete(ch);
    projectSettings.outboundChannels = OUTBOUND_CHANNELS.filter((c) => set.has(c));
  }

  function toggleCountry(code: AllowedSendCountry, checked: boolean) {
    if (!projectSettings) return;
    const set = new Set(projectSettings.targetCountries);
    if (checked) set.add(code);
    else set.delete(code);
    projectSettings.targetCountries = ALLOWED_SEND_COUNTRIES.filter((c) => set.has(c));
  }

  const MAX_FOLLOWUP_GAPS = 5;

  function addFollowupTouch() {
    if (!projectSettings) return;
    const g = projectSettings.followUpSequence.gapDays;
    if (g.length >= MAX_FOLLOWUP_GAPS) return;
    projectSettings.followUpSequence.gapDays = [...g, 7];
  }

  function removeFollowupTouch(i: number) {
    if (!projectSettings) return;
    const g = projectSettings.followUpSequence.gapDays;
    if (g.length <= 1) return;
    projectSettings.followUpSequence.gapDays = g.filter((_, idx) => idx !== i);
  }

  let followupSendDays = $derived.by(() => {
    const days = [0];
    let acc = 0;
    for (const gap of projectSettings?.followUpSequence.gapDays ?? []) {
      acc += Number(gap) || 0;
      days.push(acc);
    }
    return days;
  });

  function followUpChanged(): boolean {
    if (!projectSettings || !followUpLoaded) return false;
    const cur = projectSettings.followUpSequence;
    const base = followUpLoaded;
    return (
      cur.enabled !== base.enabled ||
      cur.gapDays.length !== base.gapDays.length ||
      cur.gapDays.some((d, i) => d !== base.gapDays[i])
    );
  }

  async function handleDelete() {
    const pid = activeProjectId;
    if (!pid) return;
    deleting = true;
    try {
      await deleteProject(pid, fetch, token);
      message = `Project "${projectName ?? pid}" deleted.`;
      await setActiveProject(null);
      // Refresh layout's projects list (the deleted one must drop out before
      // the switcher rerenders) and the plan info (project-count quotas may
      // shift), then SPA-navigate to /prospects so the next-active-project
      // reconciliation runs in the layout load.
      await Promise.all([invalidate('app:projects'), invalidate('app:plan')]);
      await goto('/prospects');
    } catch (e) {
      message = `Error: ${e instanceof Error ? e.message : 'Unknown error'}`;
    }
    deleting = false;
    showDeleteDialog = false;
  }
</script>

<svelte:head>
  <title>Project settings · LeadAce</title>
</svelte:head>

<h2 class="text-lg font-semibold text-text mb-6">
  Project settings
  {#if projectName}
    <span class="ml-2 text-sm font-normal text-text-secondary">— {projectName}</span>
  {/if}
</h2>

{#if message}
  <div class="mb-6 rounded bg-surface px-4 py-3 text-sm text-text">{message}</div>
{/if}

<section class="mb-10">
  <h3 class="text-xs font-medium text-text-muted uppercase tracking-wider mb-4">Outbound</h3>

  {#if projectSettings}
    {@const s = projectSettings}
    <div class="rounded-md border border-border p-5 space-y-5">
      <div>
        <label for="outbound-mode" class="block text-xs font-medium text-text-secondary mb-1">
          Outbound mode
        </label>
        <select
          id="outbound-mode"
          bind:value={s.outboundMode}
          class="w-full max-w-xs rounded border border-border bg-page px-2 py-1.5 text-sm text-text"
        >
          <option value="send">Send immediately</option>
          <option value="draft">Create drafts only</option>
        </select>
        <p class="mt-1 text-xs text-text-muted">
          In draft mode, <span class="font-mono">/outbound</span> stores composed messages here as
          drafts (status <span class="font-mono">pending_review</span>) instead of sending. Review
          and send each one from the
          <a href="/drafts" class="underline hover:text-text">Drafts</a> page; sending counts toward
          your monthly outreach quota.
        </p>
      </div>

      {#if smtpIdentities.length > 0}
        <div>
          <label for="sending-identity" class="block text-xs font-medium text-text-secondary mb-1">
            Sending mailbox
          </label>
          <select
            id="sending-identity"
            bind:value={s.sendingIdentityId}
            onchange={onSendingMailboxChange}
            class="w-full max-w-xs rounded border border-border bg-page px-2 py-1.5 text-sm text-text"
          >
            <option value={null}>Default — connected Gmail</option>
            {#each smtpIdentities as id (id.identityId)}
              <option value={id.identityId}>{id.fromEmail}</option>
            {/each}
          </select>
          <p class="mt-1 text-xs text-text-muted">
            Which mailbox this project sends from. Custom SMTP mailboxes are added in
            <a href="/account-settings" class="underline hover:text-text">Account settings</a> and
            send server-side, just like Gmail.
          </p>
        </div>
      {:else if sendingIdentitiesError}
        <div>
          <label for="sending-identity" class="block text-xs font-medium text-text-secondary mb-1">
            Sending mailbox
          </label>
          {#if s.sendingIdentityId}
            <!-- The list failed to load but this project uses a custom mailbox; offer
                 a reset to default so a transient error doesn't strand the user on it. -->
            <select
              id="sending-identity"
              bind:value={s.sendingIdentityId}
              onchange={onSendingMailboxChange}
              class="w-full max-w-xs rounded border border-border bg-page px-2 py-1.5 text-sm text-text"
            >
              <option value={null}>Default — connected Gmail</option>
              <option value={s.sendingIdentityId}>Current custom mailbox</option>
            </select>
          {/if}
          <p class="mt-1 text-xs text-text-muted">
            Couldn't load your custom mailboxes. Reload to {s.sendingIdentityId
              ? 'switch between mailboxes'
              : 'select one'}.
          </p>
        </div>
      {/if}

      <div>
        <label for="sender-alias" class="block text-xs font-medium text-text-secondary mb-1">
          Sender email alias
        </label>
        <input
          id="sender-alias"
          type="email"
          placeholder="primary Gmail (default)"
          bind:value={s.senderEmailAlias}
          disabled={usingSmtpMailbox}
          class="w-full max-w-xs rounded border border-border bg-page px-2 py-1.5 text-sm text-text font-mono disabled:opacity-50"
        />
        <p class="mt-1 text-xs text-text-muted">
          {#if usingSmtpMailbox}
            Not used while a custom SMTP mailbox is selected — that mailbox's own address is the
            From:.
          {:else}
            A Gmail Send-As alias (e.g. <span class="font-mono">sales@yourdomain.com</span>) to use
            as the From: address. The alias must already be set up and verified in
            <a
              href="https://mail.google.com/mail/u/0/#settings/accounts"
              target="_blank"
              rel="noopener"
              class="underline hover:text-text"
            >Gmail → Settings → Accounts and Import</a>. If it isn't verified there, sending will
            fail with a Gmail error.
          {/if}
        </p>
      </div>

      <div>
        <label for="sender-display-name" class="block text-xs font-medium text-text-secondary mb-1">
          Sender display name
        </label>
        <input
          id="sender-display-name"
          type="text"
          placeholder="(use Gmail default)"
          bind:value={s.senderDisplayName}
          class="w-full max-w-xs rounded border border-border bg-page px-2 py-1.5 text-sm text-text"
        />
      </div>

      <div class="flex items-start gap-2">
        <input
          id="unsubscribe-enabled"
          type="checkbox"
          bind:checked={s.unsubscribeEnabled}
          class="mt-0.5"
        />
        <label for="unsubscribe-enabled" class="text-sm text-text">
          Attach the RFC 8058 List-Unsubscribe one-click header to outbound emails
          <span class="block text-xs text-text-secondary">
            Off by default: the header marks mail as bulk and pushes cold email into
            Gmail's Promotions tab. The compliance footer always carries the opt-out
            (a reply instruction, or the inquiry-landing link when enabled), so
            opt-out compliance does not depend on this header.
          </span>
        </label>
      </div>

      <div>
        <div class="block text-xs font-medium text-text-secondary mb-2">
          Outbound channels
        </div>
        <div class="space-y-2">
          {#each OUTBOUND_CHANNELS as ch (ch)}
            <label class="flex items-start gap-2 text-sm text-text">
              <input
                type="checkbox"
                checked={s.outboundChannels.includes(ch)}
                onchange={(e) => toggleChannel(ch, (e.currentTarget as HTMLInputElement).checked)}
                class="mt-0.5"
              />
              <span>
                <span class="font-medium">{CHANNEL_LABELS[ch]}</span>
                <span class="block text-xs text-text-muted">{CHANNEL_HINTS[ch]}</span>
              </span>
            </label>
          {/each}
        </div>
        <p class="mt-2 text-xs text-text-muted">
          Channels available to automated outbound (<span class="font-mono">/build-list</span>,
          <span class="font-mono">/outbound</span>). Prospects whose only reachable channel is
          unchecked are excluded from automated outbound. Leaving every box unchecked pauses
          automated outbound for this project.
        </p>
      </div>

      <div>
        <div class="block text-xs font-medium text-text-secondary mb-2">
          Target countries
        </div>
        <div class="space-y-2">
          {#each ALLOWED_SEND_COUNTRIES as code (code)}
            <label class="flex items-center gap-2 text-sm text-text">
              <input
                type="checkbox"
                checked={s.targetCountries.includes(code)}
                onchange={(e) => toggleCountry(code, (e.currentTarget as HTMLInputElement).checked)}
              />
              <span>
                {COUNTRY_LABELS[code]} <span class="text-text-muted font-mono text-xs">({code})</span>
              </span>
            </label>
          {/each}
        </div>
        <p class="mt-2 text-xs text-text-muted">
          {#if s.targetCountries.length === 0}
            No project-level restriction — the compliance allowlist (US / CA / JP) is the only gate.
          {:else}
            Automated <span class="font-mono">/build-list</span> focuses discovery on the selected
            countries and <span class="font-mono">/outbound</span> skips prospects outside the set.
            The send-time compliance check still applies independently.
          {/if}
        </p>
      </div>

      <div>
        <div class="flex items-start gap-2">
          <input
            id="followup-enabled"
            type="checkbox"
            bind:checked={s.followUpSequence.enabled}
            class="mt-0.5"
          />
          <label for="followup-enabled" class="text-sm text-text">
            Auto follow-up on unanswered emails
          </label>
        </div>

        {#if s.followUpSequence.enabled}
          <div class="mt-3 ml-6 space-y-2">
            {#each s.followUpSequence.gapDays as _gap, i (i)}
              <div class="flex items-center gap-2 text-sm text-text">
                <span class="w-16 text-text-secondary">Touch {i + 2}</span>
                <input
                  type="number"
                  min="1"
                  max="90"
                  step="1"
                  bind:value={s.followUpSequence.gapDays[i]}
                  class="w-16 rounded border border-border bg-page px-2 py-1 text-sm text-text"
                />
                <span class="text-text-muted text-xs">days after the previous touch</span>
                {#if s.followUpSequence.gapDays.length > 1}
                  <button
                    type="button"
                    onclick={() => removeFollowupTouch(i)}
                    aria-label="Remove touch {i + 2}"
                    class="text-text-muted hover:text-danger transition-colors"
                  >✕</button>
                {/if}
              </div>
            {/each}
            {#if s.followUpSequence.gapDays.length < MAX_FOLLOWUP_GAPS}
              <button
                type="button"
                onclick={addFollowupTouch}
                class="text-xs text-accent hover:text-accent-strong transition-colors"
              >+ add touch</button>
            {/if}
            <p class="mt-1 text-xs text-text-muted">
              Sends at day {followupSendDays.join(', ')}
              <span class="text-text-secondary">({followupSendDays.length} emails total)</span>
            </p>
          </div>
        {/if}

        <p class="mt-2 text-xs text-text-muted">
          When a prospect doesn't reply, <span class="font-mono">/outbound</span> queues a short,
          fresh-angle follow-up on this cadence and stops automatically on any real reply, bounce, or
          unsubscribe (auto-replies don't stop it). Each follow-up consumes 1 outreach action
          (quota), so an N-email sequence multiplies send volume by N.
        </p>
      </div>

      <div class="flex items-center gap-3 pt-2">
        <button
          type="button"
          onclick={saveProjectSettings}
          disabled={savingSettings}
          class="rounded px-3 py-1.5 text-xs font-medium text-page bg-accent hover:bg-accent-strong transition-colors disabled:opacity-50"
        >
          {savingSettings ? 'Saving…' : 'Save'}
        </button>
        {#if settingsMessage}
          <span class="text-xs text-text-muted">{settingsMessage}</span>
        {/if}
      </div>
    </div>
  {/if}
</section>

<section>
  <h3 class="text-xs font-medium text-text-muted uppercase tracking-wider mb-4">Danger zone</h3>

  {#if activeProjectId}
    <div class="rounded-md border border-danger/30 p-4">
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <p class="text-sm font-medium text-text">Delete project</p>
          <p class="text-xs text-text-secondary mt-0.5">
            Permanently delete <span class="font-medium break-words"
              >{projectName ?? activeProjectId}</span
            > and all its data (prospects, outreach logs, responses, evaluations).
          </p>
        </div>
        <button
          onclick={() => (showDeleteDialog = true)}
          disabled={deleting}
          class="rounded px-3 py-1.5 text-xs font-medium text-danger border border-danger/40 hover:bg-danger hover:text-page transition-colors disabled:opacity-50 self-start sm:self-auto"
        >
          Delete
        </button>
      </div>
    </div>
  {/if}
</section>

{#if showDeleteDialog}
  <ConfirmDialog
    title="Delete project"
    message="This will permanently delete the project and all associated data. This action cannot be undone."
    confirmLabel={deleting ? 'Deleting...' : 'Delete'}
    danger
    onconfirm={handleDelete}
    oncancel={() => (showDeleteDialog = false)}
  />
{/if}
