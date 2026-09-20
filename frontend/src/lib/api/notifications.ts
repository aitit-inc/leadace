import { request, type RequestFetch } from '../api';
import type { NotificationItem } from '../types/notifications';

export async function listNotifications(fetchFn: RequestFetch = fetch, token?: string): Promise<NotificationItem[]> {
	const res = await request<{ items: NotificationItem[] }>(fetchFn, {
		method: 'GET',
		path: '/me/notifications',
		auth: 'required',
		token,
	});
	return res.items;
}

export async function markNotificationsSeen(fetchFn: RequestFetch = fetch, token?: string): Promise<void> {
	await request<void>(fetchFn, { method: 'POST', path: '/me/notifications/seen', body: {}, auth: 'required', token });
}
