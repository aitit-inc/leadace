import { request, type RequestFetch } from '../api';
import type { Alert } from '../types/alerts';

export async function listAlerts(fetchFn: RequestFetch = fetch, token?: string): Promise<Alert[]> {
	const res = await request<{ alerts: Alert[] }>(fetchFn, {
		method: 'GET',
		path: '/me/alerts',
		auth: 'required',
		token,
	});
	return res.alerts;
}
