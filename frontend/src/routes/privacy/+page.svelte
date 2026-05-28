<script lang="ts">
  import Logo from '$lib/components/Logo.svelte';
  import { EDITION } from '$lib/config';
  const lastUpdated = '2026-05-15';
</script>

<svelte:head>
  <title>Privacy Policy · LeadAce</title>
</svelte:head>

<div class="mx-auto max-w-2xl px-6 py-12">
  <a href="/" class="inline-flex items-center gap-1.5 text-xs text-text-muted hover:text-text">
    <Logo size={14} class="text-accent" />
    ← LeadAce
  </a>
  <h1 class="mt-4 text-2xl font-semibold text-text">Privacy Policy</h1>
  <p class="mt-1 text-xs text-text-muted">Last updated: {lastUpdated}</p>

  {#if EDITION !== 'cloud'}
    <div class="mt-8 space-y-4 text-sm leading-relaxed text-text-secondary">
      <p>
        The policy below applies only to the LeadAce SaaS operated by SurpassOne Inc. at
        <a href="https://leadace.ai" target="_blank" rel="noopener noreferrer" class="underline"
          >leadace.ai</a
        >. This deployment is a self-hosted build of the LeadAce open-source project, run by
        someone other than SurpassOne Inc.; SurpassOne is not the data controller for personal
        data handled by this instance.
      </p>
      <p>
        For information on how the operator of this site collects, uses, and stores your data,
        please contact them directly. The LeadAce code itself does not transmit your data to
        SurpassOne or any other third party beyond the sub-processors the operator has chosen to
        configure (typically the database and authentication provider hosting this instance).
      </p>
      <p>
        LeadAce source:
        <a
          href="https://github.com/aitit-inc/leadace"
          target="_blank"
          rel="noopener noreferrer"
          class="underline">github.com/aitit-inc/leadace</a
        >
      </p>
    </div>
  {:else}
  <div class="mt-8 space-y-6 text-sm leading-relaxed text-text-secondary">
    <p>
      This Privacy Policy explains how SurpassOne Inc. ("<strong>we</strong>") handles personal
      data when you use LeadAce.
    </p>

    <section>
      <h2 class="text-base font-semibold text-text">1. Information we collect</h2>
      <ul class="mt-2 list-disc pl-5 space-y-1">
        <li>
          <strong>Account data:</strong> email address and profile information returned by Google
          Sign-In (managed by Supabase Auth), plus timestamps of sign-in/sign-out events.
        </li>
        <li>
          <strong>Google OAuth credentials:</strong> a long-lived authorisation that lets LeadAce
          send email from your connected Gmail address. It is encrypted at rest and used only to
          send outbound email on your behalf when you trigger an outreach action. We do not
          request, store, or read your inbox — reply checking is performed locally through
          claude.ai's Gmail MCP. See Section 3 below for the full disclosure on Google user data.
        </li>
        <li>
          <strong>Subscription and billing data:</strong> plan tier, billing period, Stripe
          customer and subscription identifiers. Card details are handled by Stripe and never
          touch our servers.
        </li>
        <li>
          <strong>Application data:</strong> projects, prospects, organisations, outreach logs,
          response records, evaluations, and documents you create or upload through the service.
        </li>
        <li>
          <strong>Operational logs:</strong> request logs, error reports, and quota counters used
          for debugging, abuse prevention, and rate limiting.
        </li>
      </ul>
    </section>

    <section>
      <h2 class="text-base font-semibold text-text">2. How we use it</h2>
      <ul class="mt-2 list-disc pl-5 space-y-1">
        <li>Provide and operate the service, including authentication and quota enforcement.</li>
        <li>Process payments and prevent fraud (via Stripe).</li>
        <li>Send transactional email (billing receipts and service notifications).</li>
        <li>Investigate and respond to security or abuse incidents.</li>
        <li>Improve reliability and performance using aggregated, non-identifying telemetry.</li>
      </ul>
      <p class="mt-2">
        We do not sell your data. We do not use your application data to train third-party AI
        models.
      </p>
    </section>

    <section>
      <h2 class="text-base font-semibold text-text">
        3. How LeadAce accesses, uses, stores, shares, and deletes Google user data
      </h2>
      <p class="mt-2">
        LeadAce's use and transfer of information received from Google APIs to any other app will
        adhere to the
        <a
          href="https://developers.google.com/terms/api-services-user-data-policy"
          target="_blank"
          rel="noopener noreferrer"
          class="underline">Google API Services User Data Policy</a
        >, including the
        <strong>Limited Use</strong> requirements. The subsections below describe, in detail, the
        Google user data LeadAce accesses, how it is used, who else processes it, how it is
        protected, and how long it is kept.
      </p>

      <h3 class="mt-4 text-sm font-semibold text-text">3.1 Data accessed</h3>
      <p class="mt-2">
        LeadAce accesses the following Google user data, and only after you explicitly authorise
        each item on Google's consent screen.
      </p>

      <p class="mt-3 text-sm font-semibold text-text">Sign-in information</p>
      <p class="mt-2">
        When you sign in with Google, LeadAce receives the basic account profile that Google
        returns at sign-in: your account's email address, your name, your profile picture URL,
        and an OpenID Connect identifier used to establish your LeadAce session. These items
        identify your account and do <strong>not</strong> grant access to any service-specific
        Google data such as Gmail messages, Drive files, Calendar events, or Contacts.
      </p>

      <p class="mt-3 text-sm font-semibold text-text">Permission to send email from your Gmail address</p>
      <p class="mt-2">
        If you connect Gmail, LeadAce receives an authorisation that lets it send email
        <em>as you</em> via the Gmail API. This authorisation is the only Google credential
        LeadAce stores beyond your sign-in identity.
      </p>
      <p class="mt-2">
        The permission is <strong>send-only</strong>: it does not grant the ability to read, list,
        label, modify, or delete any message in your Gmail mailbox. LeadAce calls only the Gmail
        endpoint that sends a fully composed message, and does not request any broader Gmail
        permission such as inbox read access, message modification, or message metadata.
      </p>

      <h3 class="mt-4 text-sm font-semibold text-text">3.2 Data usage</h3>
      <ul class="mt-2 list-disc pl-5 space-y-1">
        <li>
          <strong>OAuth identity data</strong> is used to create and identify your LeadAce
          account, populate the "from" address shown in your outreach flow, and route session
          cookies.
        </li>
        <li>
          <strong>The Gmail refresh token</strong> is used solely to obtain short-lived access
          tokens that send outbound email composed by you, or composed at your direction by the
          LeadAce Claude Code skill, from your connected Gmail address. Every send is triggered
          by an explicit user action in the product or skill.
        </li>
        <li>
          We do <strong>not</strong> use Google user data to develop, improve, or train any
          AI / ML models, generalised or personalised.
        </li>
        <li>
          We do <strong>not</strong> use Google user data for advertising, profiling, or any
          purpose unrelated to delivering the outreach feature you have enabled.
        </li>
      </ul>

      <h3 class="mt-4 text-sm font-semibold text-text">3.3 Data sharing</h3>
      <p class="mt-2">
        We do not sell, rent, or transfer Google user data to third parties for their own
        independent use. Google user data is processed only by the sub-processors strictly
        required to run the service:
      </p>
      <ul class="mt-2 list-disc pl-5 space-y-1">
        <li>
          <strong>Supabase</strong> — hosts the Postgres database where the encrypted Gmail
          refresh token and your account identifiers are stored.
        </li>
        <li>
          <strong>Cloudflare</strong> — hosts the LeadAce application and forwards encrypted API
          requests between your browser, our backend, and Google.
        </li>
        <li>
          <strong>Anthropic</strong> — when you explicitly invoke the LeadAce Claude Code skill to
          draft or send email, the email content you and the model produce is processed by
          Anthropic under their Limited Use commitments. The Gmail OAuth refresh token itself is
          <em>never</em> transmitted to Anthropic.
        </li>
      </ul>
      <p class="mt-2">
        We do not allow human review of Google user data except (i) with your explicit consent,
        (ii) for narrowly-scoped security or abuse investigations, or (iii) where required by
        applicable law.
      </p>

      <h3 class="mt-4 text-sm font-semibold text-text">3.4 Data storage and protection</h3>
      <ul class="mt-2 list-disc pl-5 space-y-1">
        <li>
          The Gmail OAuth refresh token is encrypted at rest in our Postgres database using
          <code class="font-mono text-xs">pgp_sym_encrypt</code> (pgcrypto) with a symmetric key
          managed outside the database. The plaintext token is never logged.
        </li>
        <li>
          All transit between your browser, the LeadAce backend, our sub-processors, and Google is
          over TLS 1.2 or later.
        </li>
        <li>
          The database enforces Postgres row-level security keyed on tenant identity, so each
          account can only reach rows belonging to its own tenant.
        </li>
      </ul>

      <h3 class="mt-4 text-sm font-semibold text-text">3.5 Data retention and deletion</h3>
      <ul class="mt-2 list-disc pl-5 space-y-1">
        <li>
          The Gmail OAuth refresh token is retained only while Gmail is connected to your LeadAce
          account. You can revoke LeadAce's access at any time from
          <a
            href="https://myaccount.google.com/permissions"
            target="_blank"
            rel="noopener noreferrer"
            class="underline">Google Account → Third-party apps</a
          >; once revoked, the stored token can no longer be used to call the Gmail API and will
          be deleted on your next account interaction or within 30 days, whichever comes first.
        </li>
        <li>
          If you delete your LeadAce account, all Google user data tied to your account (refresh
          token, OAuth identity fields, derived metadata) is deleted within 30 days, along with
          the rest of your application data.
        </li>
        <li>
          To request deletion of your Google user data outside the in-product flow, email
          <a href="mailto:contact@surpassone.com" class="underline">contact@surpassone.com</a>
          from your account address. We confirm receipt within 5 business days and complete the
          deletion within 30 days.
        </li>
      </ul>
    </section>

    <section>
      <h2 class="text-base font-semibold text-text">4. Sub-processors</h2>
      <p class="mt-2">We rely on the following providers to operate the service:</p>
      <ul class="mt-2 list-disc pl-5 space-y-1">
        <li><strong>Supabase</strong> — authentication and PostgreSQL database hosting.</li>
        <li><strong>Cloudflare</strong> — application hosting, DNS, and CDN (Workers, Pages, KV).</li>
        <li><strong>Stripe</strong> — payment processing and subscription billing.</li>
        <li><strong>Anthropic</strong> — when the Claude Code plugin invokes Claude on your behalf, the inputs you provide are processed by Anthropic under their terms.</li>
      </ul>
      <p class="mt-2">
        Each sub-processor is contractually required to handle data securely and only as instructed.
      </p>
    </section>

    <section>
      <h2 class="text-base font-semibold text-text">5. Data retention</h2>
      <p class="mt-2">
        We retain account and application data for as long as your account is active. After
        account deletion, we delete or de-identify your data within 30 days, except where retention
        is required by law (e.g. tax or accounting records).
      </p>
    </section>

    <section>
      <h2 class="text-base font-semibold text-text">6. Your rights</h2>
      <p class="mt-2">
        Depending on your jurisdiction, you may have rights to access, correct, export, or delete
        your personal data, and to object to or restrict certain processing. You can delete
        individual projects from the Project settings page, and your entire account (workspace,
        all data, login) from the Account settings page. For anything else you cannot do
        in-product, contact
        <a href="mailto:contact@surpassone.com" class="underline">contact@surpassone.com</a>.
      </p>
    </section>

    <section id="cookies">
      <h2 class="text-base font-semibold text-text">7. Cookies and local storage</h2>
      <p class="mt-2">
        We use only first-party browser storage that is strictly necessary to operate the service,
        plus storage to remember preferences you have set yourself. We do not use analytics,
        advertising, or cross-site tracking technologies.
      </p>

      <h3 class="mt-4 text-sm font-semibold text-text">Strictly necessary</h3>
      <ul class="mt-2 list-disc pl-5 space-y-1">
        <li>
          <strong>Authentication tokens</strong> (set by Supabase Auth as first-party cookies whose
          names begin with <code class="font-mono text-xs">sb-</code>). Required to keep you signed
          in.
        </li>
        <li>
          <code class="font-mono text-xs">lp-next</code> — short-lived cookie (10 minutes) that
          remembers the page you were trying to reach when you started signing in, so we can return
          you there after Google authentication. Cleared automatically once you arrive.
        </li>
      </ul>

      <h3 class="mt-4 text-sm font-semibold text-text">Preferences (set by you)</h3>
      <ul class="mt-2 list-disc pl-5 space-y-1">
        <li>
          <code class="font-mono text-xs">leadace.theme</code> — your light/dark mode choice.
        </li>
        <li>
          <code class="font-mono text-xs">leadace_active_project</code> — the project currently
          selected in the sidebar.
        </li>
        <li>
          <code class="font-mono text-xs">leadace.cookie_consent</code> — records that you have
          seen this notice, so we don't show it again.
        </li>
      </ul>

      <h3 class="mt-4 text-sm font-semibold text-text">Third parties</h3>
      <p class="mt-2">
        When you are redirected to Stripe (for checkout or billing portal) or Google (for
        sign-in), those services set their own cookies under their own domains, governed by their
        respective privacy policies. The landing page and application load web fonts from Google
        Fonts, which may transmit your IP address to Google as part of that request.
      </p>

      <p class="mt-3">
        To revoke your stored preferences, clear the site data for <code class="font-mono text-xs"
          >leadace.ai</code
        > and <code class="font-mono text-xs">app.leadace.ai</code> in your browser settings.
      </p>
    </section>

    <section>
      <h2 class="text-base font-semibold text-text">8. Security</h2>
      <p class="mt-2">
        We rely on industry-standard transport encryption (TLS), database-level row-level security
        for tenant isolation, and OAuth/JWT-based authentication. No system is perfectly secure;
        please report suspected vulnerabilities to
        <a href="mailto:contact@surpassone.com" class="underline">contact@surpassone.com</a>.
      </p>
    </section>

    <section>
      <h2 class="text-base font-semibold text-text">9. International transfers</h2>
      <p class="mt-2">
        Our hosted service relies on globally distributed providers: Cloudflare for application
        hosting, edge, and DNS; Supabase for database hosting; Stripe for payment processing; and
        Anthropic for Claude Code inference. Where personal data crosses borders, we rely on the
        contractual safeguards and data processing terms offered by these sub-processors under
        their respective agreements.
      </p>
    </section>

    <section>
      <h2 class="text-base font-semibold text-text">10. Changes</h2>
      <p class="mt-2">
        We will post material changes to this policy at this URL and notify you by email or
        in-product banner before they take effect.
      </p>
    </section>

    <section>
      <h2 class="text-base font-semibold text-text">11. Contact</h2>
      <p class="mt-2">
        SurpassOne Inc.<br />
        <a href="mailto:contact@surpassone.com" class="underline">contact@surpassone.com</a>
      </p>
    </section>
  </div>
  {/if}
</div>
