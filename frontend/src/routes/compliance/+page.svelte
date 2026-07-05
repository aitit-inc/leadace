<script lang="ts">
  import Logo from '$lib/components/Logo.svelte';
  import { EDITION } from '$lib/config';
  const lastUpdated = '2026-05-07';
</script>

<svelte:head>
  <title>Compliance · LeadAce</title>
</svelte:head>

<div class="mx-auto max-w-2xl px-6 py-12">
  <a href="/" class="inline-flex items-center gap-1.5 text-xs text-text-muted hover:text-text">
    <Logo size={14} class="text-accent" />
    ← LeadAce
  </a>
  <h1 class="mt-4 text-2xl font-semibold text-text">Compliance</h1>
  <p class="mt-1 text-xs text-text-muted">Last updated: {lastUpdated}</p>

  <div class="mt-8 space-y-6 text-sm leading-relaxed text-text-secondary">
    {#if EDITION !== 'cloud'}
      <p class="rounded border border-border bg-surface p-3 text-xs">
        This page describes what the LeadAce code enforces server-side. The operator running this
        self-hosted instance — not SurpassOne Inc. — is the controller for any personal data
        handled here and your point of contact for compliance complaints, abuse reports, and
        data-subject requests. See §8 for the contact route.
      </p>
    {/if}
    <p>
      LeadAce ships compliance defaults that try to keep B2B cold-outreach sends within bounds.
      This page describes what we enforce server-side, what we leave to the workspace operator,
      and how to reach us about a complaint or data-subject request.
    </p>

    <section>
      <h2 class="text-base font-semibold text-text">1. Supported send-target countries (v1.0)</h2>
      <p class="mt-2">
        Outbound send paths currently allow recipients in the United States, Canada, and Japan.
        Other jurisdictions are blocked at send time with HTTP 422; a recipient with no country
        recorded surfaces a warning but is not blocked. UK, AU, and EU support is on the v1.x
        roadmap and depends on per-country footer / consent rules we have not finished
        implementing.
      </p>
      <table class="mt-3 w-full border-collapse text-xs">
        <thead>
          <tr class="border-b border-border text-text">
            <th class="py-2 text-left font-medium">Jurisdiction</th>
            <th class="py-2 text-left font-medium">Status</th>
            <th class="py-2 text-left font-medium">Notes</th>
          </tr>
        </thead>
        <tbody class="text-text-muted">
          <tr class="border-b border-border">
            <td class="py-2">US (CAN-SPAM)</td>
            <td class="py-2">Supported</td>
            <td class="py-2">Default footer carries legal name + physical address + unsubscribe (§4).</td>
          </tr>
          <tr class="border-b border-border">
            <td class="py-2">CA (CASL)</td>
            <td class="py-2">Supported</td>
            <td class="py-2">B2B conspicuous-publication operational stance (see §3).</td>
          </tr>
          <tr class="border-b border-border">
            <td class="py-2">JP (特定電子メール法 / 特商法)</td>
            <td class="py-2">Supported</td>
            <td class="py-2">
              Sender identity + opt-out are carried in the same footer block by default (§4).{#if EDITION === 'cloud'}
                特商法 disclosure on <a href="/legal" class="underline">/legal</a>.{/if}
            </td>
          </tr>
          <tr class="border-b border-border">
            <td class="py-2">UK (PECR + UK GDPR)</td>
            <td class="py-2">Roadmap (v1.1)</td>
            <td class="py-2">Requires LIA documentation + Article 14 transparency.</td>
          </tr>
          <tr class="border-b border-border">
            <td class="py-2">AU (Spam Act)</td>
            <td class="py-2">Roadmap (v1.2+)</td>
            <td class="py-2">ABN registration constraints for non-AU senders.</td>
          </tr>
          <tr>
            <td class="py-2">EU / others</td>
            <td class="py-2">Not supported</td>
            <td class="py-2">Send blocked.</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section>
      <h2 class="text-base font-semibold text-text">2. Required workspace identity</h2>
      <p class="mt-2">
        Each workspace must set the following before any outbound send is allowed:
      </p>
      <ul class="mt-2 list-disc pl-5 space-y-1">
        <li><strong>Legal name</strong> — the registered company entity.</li>
        <li>
          <strong>Physical mailing address</strong> — CAN-SPAM §5(a)(5) requires a USPS-deliverable
          address (street address, registered PO Box, or CMRA-registered private mailbox).
        </li>
        <li>
          <strong>Default sender country</strong> — ISO 3166-1 alpha-2. Determines which
          country-specific footer rules are applied as those ship.
        </li>
      </ul>
      <p class="mt-2">
        The contact email is optional but strongly recommended; it is the route surfaced
        on this page for inbound requests.
      </p>
      <p class="mt-2">
        These fields are configured per workspace under{' '}
        <a href="/workspace-settings" class="underline">Workspace settings</a>.
      </p>
    </section>

    <section>
      <h2 class="text-base font-semibold text-text">3. CASL operational stance</h2>
      <p class="mt-2">
        Canadian recipients are reached only when one of the following applies:
      </p>
      <ul class="mt-2 list-disc pl-5 space-y-1">
        <li>
          <strong>Conspicuous publication</strong> (CRTC FAQ): the recipient's business email is
          publicly listed without a "do not solicit" notice, and the message is relevant to that
          recipient's business role.
        </li>
        <li>
          <strong>Existing business relationship</strong> between the workspace operator and the
          recipient's organisation.
        </li>
        <li>
          <strong>Express consent</strong> on file.
        </li>
      </ul>
      <p class="mt-2">
        We do not currently store a per-prospect consent basis column; the workspace operator is
        responsible for sourcing prospects through public B2B channels. Per-prospect consent
        records ship in a future release.
      </p>
    </section>

    <section>
      <h2 class="text-base font-semibold text-text">4. Send-time footer</h2>
      <p class="mt-2">
        Every outbound message — email, web form, or social DM — has a footer appended
        server-side at send time; the append step cannot be skipped. By default the footer
        is the following block. A workspace may replace the footer text per project; as
        the sender of record, the operator is then responsible for keeping the required
        sender identity, postal address, and opt-out mechanism in it.
      </p>
      <pre class="mt-3 rounded border border-border bg-surface p-3 text-xs text-text overflow-x-auto"><code
          >---
&lt;Legal name&gt;
&lt;Physical address&gt;
To unsubscribe, reply to this email with "unsubscribe".</code></pre>
      <p class="mt-2">
        Cold email is link-free by default: the opt-out is a reply instruction, honored
        server-side — a genuine reply asking to unsubscribe suppresses further contact.
        When a workspace opts into the inquiry landing page, that reply line is replaced
        by a link to the page, which carries its own opt-out.
      </p>
      <p class="mt-2">
        The RFC 8058
        <code class="font-mono text-xs">List-Unsubscribe</code> /
        <code class="font-mono text-xs">List-Unsubscribe-Post: List-Unsubscribe=One-Click</code>
        headers are available as a per-project option (off by default). Gmail and
        Yahoo require one-click unsubscribe headers only of bulk senders (roughly
        5,000+ messages per day); LeadAce's per-mailbox warmup caps keep sending
        volume far below that threshold. When enabled, the one-click endpoint
        ratchets the prospect's
        <code class="font-mono text-xs">do_not_contact</code> flag; unsubscribe
        links in previously sent mail remain valid either way.
      </p>
    </section>

    <section>
      <h2 class="text-base font-semibold text-text">5. Unsubscribe and suppression</h2>
      <p class="mt-2">
        An unsubscribe is processed immediately and ratchets the prospect's
        <code class="font-mono text-xs">do_not_contact</code> flag on permanently — it does not
        reset on re-import or workspace edits. CAN-SPAM allows up to 10 business days; we process
        within seconds. Following ICO guidance, the prospect record itself stays in place — the
        flag is what suppresses future contact, and removing the record would let the same
        identity slip back into a fresh import.
      </p>
    </section>

    <section>
      <h2 class="text-base font-semibold text-text">6. GDPR Article 17 erasure</h2>
      {#if EDITION === 'cloud'}
        <p class="mt-2">
          <strong>Your own account:</strong> use Delete account on the Account settings page.
          Erasure is immediate — your workspace, every project in it, all prospect / outreach /
          response data, Gmail authorization, and your login are removed. Any active paid
          subscription is cancelled at the same time (no prorated refund). MCP client tokens
          you previously issued remain valid for up to 30 days; revoke them by disconnecting
          LeadAce from each MCP client (automated MCP revocation is on the v1.1 roadmap).
        </p>
        <p class="mt-2">
          <strong>A prospect's record in your workspace:</strong> email
          <a href="mailto:privacy@leadace.ai" class="underline">privacy@leadace.ai</a>
          with the prospect's email address and we will pseudonymise the record (free-text PII set
          to NULL, structured DNC keys retained per Article 17(3)(b) and 6(1)(f) so the prospect
          cannot re-enter the funnel via a future import).
        </p>
        <p class="mt-2">
          Self-host operators handle prospect-record erasure on their own database directly; an
          automated pipeline is on the v1.1 roadmap.
        </p>
      {:else}
        <p class="mt-2">
          Erasure on this self-hosted instance is the operator's responsibility — contact the
          operator running this site (see §8) to exercise erasure rights. SurpassOne Inc. is not
          the controller for data handled by this deployment.
        </p>
      {/if}
    </section>

    <section>
      <h2 class="text-base font-semibold text-text">7. Self-host responsibility</h2>
      <p class="mt-2">
        LeadAce is open source. Operators running their own deployment inherit responsibility for
        the workspace identity fields, the sender domain's authentication (SPF / DKIM / DMARC),
        the mailbox the unsubscribe email is addressed to, and the legal regime applicable to
        their sender country and recipient list. This page does not constitute legal advice.
      </p>
    </section>

    <section>
      <h2 class="text-base font-semibold text-text">8. Contact</h2>
      {#if EDITION === 'cloud'}
        <p class="mt-2">
          Compliance complaints, abuse reports, and data-subject requests:
          <a href="mailto:privacy@leadace.ai" class="underline">privacy@leadace.ai</a>.
        </p>
      {:else}
        <p class="mt-2">
          Compliance complaints, abuse reports, and data-subject requests should be sent to the
          operator running this LeadAce instance. SurpassOne Inc. is not the controller for data
          handled by this deployment.
        </p>
      {/if}
    </section>
  </div>
</div>
