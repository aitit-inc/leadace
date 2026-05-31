<script lang="ts">
  import { invalidate } from '$app/navigation';
  import { updateWorkspaceSettings } from '$lib/api/workspace-settings';
  import type { PageProps } from './$types';
  import type { TenantSettings } from '$lib/types/tenants';

  let { data }: PageProps = $props();
  let token = $derived(data.session?.access_token);

  let formData = $state<TenantSettings | null>(null);
  $effect(() => {
    formData = data.settings ? { ...data.settings } : null;
  });

  let saving = $state(false);
  let saveMessage = $state('');
  let validationErrors = $state<Partial<Record<keyof TenantSettings, string>>>({});

  // Currently allowed send-target countries. Matches
  // backend/src/domain/country.ts:ALLOWED_SEND_COUNTRIES. Anything outside
  // this list is accepted by the backend (the column is free-form ISO
  // 3166-1 alpha-2) but the send-time guardrail will block it.
  const SUPPORTED_COUNTRIES: { code: string; label: string }[] = [
    { code: 'US', label: 'United States (US)' },
    { code: 'CA', label: 'Canada (CA)' },
    { code: 'JP', label: 'Japan (JP)' },
  ];

  function validateUrl(value: string | null, label: string): string | null {
    if (!value) return null;
    try {
      const u = new URL(value);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return `${label} must use http(s)://`;
      }
      if (value.length > 500) return `${label} is too long (500 chars max)`;
      return null;
    } catch {
      return `${label} is not a valid URL`;
    }
  }

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
    const privacyErr = validateUrl(s.privacyPolicyUrl, 'Privacy policy URL');
    if (privacyErr) errors.privacyPolicyUrl = privacyErr;
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
      privacyPolicyUrl: emptyToNull(formData.privacyPolicyUrl),
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
      await invalidate('app:workspace-settings');
      saveMessage = 'Saved.';
    } catch (e) {
      saveMessage = `Error: ${e instanceof Error ? e.message : 'Unknown error'}`;
    } finally {
      saving = false;
    }
  }

  // Required fields for compliance: legal_name + physical_address +
  // default_sender_country. The send paths refuse with PRECONDITION_FAILED
  // if any are missing. We surface this as a banner so the user knows up
  // front rather than after a failed /outbound run.
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
    <h1 class="text-2xl font-semibold text-text">Workspace settings</h1>
    <p class="mt-1 text-sm text-text-secondary">
      Identity used in every outgoing email's compliance footer (CAN-SPAM / CASL). All sends are
      blocked until legal name, physical address, and sender country are set.
    </p>
  </header>

  {#if formData}
    {#if !complianceReady}
      <div class="rounded-lg border border-warning bg-warning/10 p-3 text-sm text-warning">
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
      <section class="space-y-1">
        <label for="name" class="block text-sm font-medium text-text">Workspace display name</label>
        <p class="text-xs text-text-muted">
          Internal label only. Shown in the project switcher; never sent to recipients.
        </p>
        <input
          id="name"
          type="text"
          maxlength="120"
          bind:value={formData.name}
          class="block w-full rounded border border-border bg-page px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-text/40 focus:outline-none"
        />
        {#if validationErrors.name}
          <p class="text-xs text-danger">{validationErrors.name}</p>
        {/if}
      </section>

      <section class="space-y-1">
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
          placeholder="Acme Software Inc."
          class="block w-full rounded border border-border bg-page px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-text/40 focus:outline-none"
        />
        {#if validationErrors.legalName}
          <p class="text-xs text-danger">{validationErrors.legalName}</p>
        {/if}
      </section>

      <section class="space-y-1">
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
          class="block w-full rounded border border-border bg-page px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-text/40 focus:outline-none"
        ></textarea>
        {#if validationErrors.physicalAddress}
          <p class="text-xs text-danger">{validationErrors.physicalAddress}</p>
        {/if}
      </section>

      <section class="space-y-1">
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
          class="block w-full rounded border border-border bg-page px-3 py-2 text-sm text-text focus:border-text/40 focus:outline-none"
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

      <section class="space-y-1">
        <label for="privacyPolicyUrl" class="block text-sm font-medium text-text">Privacy policy URL</label>
        <p class="text-xs text-text-muted">
          Optional. When set, appended as <code>Privacy: …</code> in every email footer. This is
          <strong>your own</strong> privacy notice as the sender — the current send targets (US / CA / JP)
          don't require it; it only carries legal weight as your GDPR Art.14 notice when emailing
          named individuals in the UK / EU. LeadAce's own privacy policy can't substitute for it.
        </p>
        <input
          id="privacyPolicyUrl"
          type="url"
          bind:value={formData.privacyPolicyUrl}
          placeholder="https://example.com/privacy"
          class="block w-full rounded border border-border bg-page px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-text/40 focus:outline-none"
        />
        {#if validationErrors.privacyPolicyUrl}
          <p class="text-xs text-danger">{validationErrors.privacyPolicyUrl}</p>
        {/if}
      </section>

      <div class="flex items-center gap-3 border-t border-border pt-4">
        <button
          type="submit"
          disabled={saving}
          class="rounded bg-text px-4 py-2 text-sm font-medium text-page hover:bg-text/90 transition-colors disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {#if saveMessage}
          <span class={saveMessage.startsWith('Error') ? 'text-xs text-danger' : 'text-xs text-text-muted'}>
            {saveMessage}
          </span>
        {/if}
      </div>
    </form>
  {/if}
</div>
