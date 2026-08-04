import { request, type RequestFetch } from '../api';
import type { AttentionItem } from '../types/attention';

export async function listAttention(
	fetchFn: RequestFetch = fetch,
	token?: string,
): Promise<AttentionItem[]> {
	const res = await request<{ items: AttentionItem[] }>(fetchFn, {
		method: 'GET',
		path: '/me/attention',
		auth: 'required',
		token,
	});
	return res.items;
}
