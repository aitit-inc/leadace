import {
	HeartPulse,
	Mail,
	MailQuestion,
	MailX,
	Megaphone,
	Rocket,
	ShieldAlert,
	Target,
	Unplug,
	Zap,
} from '@lucide/svelte';
import type { Component } from 'svelte';
import type { AttentionItem } from '$lib/types/attention';

// Shared by bell and dashboard so one item never gets two descriptions.
export type AttentionMeta = {
	icon: Component;
	tone: 'accent' | 'info' | 'danger' | 'warning';
	title: string;
	desc: string;
	ctaLabel: string;
	href: string;
};

export function humanize(s: string): string {
	// snake_case (reasons/windows) and camelCase (compliance fields like legalName) → sentence case.
	const t = s.replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
	return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

export function attentionMeta(item: AttentionItem): AttentionMeta {
	switch (item.kind) {
		case 'hot_leads':
			return {
				icon: Target,
				tone: 'accent',
				title: `${item.count} meeting ${item.count === 1 ? 'request' : 'requests'} waiting`,
				desc: 'Prospects asked to talk — book the call',
				ctaLabel: 'Review',
				href: '/responses',
			};
		case 'outreach_drafts':
			return {
				icon: Mail,
				tone: 'info',
				title: `${item.count} ${item.count === 1 ? 'draft' : 'drafts'} ready to review`,
				desc: 'AI-drafted outreach — review & send',
				ctaLabel: 'Review',
				href: '/drafts',
			};
		case 'no_project':
			return {
				icon: Rocket,
				tone: 'accent',
				title: 'Finish setting up',
				desc: 'Paste your website URL in the chat and Ace proposes who to contact and what to say',
				ctaLabel: 'Open chat',
				href: '/chat',
			};
		case 'compliance_incomplete':
			return {
				icon: ShieldAlert,
				tone: 'danger',
				title: 'Compliance details missing',
				desc: `Sending is blocked until you add: ${item.missing.map(humanize).join(', ')}`,
				ctaLabel: 'Fix',
				href: '/workspace-settings',
			};
		case 'gmail_disconnected':
			return {
				icon: Unplug,
				tone: 'danger',
				title: 'Gmail disconnected',
				desc: 'Email sending is paused until you reconnect',
				ctaLabel: 'Reconnect',
				href: '/account-settings',
			};
		case 'gmail_auth_revoked':
			return {
				icon: Unplug,
				tone: 'danger',
				title: 'Google access revoked',
				desc: `Google rejected the saved access for ${item.fromEmail} on ${new Date(
					item.since,
				).toLocaleDateString()} — sending and reply collection are stopped until you reconnect`,
				ctaLabel: 'Reconnect',
				href: '/account-settings',
			};
		case 'reply_collection_scope_missing':
			return {
				icon: MailQuestion,
				tone: 'warning',
				title: 'Replies are not being read',
				desc: `${item.fromEmail} can send, but permission to read replies was never granted, so replies and bounces to it go unrecorded`,
				ctaLabel: 'Fix',
				href: '/account-settings',
			};
		case 'reply_collection_failing':
			return {
				icon: MailX,
				tone: 'danger',
				title: 'Reply collection failing',
				desc: `Checking ${item.fromEmail} for replies has been failing since ${new Date(
					item.since,
				).toLocaleDateString()}${item.detail ? ` — ${item.detail}` : ''}`,
				ctaLabel: 'Review',
				href: '/account-settings',
			};
		case 'outreach_futility':
			return {
				icon: HeartPulse,
				tone: 'warning',
				title: `Outreach in ${item.projectName} is not getting replies`,
				desc: `${item.sends} delivered emails drew ${item.replies === 1 ? '1 reply' : `${item.replies} replies`} — statistically below a viable rate. Check deliverability (DMARC, spam placement) and targeting before sending more`,
				ctaLabel: 'Review',
				href: '/dashboard',
			};
		case 'no_outbound_channels':
			return {
				icon: Megaphone,
				tone: 'warning',
				title: 'Outbound is paused',
				desc: 'No channels enabled — turn one on to start reaching prospects',
				ctaLabel: 'Enable',
				href: '/project-settings',
			};
		case 'quota_exhausted':
			return {
				icon: Zap,
				tone: 'warning',
				title: 'Outreach quota reached',
				desc:
					item.constraint === 'daily'
						? "Today's sending limit is used up — it resets tomorrow"
						: 'Your plan limit is used up — upgrade to keep sending',
				ctaLabel: item.constraint === 'daily' ? 'View plan' : 'Upgrade',
				href: '/plans',
			};
	}
	// Unreachable for kinds this build knows — a newer backend can ship kinds
	// this frontend predates (deploy skew).
	return {
		icon: ShieldAlert,
		tone: 'warning',
		title: 'Needs your attention',
		desc: 'Open the dashboard for details',
		ctaLabel: 'Open',
		href: '/dashboard',
	};
}
