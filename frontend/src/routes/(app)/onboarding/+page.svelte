<script lang="ts">
	import { goto, invalidate } from '$app/navigation';
	import { Check, Copy } from '@lucide/svelte';

	const installCmds = [
		'/plugin marketplace add aitit-inc/leadace',
		'/plugin install leadace@leadace',
		'/reload-plugins',
	];
	const setupCmd = '/leadace https://your-company.com';

	let copied = $state<string | null>(null);
	let checking = $state(false);
	let notDetected = $state(false);

	async function copy(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			copied = text;
			setTimeout(() => {
				if (copied === text) copied = null;
			}, 1500);
		} catch {
			// Clipboard unavailable (insecure context / permission denied) — no-op.
		}
	}

	async function recheck() {
		checking = true;
		notDetected = false;
		// If now connected, the rerun's load redirects away before the lines below run.
		await invalidate('app:onboarding');
		checking = false;
		notDetected = true;
	}
</script>

<svelte:head>
	<title>Get started · LeadAce</title>
</svelte:head>

{#snippet copyRow(cmd: string)}
	<div class="flex items-center gap-2">
		<code class="min-w-0 flex-1 truncate rounded bg-surface px-3 py-1.5 font-mono text-xs text-text"
			>{cmd}</code
		>
		<button
			type="button"
			onclick={() => copy(cmd)}
			class="shrink-0 rounded border border-border bg-page px-2 py-1.5 text-xs text-text hover:bg-surface"
			aria-label={`Copy command: ${cmd}`}
		>
			{#if copied === cmd}
				<Check size={14} class="text-accent" />
			{:else}
				<Copy size={14} />
			{/if}
		</button>
	</div>
{/snippet}

<div class="mx-auto max-w-2xl py-2">
	<h2 class="text-lg font-semibold text-text">Connect the LeadAce plugin</h2>
	<p class="mt-1 text-sm text-text-muted">
		LeadAce runs from Claude Code. This dashboard shows your prospects, drafts, and replies — the
		plugin does the research, writing, and sending. Two commands and you're set.
	</p>

	<ol class="mt-8 space-y-5">
		<li class="rounded-md border border-border p-5">
			<div class="mb-3 flex items-center gap-2">
				<span
					class="flex h-5 w-5 items-center justify-center rounded-full bg-surface-2 text-[11px] font-medium text-text"
					>1</span
				>
				<span class="text-sm font-medium text-text">Install the plugin in Claude Code</span>
			</div>
			<div class="space-y-2">
				{#each installCmds as cmd}
					{@render copyRow(cmd)}
				{/each}
			</div>
			<p class="mt-3 text-xs text-text-muted">
				No Claude Code yet? Get it at
				<a
					href="https://claude.ai/code"
					target="_blank"
					rel="noopener noreferrer"
					class="text-accent underline hover:text-accent-strong">claude.ai/code</a
				>.
			</p>
		</li>

		<li class="rounded-md border border-border p-5">
			<div class="mb-3 flex items-center gap-2">
				<span
					class="flex h-5 w-5 items-center justify-center rounded-full bg-surface-2 text-[11px] font-medium text-text"
					>2</span
				>
				<span class="text-sm font-medium text-text">Point it at your website</span>
			</div>
			{@render copyRow(setupCmd)}
			<p class="mt-3 text-xs text-text-muted">
				On first run, a browser tab opens to authorize the MCP connection — sign in with your Google
				account to link the plugin here. LeadAce then reads your site and drafts your strategy.
			</p>
		</li>
	</ol>

	<div class="mt-8 flex flex-wrap items-center gap-3">
		<button
			type="button"
			onclick={recheck}
			disabled={checking}
			class="rounded-md bg-text px-4 py-1.5 text-xs font-medium text-page hover:bg-text/90 disabled:opacity-50"
		>
			{checking ? 'Checking…' : "I've connected — check now"}
		</button>
		<button
			type="button"
			onclick={() => goto('/dashboard')}
			class="text-xs text-text-muted underline hover:text-text"
		>
			Skip for now
		</button>
	</div>
	{#if notDetected}
		<p class="mt-3 text-xs text-text-muted">
			No connection detected yet. Run the commands above in Claude Code, then check again.
		</p>
	{/if}
</div>
