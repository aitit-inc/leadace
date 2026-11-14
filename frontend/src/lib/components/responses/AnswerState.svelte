<script lang="ts">
  import { ApiError } from '$lib/api';
  import { markResponseAnswered, saveAnswer, sendAnswer } from '$lib/api/responses';
  import type { ResponseRecord } from '$lib/types/responses';
  import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';

  let {
    response,
    token,
    onChanged,
  }: { response: Pick<ResponseRecord, 'id' | 'answer' | 'answerEmail'>; token: string | undefined; onChanged: () => void } = $props();

  // A refresh after another reply's answer changed hands every reply a new
  // object: only a change of this answer's stored text may replace what is typed.
  const stored = $derived(response.answerEmail?.body ?? '');
  let body = $state('');
  $effect.pre(() => {
    body = stored;
  });

  let busy = $state(false);
  let error = $state<string | null>(null);
  let confirming = $state(false);

  const email = $derived(response.answerEmail);
  const dirty = $derived(email !== null && body !== stored);

  function message(e: unknown): string {
    return e instanceof ApiError ? e.detail || e.message : 'Could not save. Please try again.';
  }

  async function run(action: () => Promise<unknown>) {
    busy = true;
    error = null;
    try {
      await action();
      onChanged();
    } catch (e) {
      error = message(e);
    } finally {
      busy = false;
    }
  }

  const save = () => saveAnswer(response.id, { body }, fetch, token);
  const markAnswered = () => run(() => markResponseAnswered(response.id, fetch, token));

  async function send() {
    try {
      await sendAnswer(response.id, body, fetch, token);
    } catch (e) {
      throw new Error(message(e));
    }
    confirming = false;
    onChanged();
  }
</script>

{#if response.answer !== 'none' && email?.status !== 'sent'}
  <div class="mt-3 space-y-3">
    {#if response.answer === 'waiting' && email}
      <p class="text-sm text-text-secondary">
        Ace drafted an answer. It goes to {email.to}{email.from ? ` from ${email.from}` : ''}, in the reply's thread.
      </p>
      <textarea bind:value={body} rows="10" class="field resize-y leading-relaxed" aria-label="Answer"></textarea>
      <p class="text-xs text-text-muted">The legal footer is added when it is sent. Fill in anything in {'{ }'} first.</p>
      {#if email.status === 'sending'}<p class="text-sm text-text-secondary">Being sent.</p>{/if}
      <div class="flex flex-wrap items-center gap-2">
        <button class="btn btn-primary btn-sm" disabled={busy || email.status !== 'draft' || !body.trim()} onclick={() => (confirming = true)}>
          Send
        </button>
        <button class="btn btn-secondary btn-sm" disabled={busy || !dirty || !body.trim()} onclick={() => run(save)}>Save</button>
        <button class="btn btn-ghost btn-sm" disabled={busy} onclick={markAnswered}>Mark answered</button>
      </div>
    {:else if response.answer === 'waiting'}
      <div class="flex flex-wrap items-center gap-3">
        <p class="text-sm text-text-secondary">
          Waiting for your answer. A reply in its Gmail thread clears it within the hour; answered another way? Mark it.
        </p>
        <button class="btn btn-secondary btn-sm" disabled={busy} onclick={markAnswered}>Mark answered</button>
      </div>
    {:else}
      <p class="text-sm text-text-secondary">Answered.</p>
    {/if}
    {#if error}<p class="text-sm text-danger" role="alert">{error}</p>{/if}
  </div>
{/if}

{#if confirming && email}
  <ConfirmDialog
    title="Send this answer?"
    message={`It goes to ${email.to}${email.from ? ` from ${email.from}` : ''}, in the reply's thread. Sent email cannot be recalled.`}
    confirmLabel="Send"
    onconfirm={send}
    oncancel={() => (confirming = false)}
  />
{/if}
