<script lang="ts">
  import { theme, type ThemeChoice } from '$lib/stores/theme';
  import { Monitor, Sun, Moon } from '@lucide/svelte';
  import type { Component } from 'svelte';

  const options: { value: ThemeChoice; label: string; icon: Component }[] = [
    { value: 'system', label: 'System', icon: Monitor },
    { value: 'light', label: 'Light', icon: Sun },
    { value: 'dark', label: 'Dark', icon: Moon },
  ];
</script>

<div
  class="inline-flex rounded border border-border bg-surface p-0.5 text-text-muted"
  role="group"
  aria-label="Theme"
>
  {#each options as opt}
    {@const Icon = opt.icon}
    <button
      type="button"
      onclick={() => theme.setChoice(opt.value)}
      aria-pressed={$theme === opt.value}
      title={opt.label}
      class="flex items-center justify-center rounded px-1.5 py-0.5 transition-colors {$theme ===
      opt.value
        ? 'bg-page text-text'
        : 'hover:text-text'}"
    >
      <Icon size={14} aria-hidden="true" />
      <span class="sr-only">{opt.label}</span>
    </button>
  {/each}
</div>
