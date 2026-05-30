<script lang="ts">
  import { untrack } from 'svelte';
  import type { InquiryChatMessageResult, InquiryChatTurn, InquiryLandingPayload, InquiryPrimaryReason } from '$lib/api/inquiry';
  import { renderInquiryMarkdown } from '$lib/markdown';
  import { EDITION } from '$lib/config';

  type Props = {
    landing: InquiryLandingPayload;
    mode?: 'live' | 'preview';
    // `history` is the confirmed turns; the live path ignores it, the preview path replays it.
    onSendChat?: (message: string, history: InquiryChatTurn[]) => Promise<InquiryChatMessageResult>;
    onRequestMeeting?: () => Promise<void>;
    onSignupClick?: () => Promise<void>;
    onUnsubscribe?: (reason: InquiryPrimaryReason | null) => Promise<void>;
  };

  let {
    landing,
    mode = 'live',
    onSendChat,
    onRequestMeeting,
    onSignupClick,
    onUnsubscribe,
  }: Props = $props();

  // Unsubscribe is a two-step flow: the first tap closes the session immediately
  // (CAN-SPAM/CASL — the opt-out must be honored even if the recipient closes
  // the tab before picking a chip). After the close, we still show chips so
  // they can optionally tell us why; that follow-up writes the feedback to the
  // already-closed session. `chipChosen` flips once a chip has been recorded.
  type View =
    | { kind: 'landing' }
    | { kind: 'meetingRequested' }
    | { kind: 'signupClicked' }
    | { kind: 'unsubscribed'; chipChosen: boolean };

  const isPreview = $derived(mode === 'preview');

  // Initial view derives from the server-reported session state so a
  // recipient who navigates back after closing the session (lead /
  // unsubscribed) sees the resolved screen instead of interactive
  // controls. Once the recipient acts on this page, we override `view`
  // explicitly. Preview always starts on the landing kind.
  let viewOverride = $state<View | null>(null);
  let view = $derived<View>(viewOverride ?? defaultView(landing));

  function defaultView(l: InquiryLandingPayload): View {
    if (mode === 'preview') return { kind: 'landing' };
    if (!l.session?.closed) return { kind: 'landing' };
    if (l.session.outcome === 'lead') return { kind: 'meetingRequested' };
    if (l.session.outcome === 'signup_clicked') return { kind: 'signupClicked' };
    if (l.session.outcome === 'unsubscribed') return { kind: 'unsubscribed', chipChosen: false };
    return { kind: 'landing' };
  }

  // Chat state. Initial values are read once at component mount via
  // untrack(); thereafter we update them locally from each chat response.
  const initialSession = untrack(() => landing.session);
  let chatTurns = $state<InquiryChatTurn[]>([]);
  let chatInput = $state('');
  let chatBusy = $state(false);
  let chatTurnsUsed = $state(initialSession?.chatTurnsUsed ?? 0);
  let chatTurnsMax = $state(initialSession?.chatTurnsMax ?? 5);
  let reachedTurnLimit = $state(
    (initialSession?.chatTurnsUsed ?? 0) >= (initialSession?.chatTurnsMax ?? 5),
  );

  // Action busy / error state (request-meeting + unsubscribe).
  let actionBusy = $state(false);
  let actionError = $state<string | null>(null);

  // Defense-in-depth check before injecting into an inline style attribute;
  // canonical validation is on the settings write path (zod).
  const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
  let safeBrandColor = $derived(
    landing.brandColor && HEX_COLOR.test(landing.brandColor) ? landing.brandColor : null,
  );

  // Convert YouTube watch / youtu.be / Vimeo URLs to their embed form so a
  // raw share URL pasted into AI Inquiry settings still renders as an
  // embedded player. Falls back to null when the URL doesn't match a
  // recognized pattern; the caller renders a plain link in that case.
  function videoEmbedSrc(url: string | null): string | null {
    if (!url) return null;
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase();
      if (host === 'youtu.be') {
        const id = u.pathname.replace(/^\//, '');
        return id ? `https://www.youtube.com/embed/${id}` : null;
      }
      if (
        host === 'youtube.com' ||
        host.endsWith('.youtube.com') ||
        host === 'youtube-nocookie.com' ||
        host.endsWith('.youtube-nocookie.com')
      ) {
        if (u.pathname.startsWith('/embed/')) return url;
        const v = u.searchParams.get('v');
        return v ? `https://www.youtube.com/embed/${v}` : null;
      }
      if (host === 'player.vimeo.com') return url;
      if (host === 'vimeo.com' || host.endsWith('.vimeo.com')) {
        const parts = u.pathname.split('/').filter(Boolean);
        if (parts.length === 1) return `https://player.vimeo.com/video/${parts[0]}`;
        if (parts.length === 2) return `https://player.vimeo.com/video/${parts[0]}?h=${parts[1]}`;
      }
      return null;
    } catch {
      return null;
    }
  }

  let videoSrc = $derived(videoEmbedSrc(landing.videoUrl ?? null));

  async function postChatTurn(message: string): Promise<boolean> {
    if (!onSendChat) return false;
    chatBusy = true;
    actionError = null;
    // Snapshot before the optimistic echo so the preview replays real history only.
    const history = chatTurns;
    chatTurns = [...chatTurns, { role: 'user', content: message }];
    try {
      const res = await onSendChat(message, history);
      chatTurns = [...chatTurns, { role: 'assistant', content: res.assistantMessage }];
      chatTurnsUsed = res.chatTurnsUsed;
      chatTurnsMax = res.chatTurnsMax;
      reachedTurnLimit = res.reachedTurnLimit || res.sessionClosed;
      return true;
    } catch (e) {
      // Roll back the optimistic user-message echo so the recipient can
      // retry without seeing a phantom turn.
      chatTurns = chatTurns.slice(0, -1);
      actionError = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      chatBusy = false;
    }
  }

  async function handleSendChat() {
    if (!onSendChat) return;
    const message = chatInput.trim();
    if (!message || chatBusy || reachedTurnLimit) return;
    chatInput = '';
    const sent = await postChatTurn(message);
    // Restore the input on failure so the recipient can edit and retry
    // without re-typing.
    if (!sent) chatInput = message;
  }

  async function handleFaqChip(question: string) {
    if (!onSendChat || chatBusy || reachedTurnLimit) return;
    await postChatTurn(question);
  }

  async function handleRequestMeeting() {
    if (isPreview || !onRequestMeeting || actionBusy) return;
    if (landing.cta.type !== 'meeting') return;
    // Reserve a popup synchronously in the click handler so the browser
    // treats the eventual navigation as user-initiated. We point it to the
    // scheduling URL only after the POST succeeds, so a failed record never
    // sends the recipient off-site without a server-side trace. Notify-only
    // mode (no URL) skips the popup entirely.
    //
    // Don't pass `noopener` in the features string: per the HTML spec
    // window.open returns null when noopener is set, which would leave
    // us no handle to navigate the reserved tab and the recipient would
    // see a stuck about:blank. We sever popup.opener ourselves below
    // (still same-origin while it's about:blank) before the cross-origin
    // navigation, which gives equivalent isolation.
    const schedulingUrl = landing.cta.schedulingUrl;
    const popup = schedulingUrl ? window.open('about:blank', '_blank') : null;
    actionBusy = true;
    actionError = null;
    try {
      await onRequestMeeting();
      if (schedulingUrl && popup && !popup.closed) {
        popup.opener = null;
        popup.location.href = schedulingUrl;
      }
      viewOverride = { kind: 'meetingRequested' };
    } catch (e) {
      if (popup && !popup.closed) popup.close();
      actionError = e instanceof Error ? e.message : String(e);
    } finally {
      actionBusy = false;
    }
  }

  async function handleSignupClick() {
    if (isPreview || !onSignupClick || actionBusy) return;
    if (landing.cta.type !== 'signup') return;
    // Same popup-reservation pattern as the meeting CTA — the click is the
    // user gesture, so we open the tab synchronously and only navigate it
    // once the server has recorded the signup_clicked outcome. signup mode
    // always has a URL (backend rejects null), so the popup is always
    // reserved.
    const signupUrl = landing.cta.signupUrl;
    const popup = window.open('about:blank', '_blank');
    actionBusy = true;
    actionError = null;
    try {
      await onSignupClick();
      if (popup && !popup.closed) {
        popup.opener = null;
        popup.location.href = signupUrl;
      }
      viewOverride = { kind: 'signupClicked' };
    } catch (e) {
      if (popup && !popup.closed) popup.close();
      actionError = e instanceof Error ? e.message : String(e);
    } finally {
      actionBusy = false;
    }
  }

  // Step 1: tap "Unsubscribe" → record the opt-out immediately (chip-less)
  // and flip the view. If the recipient closes the tab here, the opt-out is
  // already recorded server-side. We surface chips on the resolved screen so
  // they can still tell us why if they want to.
  async function startUnsubscribe() {
    if (isPreview || !onUnsubscribe || actionBusy) return;
    actionBusy = true;
    actionError = null;
    try {
      await onUnsubscribe(null);
      viewOverride = { kind: 'unsubscribed', chipChosen: false };
    } catch (e) {
      actionError = e instanceof Error ? e.message : String(e);
    } finally {
      actionBusy = false;
    }
  }

  // Step 2 (optional): after the opt-out is recorded, picking a chip attaches
  // feedback to the already-closed session. Backend is idempotent — first-wins.
  async function pickChip(reason: InquiryPrimaryReason) {
    if (isPreview || !onUnsubscribe || actionBusy) return;
    actionBusy = true;
    actionError = null;
    try {
      await onUnsubscribe(reason);
      viewOverride = { kind: 'unsubscribed', chipChosen: true };
    } catch (e) {
      actionError = e instanceof Error ? e.message : String(e);
    } finally {
      actionBusy = false;
    }
  }

  // Preview with no prospect selected shows the {Recipient} placeholder.
  const greeting = $derived.by(() => {
    if (landing.recipientName) return `Hi ${landing.recipientName},`;
    if (landing.recipientOrganization) return `Hi ${landing.recipientOrganization} team,`;
    if (isPreview) return 'Hi {Recipient},';
    return 'Hi there,';
  });

  // Header subtitle: "From {sender}, {role} at {company}" when all three
  // exist; falls back to subsets ({sender} at {company}, {sender}, {company},
  // or hides the row when both name and company are null). The role slot is
  // suppressed without senderName since "From, CEO at Acme" reads as broken.
  // Tenant workspace label is never substituted here (per backend spec).
  const fromLine = $derived.by<
    { who: string | null; role: string | null; where: string | null } | null
  >(() => {
    const who = landing.senderName;
    const where = landing.senderCompany;
    const role = who ? landing.senderJobTitle : null;
    if (!who && !where) return null;
    return { who, role, where };
  });

  // Body-copy display name. Used wherever copy reads as "{senderName} has
  // been notified", "{senderName}'s scheduling page", chat author label, etc.
  // Order: personal name → company → generic. Never the tenant label.
  const displayName = $derived(landing.senderName ?? landing.senderCompany ?? 'the team');

  const chips: { label: string; reason: InquiryPrimaryReason }[] = [
    { label: 'Not relevant', reason: 'not_relevant' },
    { label: 'Wrong timing', reason: 'wrong_timing' },
    { label: 'Already have it', reason: 'already_have_solution' },
    { label: 'Too expensive', reason: 'budget' },
    { label: 'Missing feature', reason: 'feature_gap' },
    { label: 'Other', reason: 'other' },
  ];
