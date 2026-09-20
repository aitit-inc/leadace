import type { Session, SupabaseClient, User } from '@supabase/supabase-js';

declare global {
	namespace App {
		interface Locals {
			supabase: SupabaseClient;
			safeGetSession: () => Promise<
				| { session: Session; user: User }
				| { session: null; user: null }
			>;
			session: Session | null;
			user: User | null;
		}
		interface PageData {
			session: Session | null;
			user: User | null;
		}
		interface PageState {
			// An opening message one page hands the chat. It rides history state,
			// not the URL, so only an in-app navigation can start a turn.
			ask?: string;
		}
	}
}

export {};
