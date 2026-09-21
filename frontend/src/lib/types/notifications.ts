// Mirrors backend/src/services/notifications.ts `NotificationItem`.
export type NotificationItem = {
	id: number;
	category: 'general' | 'cron' | 'lead' | 'insight';
	subject: string;
	body: string;
	link: string;
	createdAt: string;
	unread: boolean;
};
