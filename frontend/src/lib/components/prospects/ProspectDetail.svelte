<script lang="ts">
  import { safeHttpUrl } from '$lib/redirect';
  import type { Prospect } from '$lib/types/prospects';

  let { p }: { p: Prospect } = $props();

  let safeWebsite = $derived(safeHttpUrl(p.websiteUrl));
  let safeForm = $derived(safeHttpUrl(p.contactFormUrl));
  let safePlatform = $derived(safeHttpUrl(p.platformUrl));
</script>

<div class="space-y-1.5 text-sm">
  <p><span class="text-text-muted">Organization:</span> <a href="/organizations/{p.organizationId}" class="text-accent-strong hover:underline">{p.organizationName}</a></p>
  <p class="break-words"><span class="text-text-muted">Website:</span> {#if safeWebsite}<a href={safeWebsite} target="_blank" rel="noopener noreferrer" class="text-accent-strong hover:underline">{p.websiteUrl}</a>{:else}<span class="text-text-muted">{p.websiteUrl}</span>{/if}</p>
  {#if p.email}<p class="break-all"><span class="text-text-muted">Email:</span> {p.email}{#if p.emailNoSolicitation}<span class="ml-1 text-danger">(no-solicitation notice — never written to)</span>{/if}</p>{/if}
  {#if p.contactFormUrl}<p class="break-all"><span class="text-text-muted">Form:</span> {#if safeForm}<a href={safeForm} target="_blank" rel="noopener noreferrer" class="text-accent-strong hover:underline">{p.contactFormUrl}</a>{:else}<span class="text-text-muted">{p.contactFormUrl}</span>{/if}{#if p.formNoSolicitation}<span class="ml-1 text-danger">(no-solicitation notice — never submitted)</span>{/if}</p>{/if}
  {#if p.platformUrl}<p class="break-all"><span class="text-text-muted">Platform:</span> {#if safePlatform}<a href={safePlatform} target="_blank" rel="noopener noreferrer" class="text-accent-strong hover:underline">{p.platformUrl}</a>{:else}<span class="text-text-muted">{p.platformUrl}</span>{/if}</p>{/if}
  {#if p.contactName}<p><span class="text-text-muted">Contact:</span> {p.contactName}{#if p.overview} &mdash; {p.overview}{/if}</p>{/if}
  <p><span class="text-text-muted">Match reason:</span> {p.matchReason}</p>
  {#if p.notes}<p><span class="text-text-muted">Notes:</span> {p.notes}</p>{/if}
  {#if p.doNotContact}<p class="text-danger font-semibold">Do not contact</p>{/if}
</div>
