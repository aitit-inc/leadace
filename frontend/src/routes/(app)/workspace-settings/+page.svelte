<script lang="ts">
  import { invalidate } from '$app/navigation';
  import { updateWorkspaceSettings } from '$lib/api/workspace-settings';
  import type { PageProps } from './$types';
  import type { TenantSettings } from '$lib/types/tenants';
  import { SUPPORTED_COUNTRIES } from '$lib/countries';

  let { data }: PageProps = $props();
  let token = $derived(data.session?.access_token);

  let formData = $state<TenantSettings | null>(null);
  $effect(() => {
    formData = data.settings ? { ...data.settings } : null;
  });

  let saving = $state(false);
  let saveMessage = $state('');
  let validationErrors = $state<Partial<Record<keyof TenantSettings, string>>>({});

  function validate(s: TenantSettings): boolean {
    const errors: Partial<Record<keyof TenantSettings, string>> = {};
    if (s.name && s.name.length > 120) errors.name = 'Workspace name is too long (120 chars max)';
    if (s.legalName && s.legalName.length > 200) {
      errors.legalName = 'Legal name is too long (200 chars max)';
    }
    if (s.physicalAddress && s.physicalAddress.length > 500) {
      errors.physicalAddress = 'Address is too long (500 chars max)';
    }
    if (s.physicalAddress && s.physicalAddress.length < 5) {
      errors.physicalAddress = 'Address looks too short';
    }
    if (s.defaultSenderCountry && !/^[A-Z]{2}$/.test(s.defaultSenderCountry)) {
      errors.defaultSenderCountry = 'Country must be a 2-letter ISO code (e.g. US, CA, JP)';
    }
    if (s.legalNameJa && s.legalNameJa.length > 200) {
      errors.legalNameJa = 'Legal name (Japanese) is too long (200 chars max)';
    }
    if (s.physicalAddressJa && s.physicalAddressJa.length > 500) {
      errors.physicalAddressJa = 'Address (Japanese) is too long (500 chars max)';
    }
    if (s.physicalAddressJa && s.physicalAddressJa.length < 5) {
      errors.physicalAddressJa = 'Address (Japanese) looks too short';
    }
    if (s.notificationEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.notificationEmail)) {
      errors.notificationEmail = 'Enter a valid email address';
    }
    validationErrors = errors;
    return Object.keys(errors).length === 0;
  }

  function emptyToNull(v: string | null): string | null {
    if (v === null) return null;
    const t = v.trim();
    return t === '' ? null : t;
  }

  async function save() {
    if (!formData) return;
    const normalized: TenantSettings = {
      ...formData,
      legalName: emptyToNull(formData.legalName),
      physicalAddress: emptyToNull(formData.physicalAddress),
      defaultSenderCountry: emptyToNull(formData.defaultSenderCountry?.toUpperCase() ?? null),
      legalNameJa: emptyToNull(formData.legalNameJa),
      physicalAddressJa: emptyToNull(formData.physicalAddressJa),
      notificationEmail: emptyToNull(formData.notificationEmail),
    };
    if (!validate(normalized)) {
      saveMessage = 'Fix the highlighted fields above before saving.';
      return;
    }
    saving = true;
    saveMessage = '';
    try {
      // PUT body excludes `id` (immutable, backend sources it from auth).
      const { id: _id, ...patch } = normalized;
      await updateWorkspaceSettings(patch, fetch, token);
      await Promise.all([invalidate('app:workspace-settings'), invalidate('app:attention')]);
      saveMessage = 'Saved.';
    } catch (e) {
      saveMessage = `Error: ${e instanceof Error ? e.message : 'Unknown error'}`;
    } finally {
      saving = false;
    }
  }

  // The send paths refuse with PRECONDITION_FAILED if any of these is
  // missing. We surface this as a banner so the user knows up front rather
  // than after a failed /outbound run.
  let complianceReady = $derived(
    !!formData?.legalName?.trim() &&
      !!formData?.physicalAddress?.trim() &&
      !!formData?.defaultSenderCountry?.trim(),
  );
</script>

<svelte:head>
  <title>Workspace · LeadAce</title>
</svelte:head>

