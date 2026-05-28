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
    type OutboundChannel,
  } from '$lib/types/project-settings';
  import type { PageProps } from './$types';
  import type { ProjectSettingsData } from './types';

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

  let projectSettings = $state<ProjectSettingsData | null>(null);
  $effect(() => {
    projectSettings = data.projectSettings ? { ...data.projectSettings } : null;
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
        senderEmailAlias: projectSettings.senderEmailAlias?.trim() || null,
        senderDisplayName: projectSettings.senderDisplayName?.trim() || null,
        unsubscribeEnabled: projectSettings.unsubscribeEnabled,
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

      <div>
        <label for="sender-alias" class="block text-xs font-medium text-text-secondary mb-1">
          Sender email alias
        </label>
        <input
          id="sender-alias"
          type="email"
          placeholder="primary Gmail (default)"
          bind:value={s.senderEmailAlias}
          class="w-full max-w-xs rounded border border-border bg-page px-2 py-1.5 text-sm text-text font-mono"
        />
        <p class="mt-1 text-xs text-text-muted">
          A Gmail Send-As alias (e.g. <span class="font-mono">sales@yourdomain.com</span>) to use
          as the From: address. The alias must already be set up and verified in
          <a
            href="https://mail.google.com/mail/u/0/#settings/accounts"
            target="_blank"
            rel="noopener"
            class="underline hover:text-text"
          >Gmail → Settings → Accounts and Import</a>. If it isn't verified there, sending will
          fail with a Gmail error.
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
          Add unsubscribe link & List-Unsubscribe header to outbound emails
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
