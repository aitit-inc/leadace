<script lang="ts">
  import { page } from '$app/state';
  import Logo from '$lib/components/Logo.svelte';
  import { confirmUnsubscribe } from '$lib/api/unsubscribe';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  type View =
    | { kind: 'ready'; email: string; organizationName: string; alreadyUnsubscribed: boolean }
    | { kind: 'invalid'; message: string }
    | { kind: 'done' };

  // overrideView (post-submit / error) wins over loader data.
  let overrideView = $state<View | null>(null);
  let view = $derived<View>(
    overrideView ??
      (data.result.kind === 'ready'
        ? {
            kind: 'ready',
            email: data.result.info.email,
            organizationName: data.result.info.organizationName,
            alreadyUnsubscribed: data.result.info.alreadyUnsubscribed,
          }
        : { kind: 'invalid', message: data.result.message }),
  );
  let submitting = $state(false);

  // Client-side navigation between two /unsubscribe/[token] URLs reuses this
  // component instance, so a stale `done` / `invalid` overlay from the prior
  // token would otherwise carry over to the new one.
  $effect(() => {
    page.params.token;
    overrideView = null;
  });

  function errorMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  async function confirm() {
    const token = page.params.token;
    if (!token || submitting) return;
    submitting = true;
    try {
      await confirmUnsubscribe(token);
      overrideView = { kind: 'done' };
    } catch (e) {
      overrideView = { kind: 'invalid', message: errorMessage(e) };
    } finally {
      submitting = false;
    }
  }
</script>

<svelte:head>
  <title>Unsubscribe · LeadAce</title>
</svelte:head>

<div class="mx-auto max-w-md px-6 py-12">
  <a href="/" class="inline-flex items-center gap-1.5 text-xs text-text-muted hover:text-text">
    <Logo size={14} class="text-accent" />
    ← LeadAce
  </a>
  <h1 class="mt-4 text-2xl font-semibold text-text">Unsubscribe</h1>

  <div class="mt-8 text-sm leading-relaxed text-text-secondary">
    {#if view.kind === 'invalid'}
      <p class="text-danger">{view.message}</p>
      <p class="mt-3 text-xs text-text-muted">
        If you got here from one of our emails and the link is broken, reply to that email
        and we'll remove you manually.
      </p>
    {:else if view.kind === 'done'}
      <p>You've been unsubscribed. We won't send you any more outreach emails.</p>
    {:else if view.kind === 'ready' && view.alreadyUnsubscribed}
      <p>
        <span class="font-mono">{view.email}</span> is already unsubscribed from
        {view.organizationName ? view.organizationName : 'this sender'}. No further action
        needed.
      </p>
    {:else if view.kind === 'ready'}
      <p>
        Click below to unsubscribe <span class="font-mono">{view.email}</span> from
        {view.organizationName ? view.organizationName : 'this sender'}. We won't send you any
        more outreach emails.
      </p>
      <div class="mt-6 flex gap-2">
        <button
          type="button"
          disabled={submitting}
          onclick={confirm}
          class="rounded bg-text px-4 py-2 text-xs font-medium text-page hover:bg-text/90 transition-colors disabled:opacity-40"
        >
          {submitting ? 'Unsubscribing…' : 'Unsubscribe'}
        </button>
      </div>
    {/if}
  </div>
</div>
