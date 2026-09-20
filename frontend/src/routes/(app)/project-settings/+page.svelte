<script lang="ts">
  import { goto, invalidate } from '$app/navigation';
  import { updateProjectSettings } from '$lib/api/project-settings';
  import { deleteProject } from '$lib/api/projects';
  import { setActiveProject } from '$lib/active-project';
  import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
  import ProjectMailboxes from '$lib/components/project-settings/ProjectMailboxes.svelte';
  import ProjectSchedules from '$lib/components/schedules/ProjectSchedules.svelte';
  import {
    ALLOWED_SEND_COUNTRIES,
    OUTBOUND_CHANNELS,
    TARGET_LANGUAGES,
    type AllowedSendCountry,
    type FollowUpSequence,
    type OutboundChannel,
    type TargetLanguage,
  } from '$lib/types/project-settings';
  import type { PageProps } from './$types';
  import type { ProjectSettingsData } from './types';

  const CHANNEL_LABELS: Record<OutboundChannel, string> = {
    email: 'Email',
    form: 'Contact form',
    sns_twitter: 'X (Twitter) DM',
    sns_linkedin: 'LinkedIn DM',
    platform: 'External platform',
  };
  const CHANNEL_HINTS: Record<OutboundChannel, string> = {
    email: 'Most stable. Default channel.',
    form: 'Browser-driven submission via claude-in-chrome. Less stable.',
    sns_twitter: 'Browser-driven DM via claude-in-chrome. Less stable; rate-limited.',
    sns_linkedin: 'Browser-driven DM via claude-in-chrome. Less stable; rate-limited.',
    platform: 'In-platform proposals (crowdsourcing, matching sites) driven by a project playbook. Off by default.',
  };
  const COUNTRY_LABELS: Record<AllowedSendCountry, string> = {
    US: 'United States',
    CA: 'Canada',
    JP: 'Japan',
  };
  const LANGUAGE_LABELS: Record<TargetLanguage, string> = {
    en: 'English',
    ja: '日本語 (Japanese)',
  };

  let { data }: PageProps = $props();
  let token = $derived(data.session?.access_token);
  let activeProjectId = $derived(data.activeProjectId);

  let sendingIdentitiesError = $derived(data.sendingIdentitiesError);

  let projectSettings = $state<ProjectSettingsData | null>(null);
  // Sent back only when actually edited — an unrelated save must not materialize
  // the resolved defaults into the overrides-only follow_up_sequence cell.
  let followUpLoaded = $state<FollowUpSequence | null>(null);
  // Text matching the default (or empty) saves as null so an unedited prefill
  // never freezes the recipient-adaptive default footer.
  let footerText = $state('');
  let footerLoadedOverride = $state<string | null>(null);

  $effect(() => {
    const loaded = data.projectSettings;
    if (!loaded) {
      projectSettings = null;
      followUpLoaded = null;
      footerText = '';
      footerLoadedOverride = null;
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
    footerText = loaded.footerOverride ?? loaded.footerDefault ?? '';
    footerLoadedOverride = loaded.footerOverride;
  });

  let savingSettings = $state(false);
  let settingsMessage = $state('');
  let message = $state('');

  let showDeleteDialog = $state(false);
  let deleting = $state(false);

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
        senderDisplayName: projectSettings.senderDisplayName?.trim() || null,
        unsubscribeEnabled: projectSettings.unsubscribeEnabled,
        ...(footerChanged() ? { footerOverride: computedFooterOverride() } : {}),
        ...(followUpChanged() ? { followUpSequence: projectSettings.followUpSequence } : {}),
        outboundChannels: projectSettings.outboundChannels,
        targetCountries: projectSettings.targetCountries,
        targetLanguage: projectSettings.targetLanguage,
        ...(projectSettings.publicScoreboardEligible
          ? { publicScoreboardEnabled: projectSettings.publicScoreboardEnabled }
          : {}),
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

  function computedFooterOverride(): string | null {
    const text = footerText.trim();
    const def = (projectSettings?.footerDefault ?? '').trim();
    return text === '' || text === def ? null : text;
  }

  function footerChanged(): boolean {
    return computedFooterOverride() !== footerLoadedOverride;
  }

  function resetFooter() {
    footerText = projectSettings?.footerDefault ?? '';
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

<div class="mx-auto max-w-3xl space-y-6">
  <h2 class="font-display text-2xl font-semibold tracking-tight text-text">
    Project settings
    {#if projectName}
      <span class="ml-2 font-sans text-sm font-normal tracking-normal text-text-secondary">— {projectName}</span>
    {/if}
  </h2>

  {#if message}
    <div class="card px-5 py-3 text-sm text-text">{message}</div>
  {/if}

  <section class="card p-6">
    <h3 class="font-display text-lg font-semibold text-text">Outbound</h3>

    {#if projectSettings}
      {@const s = projectSettings}
      <div class="mt-5 space-y-6">
        <div>
          <label for="outbound-mode" class="mb-1.5 block text-sm font-medium text-text">
            Outbound mode
          </label>
          <select
            id="outbound-mode"
            bind:value={s.outboundMode}
            class="field max-w-xs"
          >
            <option value="send">Send immediately</option>
            <option value="draft">Create drafts only</option>
          </select>
          <p class="mt-1.5 text-xs text-text-muted">
            In draft mode, Ace stores composed messages here as
            drafts (status <span class="font-mono">pending_review</span>) instead of sending. Review
            and send each one from the
            <a href="/drafts" class="text-accent-strong hover:underline">Drafts</a> page; sending counts toward
            your monthly outreach quota.
          </p>
        </div>

        <ProjectMailboxes
          projectId={s.projectId}
          identities={data.sendingIdentities}
          sendingIdentityIds={s.sendingIdentityIds}
          {token}
          onChanged={() => invalidate('app:project-settings')}
        />
        {#if sendingIdentitiesError}
          <p class="text-xs text-text-muted">Couldn't load your mailboxes. Reload to edit the list.</p>
        {/if}

        <div>
          <label for="sender-display-name" class="mb-1.5 block text-sm font-medium text-text">
            Sender display name
          </label>
          <input
            id="sender-display-name"
            type="text"
            placeholder="(use Gmail default)"
            bind:value={s.senderDisplayName}
            class="field max-w-xs"
          />
        </div>

        <div class="flex items-start gap-2">
          <input
            id="unsubscribe-enabled"
            type="checkbox"
            bind:checked={s.unsubscribeEnabled}
            class="mt-0.5"
          />
          <label for="unsubscribe-enabled" class="text-sm font-medium text-text">
            Attach the RFC 8058 List-Unsubscribe one-click header to outbound emails
            <span class="mt-0.5 block text-xs font-normal text-text-muted">
              Off by default: the header marks mail as bulk and pushes cold email into
              Gmail's Promotions tab. The default footer carries the opt-out (a reply
              instruction, or the inquiry-landing link when enabled) — keep an opt-out
              line in a custom footer too — so opt-out compliance does not depend on
              this header.
            </span>
          </label>
        </div>

        <div>
          <div class="mb-2 text-sm font-medium text-text">
            Message language
          </div>
          <div class="flex gap-4">
            {#each TARGET_LANGUAGES as lang (lang)}
              <label class="flex items-center gap-2 text-sm text-text">
                <input type="radio" name="target-language" value={lang} bind:group={s.targetLanguage} />
                <span>{LANGUAGE_LABELS[lang]}</span>
              </label>
            {/each}
          </div>
          <p class="mt-2 text-xs text-text-muted">
            Language of this project's outbound messages — the AI-written subject and body,
            and the footer below. One project targets one language; create separate projects
            for audiences in different languages. Pages recipients open in a browser
            (inquiry landing, unsubscribe) follow the visitor's browser language instead.
          </p>
        </div>

        <div>
          <label for="email-footer" class="mb-1.5 block text-sm font-medium text-text">
            Message footer
          </label>
          {#if s.inquiryLandingEnabled}
            <p class="text-xs text-text-muted">
              The inquiry landing is enabled, so the footer carries each prospect's personal
              inquiry link and is assembled per send — it can't be replaced with static text.
              Disable the landing in
              <a href="/inquiry-settings" class="text-accent-strong hover:underline">Inquiry settings</a>
              to customize the footer.
            </p>
          {:else}
            <textarea
              id="email-footer"
              rows="5"
              bind:value={footerText}
              class="field max-w-lg"
            ></textarea>
            <div class="mt-1.5 flex items-center gap-2">
              <span
                class="chip {computedFooterOverride() !== null
                  ? 'bg-accent/10 text-accent-strong'
                  : 'bg-surface-2 text-text-secondary'}"
              >
                {computedFooterOverride() !== null ? 'Custom' : 'Default'}
              </span>
              <button
                type="button"
                onclick={resetFooter}
                disabled={!s.footerDefault || footerText.trim() === s.footerDefault}
                class="btn btn-ghost btn-sm"
              >
                Reset to default
              </button>
            </div>
            <p class="mt-1.5 text-xs text-text-muted">
              Appended after the body of every outbound message — emails, and the form /
              social-DM draft text you copy from Drafts. The default is assembled in the
              message language above and the opt-out wording varies per prospect. Edited
              text is sent verbatim to everyone; keep your sender identity, address, and an
              opt-out instruction in it (that content is your legal responsibility).
              Clearing the text restores the default.
            </p>
            {#if !s.footerDefault}
              <p class="mt-1 text-xs text-text-muted">
                No default available yet — set Legal name and Physical address in
                <a href="/workspace-settings" class="text-accent-strong hover:underline">Workspace settings</a>.
              </p>
            {/if}
          {/if}
        </div>

        <div>
          <div class="mb-2 text-sm font-medium text-text">
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
            Channels available to automated outbound. Prospects whose only reachable channel is
            unchecked are excluded from automated outbound. Leaving every box unchecked pauses
            automated outbound for this project.
          </p>
        </div>

        <div>
          <div class="mb-2 text-sm font-medium text-text">
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
                  {COUNTRY_LABELS[code]} <span class="text-text-muted">({code})</span>
                </span>
              </label>
            {/each}
          </div>
          <p class="mt-2 text-xs text-text-muted">
            {#if s.targetCountries.length === 0}
              No project-level restriction — the compliance allowlist (US / CA / JP) is the only gate.
            {:else}
              Ace focuses discovery on the selected countries and skips prospects outside the set.
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
            <label for="followup-enabled" class="text-sm font-medium text-text">
              Auto follow-up on unanswered emails
            </label>
          </div>

          {#if s.followUpSequence.enabled}
            <div class="mt-3 ml-6 space-y-2">
              {#each s.followUpSequence.gapDays as _gap, i (i)}
                <div class="flex items-center gap-2 text-sm text-text">
                  <span class="w-16 tabular-nums text-text-secondary">Touch {i + 2}</span>
                  <input
                    type="number"
                    min="1"
                    max="90"
                    step="1"
                    bind:value={s.followUpSequence.gapDays[i]}
                    class="field w-20 tabular-nums"
                  />
                  <span class="text-text-muted">days after the previous touch</span>
                  {#if s.followUpSequence.gapDays.length > 1}
                    <button
                      type="button"
                      onclick={() => removeFollowupTouch(i)}
                      aria-label="Remove touch {i + 2}"
                      class="btn btn-ghost btn-sm"
                    >✕</button>
                  {/if}
                </div>
              {/each}
              {#if s.followUpSequence.gapDays.length < MAX_FOLLOWUP_GAPS}
                <button
                  type="button"
                  onclick={addFollowupTouch}
                  class="btn btn-secondary btn-sm"
                >+ add touch</button>
              {/if}
              <p class="mt-1 text-xs tabular-nums text-text-muted">
                Sends at day {followupSendDays.join(', ')}
                <span class="text-text-secondary">({followupSendDays.length} emails total)</span>
              </p>
            </div>
          {/if}

          <p class="mt-2 text-xs text-text-muted">
            When a prospect doesn't reply, Ace queues a short,
            fresh-angle follow-up on this cadence and stops automatically on any real reply, bounce, or
            unsubscribe (auto-replies don't stop it). Follow-ups don't count against your plan — a
            prospect counts once, when its first email goes out — but an N-email sequence still
            multiplies your mailbox's daily send volume by N. Turning this on also picks up prospects
            you emailed recently (within the length of the sequence); older ones wait for the regular
            re-approach.
          </p>
        </div>

        <ProjectSchedules
          projectId={s.projectId}
          schedules={data.schedules}
          {token}
          onChanged={() => invalidate('app:project-settings')}
        />

        {#if s.publicScoreboardEligible}
          <div class="flex items-start gap-2">
            <input
              id="public-scoreboard-enabled"
              type="checkbox"
              bind:checked={s.publicScoreboardEnabled}
              class="mt-0.5"
            />
            <label for="public-scoreboard-enabled" class="text-sm font-medium text-text">
              Publish a public scoreboard for this project
              <span class="mt-0.5 block text-xs font-normal text-text-muted">
                Shows this project's outbound numbers (sends, human replies, reply and bounce
                rates) and the agent's daily public journal on the unauthenticated
                <a href="/live" class="text-accent-strong hover:underline">/live</a> page. The daily cycle
                writes the journal only while this is on; third-party names in it are replaced
                by industry and size, once by the agent and once more on the server. Turning it
                off takes the page down within five minutes.
              </span>
            </label>
          </div>
        {/if}

        <div class="flex items-center gap-3 border-t border-border pt-5">
          <button
            type="button"
            onclick={saveProjectSettings}
            disabled={savingSettings}
            class="btn btn-primary"
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

  <section class="card p-6">
    <h3 class="font-display text-lg font-semibold text-text">Danger zone</h3>

    {#if activeProjectId}
      <div class="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p class="text-sm font-medium text-text">Delete project</p>
          <p class="mt-0.5 text-sm text-text-secondary">
            Permanently delete <span class="font-medium break-words"
              >{projectName ?? activeProjectId}</span
            > and all its data (prospects, outreach logs, responses, evaluations).
          </p>
        </div>
        <button
          onclick={() => (showDeleteDialog = true)}
          disabled={deleting}
          class="btn btn-danger self-start sm:self-auto"
        >
          Delete
        </button>
      </div>
    {/if}
  </section>
</div>

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
