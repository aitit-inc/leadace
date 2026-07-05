<script lang="ts">
  import { page } from '$app/state';
  import Logo from '$lib/components/Logo.svelte';
  import { confirmUnsubscribe } from '$lib/api/unsubscribe';
  import { browserLocale } from '$lib/browser-locale';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  // Switched after mount so SSR ('en') and hydration render the same DOM.
  let ja = $state(false);
  $effect(() => {
    ja = browserLocale() === 'ja';
  });

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
  <h1 class="mt-4 text-2xl font-semibold text-text">{ja ? '配信停止' : 'Unsubscribe'}</h1>

  <div class="mt-8 text-sm leading-relaxed text-text-secondary">
    {#if view.kind === 'invalid'}
      <p class="text-danger">{view.message}</p>
      <p class="mt-3 text-xs text-text-muted">
        If you got here from one of our emails and the link is broken, reply to that email
        and we'll remove you manually.
      </p>
    {:else if view.kind === 'done'}
      <p>
        {ja
          ? '配信を停止しました。今後、ご連絡メールをお送りすることはありません。'
          : "You've been unsubscribed. We won't send you any more outreach emails."}
      </p>
    {:else if view.kind === 'ready' && view.alreadyUnsubscribed}
      {@const sender = view.organizationName ? view.organizationName : ja ? 'この送信者' : 'this sender'}
      {#if ja}
        <p>
          <span class="font-mono">{view.email}</span> は {sender} の配信からすでに停止されています。これ以上の操作は不要です。
        </p>
      {:else}
        <p>
          <span class="font-mono">{view.email}</span> is already unsubscribed from
          {sender}. No further action needed.
        </p>
      {/if}
    {:else if view.kind === 'ready'}
      {@const sender = view.organizationName ? view.organizationName : ja ? 'この送信者' : 'this sender'}
      {#if ja}
        <p>
          下のボタンをクリックすると、<span class="font-mono">{view.email}</span> を {sender} の配信から停止します。今後、ご連絡メールをお送りすることはありません。
        </p>
      {:else}
        <p>
          Click below to unsubscribe <span class="font-mono">{view.email}</span> from
          {sender}. We won't send you any more outreach emails.
        </p>
      {/if}
      <div class="mt-6 flex gap-2">
        <button
          type="button"
          disabled={submitting}
          onclick={confirm}
          class="rounded bg-text px-4 py-2 text-xs font-medium text-page hover:bg-text/90 transition-colors disabled:opacity-40"
        >
          {submitting ? (ja ? '停止しています…' : 'Unsubscribing…') : ja ? '配信を停止' : 'Unsubscribe'}
        </button>
      </div>
    {/if}
  </div>
</div>