<div class="mx-auto max-w-2xl space-y-6">
  <header>
    <h1 class="font-display text-2xl font-semibold tracking-tight text-text">Workspace settings</h1>
    <p class="mt-1 text-sm text-text-secondary">
      Identity used in the default footer of every outgoing email (CAN-SPAM / CASL). All sends
      are blocked until legal name, physical address, and sender country are set.
    </p>
  </header>

  {#if formData}
    {#if !complianceReady}
      <div class="rounded-2xl bg-warning/10 px-4 py-3 text-sm text-warning">
        Compliance footer is incomplete. Outbound sends will return 412 until legal name, physical
        address, and sender country are filled in.
      </div>
    {/if}

    <form
      class="space-y-6"
      onsubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div class="card space-y-5 p-6">
        <section class="space-y-1.5">
          <label for="name" class="block text-sm font-medium text-text">Workspace display name</label>
          <p class="text-xs text-text-muted">
            Internal label only. Shown in the project switcher; never sent to recipients.
          </p>
          <input
            id="name"
            type="text"
            maxlength="120"
            bind:value={formData.name}
            class="field"
          />
          {#if validationErrors.name}
            <p class="text-xs text-danger">{validationErrors.name}</p>
          {/if}
        </section>

        <section class="space-y-1.5">
          <label for="legalName" class="block text-sm font-medium text-text">
            Legal name <span class="text-danger">*</span>
          </label>
          <p class="text-xs text-text-muted">
            The registered company name (LLC / Inc / Ltd) shown verbatim in the footer.
          </p>
          <input
            id="legalName"
            type="text"
            maxlength="200"
            bind:value={formData.legalName}
            placeholder="LeadAce Inc."
            class="field"
          />
          {#if validationErrors.legalName}
            <p class="text-xs text-danger">{validationErrors.legalName}</p>
          {/if}
        </section>

        <section class="space-y-1.5">
          <label for="physicalAddress" class="block text-sm font-medium text-text">
            Physical mailing address <span class="text-danger">*</span>
          </label>
          <p class="text-xs text-text-muted">
            Street address / suite / city / state / postal / country. CAN-SPAM requires a USPS-deliverable
            address (street, registered PO Box, or CMRA private mailbox). Self-host users: this is your
            responsibility.
          </p>
          <textarea
            id="physicalAddress"
            rows="3"
            maxlength="500"
            bind:value={formData.physicalAddress}
            placeholder="123 Market Street, Suite 400, San Francisco, CA 94103, United States"
            class="field"
          ></textarea>
          {#if validationErrors.physicalAddress}
            <p class="text-xs text-danger">{validationErrors.physicalAddress}</p>
          {/if}
        </section>

        <section class="space-y-1.5">
          <label for="defaultSenderCountry" class="block text-sm font-medium text-text">
            Default sender country <span class="text-danger">*</span>
          </label>
          <p class="text-xs text-text-muted">
            Two-letter ISO 3166-1 code. LeadAce currently sends to US, CA, and JP recipients only;
            recipient country comes from the prospect / organization, not this field. Other entries
            are accepted but not yet supported by the send guardrail.
          </p>
          <select
            id="defaultSenderCountry"
            bind:value={formData.defaultSenderCountry}
            class="field"
          >
            <option value={null}>— Select —</option>
            {#each SUPPORTED_COUNTRIES as { code, label } (code)}
              <option value={code}>{label}</option>
            {/each}
          </select>
          {#if validationErrors.defaultSenderCountry}
            <p class="text-xs text-danger">{validationErrors.defaultSenderCountry}</p>
          {/if}
        </section>
      </div>

      <section class="card space-y-5 p-6">
        <div>
          <h2 class="font-display text-lg font-semibold text-text">Japanese footer (for Japanese-language projects)</h2>
          <p class="mt-1 text-sm text-text-secondary">
            Optional. When a project's message language is Japanese (Project settings →
            Message language), the default footer uses these instead of the values above — so a
            bilingual sender shows its Japanese legal identity to Japanese audiences and the
            English one everywhere else. Leave any field blank to fall back to the value above.
          </p>
        </div>

        <div class="space-y-1.5">
          <label for="legalNameJa" class="block text-sm font-medium text-text">Legal name (Japanese)</label>
          <input
            id="legalNameJa"
            type="text"
            maxlength="200"
            bind:value={formData.legalNameJa}
            placeholder="リードエース株式会社"
            class="field"
          />
          {#if validationErrors.legalNameJa}
            <p class="text-xs text-danger">{validationErrors.legalNameJa}</p>
          {/if}
        </div>

        <div class="space-y-1.5">
          <label for="physicalAddressJa" class="block text-sm font-medium text-text">
            Physical mailing address (Japanese)
          </label>
          <textarea
            id="physicalAddressJa"
            rows="3"
            maxlength="500"
            bind:value={formData.physicalAddressJa}
            placeholder="〒100-0001 東京都千代田区千代田1-1 リードエースビル4階"
            class="field"
          ></textarea>
          {#if validationErrors.physicalAddressJa}
            <p class="text-xs text-danger">{validationErrors.physicalAddressJa}</p>
          {/if}
        </div>
      </section>

      <section class="card space-y-3 p-6">
        <div>
          <h2 class="text-sm font-medium text-text">Notifications</h2>
          <p class="mt-0.5 text-xs text-text-muted">
            Leads from the inquiry page, jobs finishing, scheduled runs failing, and the plugin's run reports. In the app they appear
            under the bell (the latest 30).
          </p>
        </div>
        <table class="text-sm">
          <thead>
            <tr class="text-xs text-text-muted">
              <th class="pr-6 text-left font-normal"></th>
              <th class="px-3 font-normal">In the app</th>
              <th class="px-3 font-normal">Email</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="py-1 pr-6 text-text">Leads from the inquiry page</td>
              <td class="px-3 text-center"><input type="checkbox" aria-label="Leads in the app" bind:checked={formData.notifyLeadInApp} /></td>
              <td class="px-3 text-center"><input type="checkbox" aria-label="Leads by email" bind:checked={formData.notifyLeadEmail} /></td>
            </tr>
            <tr>
              <td class="py-1 pr-6 text-text">Scheduled runs</td>
              <td class="px-3 text-center"><input type="checkbox" aria-label="Scheduled runs in the app" bind:checked={formData.notifyCronInApp} /></td>
              <td class="px-3 text-center"><input type="checkbox" aria-label="Scheduled runs by email" bind:checked={formData.notifyCronEmail} /></td>
            </tr>
            <tr>
              <td class="py-1 pr-6 text-text">Everything else</td>
              <td class="px-3 text-center"><input type="checkbox" aria-label="Everything else in the app" bind:checked={formData.notifyGeneralInApp} /></td>
              <td class="px-3 text-center"><input type="checkbox" aria-label="Everything else by email" bind:checked={formData.notifyGeneralEmail} /></td>
            </tr>
          </tbody>
        </table>
      </section>

      <section class="card space-y-1.5 p-6">
        <label for="notificationEmail" class="block text-sm font-medium text-text">
          Notification email
        </label>
        <p class="text-xs text-text-muted">
          Where notification emails go. They go out from your connected Gmail and, by default, to that same address
          {#if data.connectedGmail}({data.connectedGmail}){:else}(none connected yet — see Account settings){/if}.
          Enter an address to redirect them; leave blank to use the default. This can only be
          changed here, never by the plugin.
        </p>
        <input
          id="notificationEmail"
          type="email"
          maxlength="254"
          bind:value={formData.notificationEmail}
          placeholder={data.connectedGmail ?? 'you@example.com'}
          class="field"
        />
        {#if validationErrors.notificationEmail}
          <p class="text-xs text-danger">{validationErrors.notificationEmail}</p>
        {/if}
      </section>

      <div class="flex items-center gap-3">
        <button type="submit" disabled={saving} class="btn btn-primary">
          {saving ? 'Saving…' : 'Save'}
        </button>
        {#if saveMessage}
          <span class={saveMessage.startsWith('Error') ? 'text-sm text-danger' : 'text-sm text-text-muted'}>
            {saveMessage}
          </span>
        {/if}
      </div>
    </form>
  {/if}
</div>
