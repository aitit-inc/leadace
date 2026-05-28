<script lang="ts">
  import Logo from '$lib/components/Logo.svelte';
  import { EDITION } from '$lib/config';
  const lastUpdated = '2026-05-07';
</script>

<svelte:head>
  <title>Terms of Service · LeadAce</title>
</svelte:head>

<div class="mx-auto max-w-2xl px-6 py-12">
  <a href="/" class="inline-flex items-center gap-1.5 text-xs text-text-muted hover:text-text">
    <Logo size={14} class="text-accent" />
    ← LeadAce
  </a>
  <h1 class="mt-4 text-2xl font-semibold text-text">Terms of Service</h1>
  <p class="mt-1 text-xs text-text-muted">Last updated: {lastUpdated}</p>

  {#if EDITION !== 'cloud'}
    <div class="mt-8 space-y-4 text-sm leading-relaxed text-text-secondary">
      <p>
        The terms below apply only to the LeadAce SaaS offered by SurpassOne Inc. at
        <a href="https://leadace.ai" target="_blank" rel="noopener noreferrer" class="underline"
          >leadace.ai</a
        >. This deployment is a self-hosted build of the LeadAce open-source project, operated by
        someone other than SurpassOne Inc.
      </p>
      <p>
        Your use of this instance is governed by whatever terms the operator running it provides,
        not by SurpassOne's terms. Please contact the operator of this site for their terms of
        service, acceptable use, and support policy.
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
      These Terms of Service ("<strong>Terms</strong>") govern your use of LeadAce, a sales
      automation product offered by SurpassOne Inc. ("<strong>we</strong>",
      "<strong>us</strong>"). By creating an account or otherwise using LeadAce, you agree to
      these Terms.
    </p>

    <section>
      <h2 class="text-base font-semibold text-text">1. Service</h2>
      <p class="mt-2">
        LeadAce is a Claude Code plugin and supporting cloud service for managing outbound sales
        activities. Features and limits depend on the plan you select. We may change, suspend, or
        discontinue features at any time.
      </p>
      <p class="mt-2">
        <strong>Public Beta.</strong> The hosted service is currently in public beta. Features
        may change, become temporarily unavailable, or contain bugs; we do not warrant a specific
        uptime, data persistence, or backward compatibility. These limitations apply to the
        LeadAce-hosted service only — the same code is available as an open-source build on
        <a href="https://github.com/aitit-inc/leadace" target="_blank" rel="noopener noreferrer" class="underline">GitHub</a>
        for operators who prefer to self-host.
      </p>
    </section>

    <section>
      <h2 class="text-base font-semibold text-text">2. Account</h2>
      <p class="mt-2">
        You are responsible for the credentials used to access your account and for all activity
        that occurs under it. Notify us immediately at
        <a href="mailto:contact@surpassone.com" class="underline">contact@surpassone.com</a>
        if you suspect unauthorised use.
      </p>
    </section>

    <section>
      <h2 class="text-base font-semibold text-text">3. Acceptable Use</h2>
      <p class="mt-2">You agree not to use LeadAce to:</p>
      <ul class="mt-2 list-disc pl-5 space-y-1">
        <li>send unsolicited commercial messages in violation of applicable anti-spam laws (e.g. CAN-SPAM, GDPR, CASL, the Spam Act, 特定電子メール法);</li>
        <li>send to recipients outside the countries we currently support (United States, Canada, Japan); see the <a href="/compliance" class="underline">compliance</a> page for the current scope;</li>
        <li>impersonate any person or entity, or misrepresent your affiliation;</li>
        <li>upload data you do not have rights to use;</li>
        <li>circumvent rate limits, quotas, or security controls;</li>
        <li>reverse engineer, resell, or sublicense the service except as expressly permitted.</li>
      </ul>
      <p class="mt-2">
        You remain solely responsible for the content of any messages or contact data you generate
        or send through LeadAce.
      </p>
    </section>

    <section>
      <h2 class="text-base font-semibold text-text">4. Subscriptions and Billing</h2>
      <p class="mt-2">
        Paid plans are billed in advance through Stripe at the price listed at sign-up. Charges
        recur on the same cadence (monthly or yearly) until you cancel. You can manage or cancel
        your subscription at any time from the Plans page; cancellations take effect at the end
        of the current billing period.
      </p>
      <p class="mt-2">
        <strong>Refunds.</strong> Except where required by law, fees are non-refundable. You can
        cancel any time from the dashboard; access continues through the end of the paid period
        and the subscription does not renew thereafter. We do not pro-rate or refund mid-period
        cancellations.
      </p>
      <p class="mt-2">
        The Free tier provides limited usage on a one-time basis (lifetime quota); it is not
        renewed monthly.
      </p>
    </section>

    <section>
      <h2 class="text-base font-semibold text-text">5. Termination</h2>
      <p class="mt-2">
        You may stop using the service at any time. We may suspend or terminate accounts that
        violate these Terms or that pose a security or legal risk. On termination, your right to
        use the service ends immediately; we may delete associated data after a reasonable wind-down
        period.
      </p>
    </section>

    <section>
      <h2 class="text-base font-semibold text-text">6. Disclaimers</h2>
      <p class="mt-2">
        LeadAce is provided "AS IS" without warranties of any kind, express or implied, including
        merchantability, fitness for a particular purpose, and non-infringement. We do not warrant
        that the service will be uninterrupted or error-free, or that AI-generated content will be
        accurate or appropriate for your specific use.
      </p>
    </section>

    <section>
      <h2 class="text-base font-semibold text-text">7. Limitation of Liability</h2>
      <p class="mt-2">
        To the maximum extent permitted by law, our aggregate liability arising out of or relating
        to the service is limited to the fees you paid for the service in the twelve (12) months
        preceding the event giving rise to the claim. We are not liable for indirect, incidental,
        special, consequential, or punitive damages, including lost profits or revenue.
      </p>
    </section>

    <section>
      <h2 class="text-base font-semibold text-text">8. Governing Law</h2>
      <p class="mt-2">
        These Terms are governed by the laws of Japan. Any dispute arising out of or in connection
        with these Terms is subject to the exclusive jurisdiction of the Tokyo District Court.
      </p>
    </section>

    <section>
      <h2 class="text-base font-semibold text-text">9. Changes</h2>
      <p class="mt-2">
        We may update these Terms from time to time. Material changes will be communicated via
        email or in-product notice at least 14 days before they take effect. Continued use after
        the effective date constitutes acceptance.
      </p>
    </section>

    <section>
      <h2 class="text-base font-semibold text-text">10. Contact</h2>
      <p class="mt-2">
        SurpassOne Inc.<br />
        <a href="mailto:contact@surpassone.com" class="underline">contact@surpassone.com</a>
      </p>
    </section>
  </div>
  {/if}
</div>
