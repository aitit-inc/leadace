<script lang="ts">
  import { Mic } from '@lucide/svelte';
  import { onMount } from 'svelte';
  import { createRecognizer, type SpeechRecognizer } from '$lib/speech';

  let {
    listening = $bindable(false),
    ontranscript,
    onerror,
  }: {
    listening?: boolean;
    ontranscript: (text: string) => void;
    onerror: (message: string) => void;
  } = $props();

  let recognizer = $state.raw<SpeechRecognizer | null>(null);
  let running = false;

  onMount(() => {
    const r = createRecognizer();
    if (!r) return;
    r.continuous = true;
    // The app is served as lang="en"; dictation follows the browser's language.
    r.lang = navigator.language;
    r.onresult = (event) => {
      const said: string[] = [];
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results.item(i);
        if (result.isFinal) said.push(result.item(0).transcript.trim());
      }
      const text = said.filter(Boolean).join(' ');
      if (text) ontranscript(text);
    };
    r.onerror = (event) => {
      // Blocked by the browser or by the machine: trying again cannot help.
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        onerror('Allow microphone access in your browser to dictate.');
      } else if (event.error !== 'no-speech' && event.error !== 'aborted') {
        onerror('Dictation stopped. Please try again.');
      }
    };
    // The engine also ends on its own after a pause, so the button follows it.
    r.onend = () => {
      running = false;
      listening = false;
    };
    recognizer = r;
    return () => {
      r.onend = null;
      r.abort();
    };
  });

  $effect(() => {
    const r = recognizer;
    if (!r) return;
    if (listening && !running) {
      try {
        r.start();
        running = true;
      } catch {
        listening = false;
      }
    } else if (!listening && running) {
      r.stop();
    }
  });
</script>

{#if recognizer}
  <button
    type="button"
    onclick={() => (listening = !listening)}
    aria-label={listening ? 'Stop dictation' : 'Dictate'}
    aria-pressed={listening}
    title={listening ? 'Stop dictation' : 'Dictate instead of typing'}
    class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors {listening
      ? 'bg-surface-2 text-accent-strong'
      : 'text-text-muted hover:bg-surface-2 hover:text-text'}"
  >
    <Mic size={18} class={listening ? 'animate-pulse' : ''} />
  </button>
{/if}