</script>

<div
  class="min-h-screen bg-page"
  class:themed={safeBrandColor}
  style:--brand={safeBrandColor ?? undefined}
>
  {#if isPreview}
    <div class="border-b border-border bg-surface px-4 py-2 text-center text-xs text-text-muted">
      Preview — this is what recipients see. Chat is live for testing; the action buttons are inert.
    </div>
  {/if}
  {#if safeBrandColor}
    <div class="h-1 w-full" style="background-color: {safeBrandColor};"></div>
  {/if}
  <div class="mx-auto max-w-2xl px-6 py-12">
    <header class="flex items-center gap-3">
      {#if landing.brandLogoUrl}
        <img
          src={landing.brandLogoUrl}
          alt=""
          class="h-7 w-7 rounded object-contain"
          loading="lazy"
        />
      {/if}
      {#if fromLine}
        <div class="flex flex-wrap items-baseline gap-x-1 text-xs tracking-wide text-text-muted">
          <span>From</span>
          {#if fromLine.who}
            <span class="font-medium text-text">{fromLine.who}{#if fromLine.role},{/if}</span>
          {/if}
          {#if fromLine.role}
            <span class="text-text">{fromLine.role}</span>
          {/if}
          {#if fromLine.who && fromLine.where}
            <span>at</span>
          {/if}
          {#if fromLine.where}
            <span class="font-medium text-text">{fromLine.where}</span>
          {/if}
        </div>
      {/if}
    </header>

    {#if view.kind === 'meetingRequested'}
      <section class="mt-8">
        <h1 class="text-2xl font-medium tracking-tight text-text">Thanks — we'll be in touch.</h1>
        {#if landing.cta.type === 'meeting' && landing.cta.schedulingUrl}
          <p class="mt-3 text-sm leading-relaxed text-text-secondary">
            We opened {displayName}'s scheduling page in a new tab. Pick a time there to
            lock in your slot — once booked, you'll get a confirmation email with the
            calendar invite directly from the scheduling tool.
          </p>
          <p class="mt-3 text-sm">
            <a
              href={landing.cta.schedulingUrl}
              target="_blank"
              rel="noopener noreferrer"
              class="brand-link text-accent underline decoration-text-muted/40 underline-offset-4 hover:text-text hover:decoration-text"
            >
              Open scheduling page ↗
            </a>
          </p>
          <p class="mt-4 text-xs text-text-muted">
            If the scheduling tab didn't open (popup blocker, etc.), just tap the link
            above — your interest is already recorded so {displayName} will follow up
            even without a booking.
          </p>
        {:else}
          <p class="mt-3 text-sm leading-relaxed text-text-secondary">
            {displayName} has been notified that you'd like to talk and will reach out
            directly — typically within 1–2 business days.
          </p>
          <p class="mt-3 text-sm leading-relaxed text-text-secondary">
            If you'd like to speed things up, replying on the original thread with a few
            times that work for you is the fastest path.
          </p>
        {/if}
      </section>
    {:else if view.kind === 'signupClicked'}
      <section class="mt-8">
        <h1 class="text-2xl font-medium tracking-tight text-text">You're all set — finish in the new tab.</h1>
        {#if landing.cta.type === 'signup'}
          <p class="mt-3 text-sm leading-relaxed text-text-secondary">
            We opened the signup page in a new tab. Complete your account there to
            start using {displayName}'s product right away — no scheduling or
            sales call needed.
          </p>
          <p class="mt-3 text-sm">
            <a
              href={landing.cta.signupUrl}
              target="_blank"
              rel="noopener noreferrer"
              class="brand-link text-accent underline decoration-text-muted/40 underline-offset-4 hover:text-text hover:decoration-text"
            >
              Open signup page ↗
            </a>
          </p>
          <p class="mt-4 text-xs text-text-muted">
            If the tab didn't open (popup blocker, etc.), just tap the link above.
          </p>
        {/if}
      </section>
    {:else if view.kind === 'unsubscribed'}
      <section class="mt-8">
        <h1 class="text-2xl font-medium tracking-tight text-text">You've been unsubscribed.</h1>
        <p class="mt-3 text-sm leading-relaxed text-text-secondary">
          We won't send you any more outreach.
        </p>
        {#if view.chipChosen}
          <p class="mt-3 text-sm leading-relaxed text-text-secondary">
            Thanks for the feedback — it helps {displayName} target better.
          </p>
        {:else}
          <p class="mt-5 text-sm text-text-secondary">
            Optional — pick the closest reason so {displayName} can do better next time.
          </p>
          <div class="mt-3 flex flex-wrap gap-2">
            {#each chips as chip}
              <button
                type="button"
                disabled={actionBusy}
                onclick={() => pickChip(chip.reason)}
                class="rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-text hover:border-text/40 transition-colors disabled:opacity-40"
              >
                {chip.label}
              </button>
            {/each}
          </div>
          {#if actionError}
            <p class="mt-3 text-xs text-danger">{actionError}</p>
          {/if}
        {/if}
      </section>
    {:else}
      <h1 class="mt-10 text-2xl font-medium tracking-tight text-text">{greeting}</h1>

      {#if landing.oneLiner}
        <p class="mt-4 text-lg leading-relaxed text-text-secondary">{landing.oneLiner}</p>
      {/if}

      {#if videoSrc}
        <div class="mt-8 aspect-video w-full overflow-hidden rounded bg-black">
          <iframe
            src={videoSrc}
            title="Intro"
            class="h-full w-full"
            loading="lazy"
            allow="autoplay; encrypted-media; picture-in-picture"
            allowfullscreen
          ></iframe>
        </div>
      {:else if landing.videoUrl}
        <a
          href={landing.videoUrl}
          target="_blank"
          rel="noopener noreferrer"
          class="brand-link mt-6 inline-flex items-center gap-1 text-sm text-text underline decoration-text-muted/40 underline-offset-4 hover:decoration-text"
        >
          Watch the intro video <span aria-hidden="true">→</span>
        </a>
      {/if}

      <div class="mt-8 flex flex-wrap items-center gap-3">
        {#if landing.cta.type === 'signup'}
          <button
            type="button"
            disabled={isPreview || actionBusy}
            onclick={handleSignupClick}
            class="brand-cta rounded-full bg-text px-5 py-2 text-sm font-medium text-page transition-colors hover:bg-text/85 disabled:opacity-40"
          >
            {actionBusy ? 'Opening…' : 'Sign up'}
          </button>
        {:else}
          <button
            type="button"
            disabled={isPreview || actionBusy}
            onclick={handleRequestMeeting}
            class="brand-cta rounded-full bg-text px-5 py-2 text-sm font-medium text-page transition-colors hover:bg-text/85 disabled:opacity-40"
          >
            {actionBusy
              ? 'Sending…'
              : landing.cta.schedulingUrl
                ? 'Book a meeting'
                : 'Request a meeting'}
          </button>
        {/if}
        {#if landing.pdfUrl}
          <a
            href={landing.pdfUrl}
            download
            target="_blank"
            rel="noopener noreferrer"
            class="brand-link text-sm text-text-secondary underline decoration-text-muted/40 underline-offset-4 hover:text-text hover:decoration-text"
          >
            Download the PDF
          </a>
        {/if}
      </div>

      {#if landing.chatEnabled}
        <section class="mt-12 border-t border-border pt-8">
          <div class="flex items-baseline justify-between">
            <h2 class="text-xs font-medium uppercase tracking-[0.12em] text-text-muted">
              Ask a question
            </h2>
            <span class="text-xs tabular-nums text-text-muted">{chatTurnsUsed} / {chatTurnsMax}</span>
          </div>

          {#if chatTurns.length === 0 && !reachedTurnLimit && landing.chatFaqSuggestions.length > 0}
            <div class="mt-4 flex flex-wrap gap-2">
              {#each landing.chatFaqSuggestions as question}
                <button
                  type="button"
                  onclick={() => void handleFaqChip(question)}
                  disabled={chatBusy || !onSendChat}
                  class="brand-chip rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-text-secondary transition-colors hover:border-text/40 hover:text-text disabled:opacity-40"
                >
                  {question}
                </button>
              {/each}
            </div>
          {/if}

          {#if chatTurns.length > 0 || chatBusy}
            <div class="mt-5 space-y-5">
              {#each chatTurns as turn, i (i)}
                <div>
                  <div class="text-[11px] uppercase tracking-[0.1em] text-text-muted">
                    {turn.role === 'user' ? 'You' : displayName}
                  </div>
                  {#if turn.role === 'user'}
                    <div class="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-text">{turn.content}</div>
                  {:else}
                    <div class="chat-md mt-1.5 text-sm leading-relaxed text-text-secondary">
                      {@html renderInquiryMarkdown(turn.content)}
                    </div>
                  {/if}
                </div>
              {/each}
              {#if chatBusy}
                <div aria-live="polite">
                  <div class="text-[11px] uppercase tracking-[0.1em] text-text-muted">
                    {displayName}
                  </div>
                  <div class="mt-2 inline-flex items-center gap-1.5 text-text-muted" aria-label="Generating response">
                    <span class="typing-dot"></span>
                    <span class="typing-dot"></span>
                    <span class="typing-dot"></span>
                  </div>
                </div>
              {/if}
            </div>
          {/if}

          {#if reachedTurnLimit}
            <p class="mt-5 text-xs text-text-muted">
              That's the chat limit. Use <strong class="text-text">Request a meeting</strong>
              above to talk to a person.
            </p>
          {:else}
            <form
              class="brand-input-form mt-5 flex items-center gap-2 border-b border-border pb-2 focus-within:border-text/60"
              onsubmit={(e) => {
                e.preventDefault();
                void handleSendChat();
              }}
            >
              <input
                type="text"
                bind:value={chatInput}
                placeholder={chatTurns.length === 0
                  ? 'e.g. Pricing? Does it support X?'
                  : 'Type your reply'}
                disabled={chatBusy || !onSendChat}
                maxlength={2000}
                class="flex-1 bg-transparent py-1 text-sm text-text placeholder:text-text-muted focus:outline-none disabled:opacity-40"
              />
              <button
                type="submit"
                disabled={chatBusy || !chatInput.trim() || !onSendChat}
                aria-label="Send"
                class="text-sm text-text-muted transition-colors hover:text-text disabled:opacity-30"
              >
                {chatBusy ? '…' : 'Send'}
              </button>
            </form>
          {/if}
        </section>
      {/if}

      {#if actionError}
        <p class="mt-4 text-xs text-danger">{actionError}</p>
      {/if}

      <div class="mt-16 text-right">
        <button
          type="button"
          disabled={isPreview || actionBusy}
          onclick={startUnsubscribe}
          class="text-xs text-text-muted underline decoration-text-muted/30 underline-offset-4 hover:text-text hover:decoration-text disabled:opacity-40"
        >
          {actionBusy ? 'Unsubscribing…' : "Don't want these? Unsubscribe"}
        </button>
      </div>
    {/if}

    <footer class="mt-12 flex items-center justify-between gap-3 border-t border-border pt-4 text-[11px] tracking-wide text-text-muted">
      <span>
        Powered by <a href="https://leadace.ai" target="_blank" rel="noopener noreferrer" class="underline decoration-text-muted/30 underline-offset-4 hover:text-text hover:decoration-text">LeadAce</a>
      </span>
      {#if EDITION === 'cloud'}
        <a
          href="/privacy"
          target="_blank"
          rel="noopener"
          class="underline decoration-text-muted/30 underline-offset-4 hover:text-text hover:decoration-text"
        >
          Privacy
        </a>
      {/if}
    </footer>
  </div>
</div>

<style>
  /* Brand color theming. `--brand` is set inline on the root when the
     project has a valid #RRRRRR brand color; the `.themed` toggle gates
     the rules below so an unthemed page keeps its neutral defaults. We
     keep brand color out of body copy and opt-out controls — only
     interactive accents (CTA fill, link decorations on hover, FAQ chip
     focus, chat input focus) pick it up. No contrast switching: the
     brand-color → white-text choice on the CTA assumes saturated brand
     colors (the only realistic input from a settings hex picker). */
  .themed .brand-cta {
    background-color: var(--brand);
    color: #fff;
    transition: filter 0.15s ease;
  }
  .themed .brand-cta:hover:not(:disabled) {
    background-color: var(--brand);
    filter: brightness(0.92);
  }
  .themed .brand-link:hover {
    color: var(--brand);
    text-decoration-color: var(--brand);
  }
  .themed .brand-chip:hover:not(:disabled),
  .themed .brand-chip:focus-visible:not(:disabled) {
    border-color: var(--brand);
  }
  .themed .brand-input-form:focus-within {
    border-color: var(--brand);
  }

  /* Markdown subset emitted by renderInquiryMarkdown — bold, italic, lists.
     Tailwind's preflight strips list markers globally, so we re-add the
     minimum needed for assistant replies to read correctly. Scoped via
     :global(...) because the HTML comes in via {@html}. */
  .chat-md :global(p) {
    margin: 0;
  }
  .chat-md :global(p + p),
  .chat-md :global(p + ul),
  .chat-md :global(p + ol),
  .chat-md :global(ul + p),
  .chat-md :global(ol + p) {
    margin-top: 0.5rem;
  }
  .chat-md :global(ul) {
    list-style: disc;
    padding-left: 1.25rem;
    margin: 0.25rem 0 0 0;
  }
  .chat-md :global(ol) {
    list-style: decimal;
    padding-left: 1.5rem;
    margin: 0.25rem 0 0 0;
  }
  .chat-md :global(li) {
    margin: 0.125rem 0;
  }
  .chat-md :global(strong) {
    font-weight: 600;
    color: var(--color-text, currentColor);
  }
  .chat-md :global(em) {
    font-style: italic;
  }

  .typing-dot {
    width: 0.375rem;
    height: 0.375rem;
    border-radius: 9999px;
    background: currentColor;
    opacity: 0.4;
    animation: typing-bounce 1.2s infinite ease-in-out;
  }
  .typing-dot:nth-child(2) {
    animation-delay: 0.15s;
  }
  .typing-dot:nth-child(3) {
    animation-delay: 0.3s;
  }
  @keyframes typing-bounce {
    0%, 80%, 100% {
      transform: translateY(0);
      opacity: 0.3;
    }
    40% {
      transform: translateY(-3px);
      opacity: 0.9;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .typing-dot {
      animation: none;
      opacity: 0.5;
    }
  }
</style>
