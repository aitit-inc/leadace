<script lang="ts">
	import { goto, invalidate } from '$app/navigation';
	import { Check, Copy } from '@lucide/svelte';
	import { ApiError } from '$lib/api';
	import { generateWebPreview } from '$lib/api/web-preview';
	import type { PageProps } from './$types';

	const installCmd =
		'claude plugin marketplace add aitit-inc/leadace && claude plugin install leadace@leadace';

	let { data }: PageProps = $props();
	let token = $derived(data.session?.access_token);
	let preview = $derived(data.preview);

	// Mirrors the plugin's onboarding rule: `/leadace <url>` names the project
	// after the site (https://example.com -> "Example"), so the copied
	// `/daily-cycle` command can carry the name it will have.
	function projectNameFromUrl(u: string): string | null {
		try {
			const label = new URL(u).hostname.replace(/^www\./, '').split('.')[0] ?? '';
			return label ? label.charAt(0).toUpperCase() + label.slice(1) : null;
		} catch {
			return null;
		}
	}
	let projectGuess = $derived(preview ? projectNameFromUrl(preview.url) : null);
	let setupCmd = $derived(`/leadace ${preview?.url ?? 'https://your-company.com'}`);
	let cycleCmd = $derived(`/daily-cycle ${projectGuess ?? '<project name>'}`);

	// Seeded once from the loader; reseeding on emptiness would fight the user
	// clearing the field to type a different URL.
	// svelte-ignore state_referenced_locally
	let url = $state(data.preview?.url ?? '');
	let generating = $state(false);
	let generateError = $state('');

	let copied = $state<string | null>(null);
	let checking = $state(false);
	let notDetected = $state(false);

	async function generate() {
		if (!token || generating) return;
		const trimmed = url.trim();
		if (!trimmed) return;
		const target = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
		generating = true;
		generateError = '';
		try {
			await generateWebPreview(target, fetch, token);
			url = target;
			await invalidate('app:web-preview');
		} catch (e) {
			generateError =
				e instanceof ApiError ? e.detail || e.message : 'Generation failed — please try again.';
		} finally {
			generating = false;
		}
	}

	function scrollToSetup() {
		document.getElementById('run-it')?.scrollIntoView({ behavior: 'smooth' });
	}

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
		<code
			class="min-w-0 flex-1 rounded bg-surface px-3 py-1.5 font-mono text-xs break-all text-text"
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
	<h2 class="text-lg font-semibold text-text">See LeadAce sell your product</h2>
	<p class="mt-1 text-sm text-text-muted">
		Paste your website. The agent reads it and shows who it would email and what it would say —
		usually in under a minute, nothing to install.
	</p>

	<form
		class="mt-5 flex gap-2"
		onsubmit={(e) => {
			e.preventDefault();
			void generate();
		}}
	>
		<input
			type="text"
			bind:value={url}
			placeholder="https://your-company.com"
			disabled={generating}
			class="min-w-0 flex-1 rounded-md border border-border bg-page px-3 py-2 text-sm text-text disabled:opacity-50"
		/>
		<button
			type="submit"
			disabled={generating || !url.trim()}
			class="shrink-0 rounded-md bg-accent px-4 py-2 text-sm font-medium text-page hover:bg-accent-strong disabled:opacity-50"
		>
			{generating ? 'Reading…' : preview ? 'Regenerate' : 'Show me'}
		</button>
	</form>
	{#if generating}
		<p class="mt-3 animate-pulse text-xs text-text-muted">
			The agent is reading your site and drafting — usually under a minute.
		</p>
	{/if}
	{#if generateError}
		<p class="mt-3 text-xs text-danger">{generateError}</p>
	{:else if data.previewError}
		<p class="mt-3 text-xs text-danger">{data.previewError}</p>
	{/if}

	{#if preview}
		{@const r = preview.result}
		<div class="mt-8 space-y-6">
			<div class="rounded-md border border-border bg-surface p-4">
				<p class="text-xs font-medium uppercase tracking-wider text-text-muted">
					{r.company.name}
				</p>
				<p class="mt-1 text-sm text-text">{r.company.oneLiner}</p>
			</div>

			<section>
				<h3 class="text-sm font-medium text-text">Who it would target</h3>
				<div class="mt-3 grid gap-3 sm:grid-cols-3">
					{#each r.segments as seg, i (i)}
						<div class="rounded-md border border-border p-4">
							<p class="text-sm font-medium text-text">{seg.name}</p>
							<p class="mt-1.5 text-xs leading-relaxed text-text-secondary">{seg.who}</p>
							<p class="mt-1.5 text-xs leading-relaxed text-text-muted">{seg.why}</p>
						</div>
					{/each}
				</div>
			</section>

			<section>
				<h3 class="text-sm font-medium text-text">The first three emails</h3>
				<div class="mt-3 space-y-4">
					{#each r.emails as email, i (i)}
						<div class="rounded-md border border-border p-4">
							<p class="text-xs text-text-muted">To: {email.to}</p>
							<p class="mt-1 text-sm font-medium text-text">{email.subject}</p>
							<pre
								class="mt-3 font-sans text-sm leading-relaxed whitespace-pre-wrap text-text">{email.body}</pre>
							<pre
								class="mt-3 border-t border-border pt-2 font-sans text-xs leading-relaxed whitespace-pre-wrap text-text-muted">{r.footer}</pre>
						</div>
					{/each}
				</div>
				{#if r.footerIsProvisional}
					<p class="mt-2 text-xs text-text-muted">
						The footer identity is provisional — real sends use the legal name and address you set
						in
						<a href="/workspace-settings" class="underline hover:text-text">Workspace settings</a>.
					</p>
				{/if}
			</section>

			<div class="rounded-md border border-accent/40 bg-accent/5 p-4">
				<p class="text-sm font-medium text-text">Like what you see?</p>
				<div class="mt-3 flex flex-wrap items-center gap-3">
					<button
						type="button"
						onclick={scrollToSetup}
						class="rounded-md bg-accent px-4 py-2 text-sm font-medium text-page hover:bg-accent-strong"
					>
						Set up the agent
					</button>
					<a href="/live" class="text-sm text-accent underline hover:text-accent-strong">
						See the agent selling this product →
					</a>
				</div>
				<p class="mt-2 text-xs text-text-muted">
					Three steps below: install the plugin, point it at your site, run the first daily cycle.
					It sends from the Gmail account you signed in with.
				</p>
			</div>
		</div>
	{/if}

	<div id="run-it" class="mt-12">
		<h2 class="text-lg font-semibold text-text">Run it for real</h2>
		<p class="mt-1 text-sm text-text-muted">
			The agent runs from Claude Code or Claude Desktop. This dashboard shows your prospects,
			drafts, and replies — the plugin does the research, writing, and sending. Three steps and
			the first emails go out.
		</p>

		<ol class="mt-6 space-y-5">
			<li class="rounded-md border border-border p-5">
				<div class="mb-3 flex items-center gap-2">
					<span
						class="flex h-5 w-5 items-center justify-center rounded-full bg-surface-2 text-[11px] font-medium text-text"
						>1</span
					>
					<span class="text-sm font-medium text-text">Install it — terminal or Claude Desktop</span>
				</div>
				{@render copyRow(installCmd)}
				<p class="mt-3 text-xs text-text-muted">
					Already inside Claude Code? Run <code class="font-mono">/plugin marketplace add
						aitit-inc/leadace</code
					>
					then <code class="font-mono">/plugin install leadace@leadace</code> instead. No Claude Code
					yet? Get it at
					<a
						href="https://claude.ai/code"
						target="_blank"
						rel="noopener noreferrer"
						class="text-accent underline hover:text-accent-strong">claude.ai/code</a
					>.
				</p>
				<p class="mt-2 text-xs text-text-muted">
					In Claude Desktop instead: Customize → Plugins → Add from a repository →
					<code class="font-mono">aitit-inc/leadace</code> → Install → Connectors → Connect, then Customize
					→ Connectors → LeadAce → Connect and sign in with Google.
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
					Run this in Claude Code or Claude Desktop. Authorize the MCP connection once — a browser
					tab from Claude Code, or the connector's Connect button in Claude Desktop — with the same
					Google account. LeadAce then reads your site, drafts your strategy, and shows you
					everything in one review before saving.
				</p>
			</li>

			<li class="rounded-md border border-border p-5">
				<div class="mb-3 flex items-center gap-2">
					<span
						class="flex h-5 w-5 items-center justify-center rounded-full bg-surface-2 text-[11px] font-medium text-text"
						>3</span
					>
					<span class="text-sm font-medium text-text">Run the first daily cycle</span>
				</div>
				{@render copyRow(cycleCmd)}
				<p class="mt-3 text-xs text-text-muted">
					One command runs the whole loop — researches prospects, writes and sends today's batch,
					checks replies — and emails you a report. The argument is the project name
					<code class="font-mono">/leadace</code> prints when it creates the project
					{projectGuess ? `(“${projectGuess}” for your site)` : '(“Example” for example.com)'}; the
					dashboard's project switcher shows it too. Run it each day, or schedule it with
					<code class="font-mono">/setup-cron</code>.
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
				No connection detected yet. Run the commands above in Claude Code or Claude Desktop, then
				check again.
			</p>
		{/if}
	</div>
</div>
