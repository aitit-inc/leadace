<script lang="ts">
  import { invalidate } from '$app/navigation';
  import { updateProjectSettings } from '$lib/api/project-settings';
  import type { PageProps } from './$types';
  import type { InquirySettings } from './types';

  // The /projects/:id/settings endpoint returns more fields than we touch
  // here, but we declare the response as InquirySettings — TS structural
  // typing accepts the wider runtime object, and only the inquiry fields
  // appear in the typed view. We round-trip just the inquiry subset via
  // partial-update PUT; other server-side columns stay untouched.
  let { data }: PageProps = $props();
  let token = $derived(data.session?.access_token);

  // Editable copy of the server-fetched settings. Hydrated once per
  // project (initial load / project switch). The post-save invalidate
  // re-runs this $effect, but data.projectId hasn't changed so it's a
  // no-op — typed input is preserved on both success and failure.
  // Successful save() re-syncs formData explicitly below; a failed save
  // leaves the typed input intact so the user can retry without losing
  // work.
  let formData = $state<InquirySettings | null>(null);
  let saving = $state(false);
  let hydratedFor = $state<string | null | undefined>(undefined);
  $effect(() => {
    if (data.projectId === hydratedFor) return;
    formData = data.settings ? { ...data.settings } : null;
    hydratedFor = data.projectId;
  });
  let saveMessage = $state('');
  let validationErrors = $state<Partial<Record<keyof InquirySettings, string>>>({});

  // Defense-in-depth — these match the backend zod regexes exactly so the
  // user gets immediate feedback and the server is unlikely to reject what
  // we send. The server is still the source of truth.
  const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

  function validateUrl(value: string | null, label: string): string | null {
    if (!value) return null;
    try {
      const u = new URL(value);
      if (u.protocol !== 'https:') {
        return `${label} must use https://`;
      }
      if (value.length > 500) return `${label} is too long (500 chars max)`;
      return null;
    } catch {
      return `${label} is not a valid URL`;
    }
  }

  function validate(s: InquirySettings): boolean {
    const errors: Partial<Record<keyof InquirySettings, string>> = {};
    if (s.senderCompanyName && s.senderCompanyName.length > 200) {
      errors.senderCompanyName = 'Company name is too long (200 chars max)';
    }
    if (s.senderJobTitle && s.senderJobTitle.length > 200) {
      errors.senderJobTitle = 'Job title is too long (200 chars max)';
    }
    if (s.inquiryChatBrief && s.inquiryChatBrief.length > 4000) {
      errors.inquiryChatBrief = 'Brief is too long (4000 chars max)';
    }
    if (s.inquiryOneLiner && s.inquiryOneLiner.length > 140) {
      errors.inquiryOneLiner = 'One-liner is too long (140 chars max)';
    }
    const videoErr = validateUrl(s.inquiryVideoUrl, 'Video URL');
    if (videoErr) errors.inquiryVideoUrl = videoErr;
    const pdfErr = validateUrl(s.inquiryPdfUrl, 'PDF URL');
    if (pdfErr) errors.inquiryPdfUrl = pdfErr;
    const logoErr = validateUrl(s.inquiryBrandLogoUrl, 'Brand logo URL');
    if (logoErr) errors.inquiryBrandLogoUrl = logoErr;
    const ctaUrlErr = validateUrl(s.inquiryCtaUrl, 'CTA URL');
    if (ctaUrlErr) errors.inquiryCtaUrl = ctaUrlErr;
    if (s.inquiryCtaType === 'signup' && !s.inquiryCtaUrl) {
      errors.inquiryCtaUrl = 'Sign up mode requires a destination URL';
    }
    if (s.inquiryBrandColor && !HEX_COLOR.test(s.inquiryBrandColor)) {
      errors.inquiryBrandColor = 'Brand color must be a 6-digit hex like #1a2b3c';
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
    if (!formData || !data.projectId) return;
    const normalized: InquirySettings = {
      senderCompanyName: emptyToNull(formData.senderCompanyName),
      senderJobTitle: emptyToNull(formData.senderJobTitle),
      inquiryLandingEnabled: formData.inquiryLandingEnabled,
      inquiryChatBrief: emptyToNull(formData.inquiryChatBrief),
      inquiryOneLiner: emptyToNull(formData.inquiryOneLiner),
      inquiryVideoUrl: emptyToNull(formData.inquiryVideoUrl),
      inquiryPdfUrl: emptyToNull(formData.inquiryPdfUrl),
      inquiryBrandColor: emptyToNull(formData.inquiryBrandColor),
      inquiryBrandLogoUrl: emptyToNull(formData.inquiryBrandLogoUrl),
      inquiryDarkBackground: formData.inquiryDarkBackground,
      inquiryCtaType: formData.inquiryCtaType,
      inquiryCtaUrl: emptyToNull(formData.inquiryCtaUrl),
    };
    if (!validate(normalized)) {
      saveMessage = 'Fix the highlighted fields above before saving.';
      return;
    }
    saving = true;
    saveMessage = '';
    try {
      await updateProjectSettings<InquirySettings>(
        data.projectId,
        normalized,
        fetch,
        token,
      );
      await invalidate('app:project-settings');
      // Adopt post-save server state as the authoritative view. Only on
      // success — a failed save keeps the typed input visible.
      if (data.settings) formData = { ...data.settings };
      saveMessage = 'Saved.';
    } catch (e) {
      saveMessage = `Error: ${e instanceof Error ? e.message : 'Unknown error'}`;
    } finally {
      saving = false;
    }
  }

  function openPreview() {
    if (!data.projectId) return;
    window.open(`/q/preview?project=${encodeURIComponent(data.projectId)}`, '_blank', 'noopener');
  }
</script>

<svelte:head>
  <title>AI Inquiry page · LeadAce</title>
</svelte:head>

<div class="mx-auto max-w-2xl space-y-6">
  <header class="flex items-start justify-between gap-4">
    <div>
      <h1 class="text-2xl font-semibold text-text">AI Inquiry page</h1>
      <p class="mt-1 text-sm text-text-secondary">
        Configure the receiver-facing landing page that recipients see when they tap the link in
        your cold-outreach footer.
      </p>
    </div>
    <button
      type="button"
      onclick={openPreview}
      disabled={!data.projectId}
      class="shrink-0 rounded border border-border bg-surface px-3 py-1.5 text-sm text-text hover:border-text/40 transition-colors disabled:opacity-40"
    >
      Open preview ↗
    </button>
  </header>

  {#if !data.projectId}
    <div class="rounded-lg border border-border bg-surface p-6 text-center">
      <p class="text-sm text-text">No project selected.</p>
      <p class="mt-1 text-xs text-text-muted">
        Pick or create a project from the switcher above to edit its inquiry page.
      </p>
    </div>
  {:else if formData}
    {@const s = formData}
    <form
      class="space-y-6"
      onsubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <section class="space-y-2 rounded-lg border border-border bg-surface p-4">
        <label class="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            bind:checked={s.inquiryLandingEnabled}
            class="mt-0.5"
          />
          <span>
            <span class="block text-sm font-medium text-text">Enable inquiry landing</span>
            <span class="block text-xs text-text-muted">
              When off, your cold-email footer omits the inquiry link and recipients can only
              unsubscribe. The chat backend is also disabled.
            </span>
          </span>
        </label>
      </section>

      <section class="space-y-1">
        <label for="senderCompanyName" class="block text-sm font-medium text-text">
          Company name
          <span class="text-text-muted">(optional)</span>
        </label>
        <p class="text-xs text-text-muted">
          Shown to recipients in the landing header as
          <span class="font-mono text-text">From [your name], [Role] at [Company]</span>
          (Role only when Job title is set, see below). The personal name comes from
          <strong class="text-text">Sender display name</strong> in the
          <a href="/project-settings" class="underline hover:text-text">Project settings</a>.
          Leave empty to omit the company suffix.
        </p>
        <input
          id="senderCompanyName"
          type="text"
          maxlength="200"
          bind:value={s.senderCompanyName}
          placeholder="e.g. Acme Inc."
          class="block w-full rounded border border-border bg-page px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-text/40 focus:outline-none"
        />
        {#if validationErrors.senderCompanyName}
          <p class="text-xs text-danger">{validationErrors.senderCompanyName}</p>
        {/if}
      </section>

      <section class="space-y-1">
        <label for="senderJobTitle" class="block text-sm font-medium text-text">
          Job title
          <span class="text-text-muted">(optional)</span>
        </label>
        <p class="text-xs text-text-muted">
          Role shown alongside your name in the landing header as
          <span class="font-mono text-text">From [your name], [Role] at [Company]</span>.
          Has no effect when <strong class="text-text">Sender display name</strong> is empty.
        </p>
        <input
          id="senderJobTitle"
          type="text"
          maxlength="200"
          bind:value={s.senderJobTitle}
          placeholder="e.g. Co-founder / Head of Sales"
          class="block w-full rounded border border-border bg-page px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-text/40 focus:outline-none"
        />
        {#if validationErrors.senderJobTitle}
          <p class="text-xs text-danger">{validationErrors.senderJobTitle}</p>
        {/if}
      </section>

      <section class="space-y-1">
        <label for="brief" class="block text-sm font-medium text-text">
          AI chat brief
          <span class="text-text-muted">(~1000 chars + 2–4 FAQ items recommended)</span>
        </label>
        <p class="text-xs text-text-muted">
          What the AI knows about your offer. Cover elevator pitch, problems solved, pricing, trust
          foundation, and 2–4 short FAQ items as <code>Q: … A: …</code> lines. Leave empty to hide
          the chat box entirely — recipients can still use Request meeting or reply to your email.
        </p>
        <textarea
          id="brief"
          rows="10"
          maxlength="4000"
          bind:value={s.inquiryChatBrief}
          placeholder={`e.g. We help B2B SaaS teams automate cold-outreach research. Replaces 5–10 hours/week of manual prospecting with an autonomous loop tied to your CRM. Pricing from $29/mo. Used by 40+ early-stage teams.\n\nQ: How long is onboarding?\nA: ~30 minutes — connect Gmail, define your ICP, run the first batch.\n\nQ: How do you handle GDPR / data residency?\nA: All recipient data stays in our EU region; we do not sell or repurpose contact info.`}
          class="block w-full rounded border border-border bg-page px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-text/40 focus:outline-none"
        ></textarea>
        {#if validationErrors.inquiryChatBrief}
          <p class="text-xs text-danger">{validationErrors.inquiryChatBrief}</p>
        {/if}
      </section>

      <section class="space-y-1">
        <label for="oneLiner" class="block text-sm font-medium text-text">
          One-liner pitch
          <span class="text-text-muted">(≤140 chars)</span>
        </label>
        <p class="text-xs text-text-muted">
          Hooky tagline shown at the top of the recipient landing page. Auto-generated by
          <code>/leadace</code> from your elevator pitch — leave empty to hide it.
        </p>
        <input
          id="oneLiner"
          type="text"
          maxlength="140"
          bind:value={s.inquiryOneLiner}
          placeholder="e.g. Stop spending Sundays on prospect research."
          class="block w-full rounded border border-border bg-page px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-text/40 focus:outline-none"
        />
        {#if validationErrors.inquiryOneLiner}
          <p class="text-xs text-danger">{validationErrors.inquiryOneLiner}</p>
        {/if}
      </section>

      <section class="space-y-1">
        <label for="videoUrl" class="block text-sm font-medium text-text">Intro video URL</label>
        <p class="text-xs text-text-muted">
          YouTube or Vimeo unlisted URL. Embedded automatically. Leave empty to hide.
        </p>
        <input
          id="videoUrl"
          type="url"
          bind:value={s.inquiryVideoUrl}
          placeholder="https://www.youtube.com/watch?v=…"
          class="block w-full rounded border border-border bg-page px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-text/40 focus:outline-none"
        />
        {#if validationErrors.inquiryVideoUrl}
          <p class="text-xs text-danger">{validationErrors.inquiryVideoUrl}</p>
        {/if}
      </section>

      <section class="space-y-1">
        <label for="pdfUrl" class="block text-sm font-medium text-text">PDF download URL</label>
        <p class="text-xs text-text-muted">
          Optional one-pager / deck. Hosted anywhere reachable over HTTPS.
        </p>
        <input
          id="pdfUrl"
          type="url"
          bind:value={s.inquiryPdfUrl}
          placeholder="https://example.com/deck.pdf"
          class="block w-full rounded border border-border bg-page px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-text/40 focus:outline-none"
        />
        {#if validationErrors.inquiryPdfUrl}
          <p class="text-xs text-danger">{validationErrors.inquiryPdfUrl}</p>
        {/if}
      </section>

      <section class="space-y-3 rounded-lg border border-border bg-surface p-4">
        <div class="space-y-1">
          <span class="block text-sm font-medium text-text">Call-to-action</span>
          <p class="text-xs text-text-muted">
            What the landing page asks recipients to do. The two modes are mutually exclusive.
          </p>
        </div>

        <div class="space-y-2">
          <label class="flex cursor-pointer items-start gap-2">
            <input
              type="radio"
              name="inquiryCtaType"
              value="meeting"
              checked={s.inquiryCtaType === 'meeting'}
              onchange={() => (s.inquiryCtaType = 'meeting')}
              class="mt-0.5"
            />
            <span class="text-sm">
              <span class="block font-medium text-text">Meeting</span>
              <span class="block text-xs text-text-muted">
                Recipients tap <strong class="text-text">Request meeting</strong> / <strong class="text-text">Book a meeting</strong>.
                You follow up by email or scheduling tool.
              </span>
            </span>
          </label>
          <label class="flex cursor-pointer items-start gap-2">
            <input
              type="radio"
              name="inquiryCtaType"
              value="signup"
              checked={s.inquiryCtaType === 'signup'}
              onchange={() => (s.inquiryCtaType = 'signup')}
              class="mt-0.5"
            />
            <span class="text-sm">
              <span class="block font-medium text-text">Sign up</span>
              <span class="block text-xs text-text-muted">
                Self-serve. Recipients tap <strong class="text-text">Sign up</strong> and land on
                the URL below — no human follow-up. Use for PLG / free-trial flows.
              </span>
            </span>
          </label>
        </div>

        <div class="space-y-1">
          <label for="ctaUrl" class="block text-sm font-medium text-text">
            {s.inquiryCtaType === 'signup' ? 'Sign up URL' : 'Scheduling URL'}
            <span class="text-text-muted">
              {s.inquiryCtaType === 'signup' ? '(required)' : '(optional)'}
            </span>
          </label>
          <p class="text-xs text-text-muted">
            {#if s.inquiryCtaType === 'signup'}
              Destination of the Sign up button (your SaaS signup or trial page). Required.
            {:else}
              Calendly, TimeRex, or any scheduling page. When set, the meeting button opens this URL
              in a new tab and still records the lead. Leave empty for notify-only — you reach out
              manually.
            {/if}
          </p>
          <input
            id="ctaUrl"
            type="url"
            bind:value={s.inquiryCtaUrl}
            placeholder={s.inquiryCtaType === 'signup'
              ? 'https://app.example.com/signup'
              : 'https://calendly.com/your-handle/intro'}
            class="block w-full rounded border border-border bg-page px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-text/40 focus:outline-none"
          />
          {#if validationErrors.inquiryCtaUrl}
            <p class="text-xs text-danger">{validationErrors.inquiryCtaUrl}</p>
          {/if}
        </div>
      </section>

      <section class="space-y-2 rounded-lg border border-border bg-surface p-4">
        <span class="block text-sm font-medium text-text">Background</span>
        <p class="text-xs text-text-muted">
          The canvas recipients see on the landing page. Your brand color stays the accent on either.
        </p>
        <div class="flex gap-4">
          <label class="flex cursor-pointer items-center gap-2">
            <input
              type="radio"
              name="inquiryDarkBackground"
              checked={!s.inquiryDarkBackground}
              onchange={() => (s.inquiryDarkBackground = false)}
            />
            <span class="text-sm text-text">Light</span>
          </label>
          <label class="flex cursor-pointer items-center gap-2">
            <input
              type="radio"
              name="inquiryDarkBackground"
              checked={s.inquiryDarkBackground}
              onchange={() => (s.inquiryDarkBackground = true)}
            />
            <span class="text-sm text-text">Dark</span>
          </label>
        </div>
      </section>

      <section class="grid gap-4 sm:grid-cols-[auto_1fr]">
        <div class="space-y-1">
          <label for="brandColor" class="block text-sm font-medium text-text">Brand color</label>
          <p class="text-xs text-text-muted">6-digit hex.</p>
          <div class="flex items-center gap-2">
            <input
              id="brandColor"
              type="color"
              value={s.inquiryBrandColor ?? '#000000'}
              onchange={(e) => (s.inquiryBrandColor = e.currentTarget.value)}
              class="h-9 w-12 cursor-pointer rounded border border-border bg-page"
            />
            <input
              type="text"
              maxlength="7"
              bind:value={s.inquiryBrandColor}
              placeholder="#1a2b3c"
              class="w-28 rounded border border-border bg-page px-2 py-1.5 font-mono text-xs text-text placeholder:text-text-muted focus:border-text/40 focus:outline-none"
            />
          </div>
          {#if validationErrors.inquiryBrandColor}
            <p class="text-xs text-danger">{validationErrors.inquiryBrandColor}</p>
          {/if}
        </div>

        <div class="space-y-1">
          <label for="brandLogo" class="block text-sm font-medium text-text">Brand logo URL</label>
          <p class="text-xs text-text-muted">Square preferred. Shown in the header.</p>
          <div class="flex items-center gap-3">
            <input
              id="brandLogo"
              type="url"
              bind:value={s.inquiryBrandLogoUrl}
              placeholder="https://example.com/logo.png"
              class="flex-1 rounded border border-border bg-page px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-text/40 focus:outline-none"
            />
            {#if s.inquiryBrandLogoUrl && !validationErrors.inquiryBrandLogoUrl}
              <img
                src={s.inquiryBrandLogoUrl}
                alt=""
                class="h-9 w-9 rounded border border-border object-contain"
                loading="lazy"
              />
            {/if}
          </div>
          {#if validationErrors.inquiryBrandLogoUrl}
            <p class="text-xs text-danger">{validationErrors.inquiryBrandLogoUrl}</p>
          {/if}
        </div>
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
