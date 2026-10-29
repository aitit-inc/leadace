import {
	Ban,
	HeartPulse,
	Mail,
	MailQuestion,
	MailX,
	Megaphone,
	CreditCard,
	Rocket,
	ShieldAlert,
	Target,
	Unplug,
	Zap,
} from '@lucide/svelte';
import type { Component } from 'svelte';
import type { AttentionItem, QuotaAllowance, QuotaConstraint } from '$lib/types/attention';

// Shared by bell and dashboard so one item never gets two descriptions.
export type AttentionMeta = {
	icon: Component;
	tone: 'accent' | 'inbound' | 'danger' | 'warning';
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

const QUOTA_DESC: Record<QuotaAllowance, Record<QuotaConstraint, string>> = {
	contacted: {
		monthly: 'New prospects resume next period — follow-ups still go out; buy credits or upgrade to continue now',
		lifetime: 'Every prospect in your plan has been contacted — follow-ups still go out; open the plans page to reach new ones',
	},
	found: {
		monthly: "No one is left to contact and this period's discovery is used up — bring your own list, or buy credits or upgrade",
		lifetime: "No one is left to contact and your plan's discovery is used up — bring your own list, or open the plans page to find more",
	},
};

export function attentionMeta(item: AttentionItem): AttentionMeta {
	switch (item.kind) {
		case 'hot_leads':
			return {
				icon: Target,
				tone: 'inbound',
				title: `${item.count} meeting ${item.count === 1 ? 'request' : 'requests'} waiting`,
				desc: 'Prospects asked to talk — book the call',
				ctaLabel: 'Review',
				href: '/responses',
			};
		case 'outreach_drafts':
			return {
				icon: Mail,
				tone: 'accent',
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
				tone: 'warning',
				title: 'Gmail not connected',
				desc: 'Connect it to send the emails you approve',
				ctaLabel: 'Connect',
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
		case 'mailbox_send_refused':
			return {
				icon: Ban,
				tone: 'danger',
				title: 'Mail provider refused to send',
				desc: `${item.fromEmail}: unblock it with the provider${
					item.sentThatDay > 1 ? `, or set its daily cap below ${item.sentThatDay}` : ''
				}`,
				ctaLabel: 'Resolve',
				href: '/account-settings',
			};
		case 'mailbox_inbox_test_spam':
			return {
				icon: MailX,
				tone: 'danger',
				title: 'Email is landing in spam',
				desc: `${item.fromEmail}: the latest inbox test put ${item.spam} of ${item.delivered} copies in spam, so sending from it is held`,
				ctaLabel: 'Review',
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
				title: `Outreach in ${item.projectName} is drawing no interest`,
				desc: `${item.engaged} of ${Math.round(item.sends)} delivered emails drew a reply or inquiry-page engagement — statistically below a viable rate. Check deliverability (DMARC, spam placement) and targeting before sending more`,
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
				title: item.allowance === 'found' ? 'Discovery allowance used' : 'Prospect allowance used',
				desc: QUOTA_DESC[item.allowance][item.constraint],
				ctaLabel: 'View plan',
				href: '/plans',
			};
		case 'subscription_unpaid':
			return {
				icon: CreditCard,
				tone: 'danger',
				title: "Your subscription isn't paid",
				desc: 'Your plan is on Free until Stripe collects the payment — check the card under Manage subscription to get your plan back',
				ctaLabel: 'Fix billing',
				href: '/plans',
			};
		case 'credit_top_up_failed':
			return {
				icon: CreditCard,
				tone: 'danger',
				title: 'Credit auto top-up was declined',
				desc: 'Your card refused the charge, so auto top-up is off — update the card in the Stripe portal, then switch it back on',
				ctaLabel: 'Fix billing',
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
