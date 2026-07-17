import adapter from '@sveltejs/adapter-cloudflare';
import { loadEnv } from 'vite';

const dev = process.env.NODE_ENV !== 'production';

// Scope prod connect-src to the app's own backend origins instead of all
// https:. Read from the same PUBLIC_ env the client uses (works for self-host
// too); fall back to https: if any is unset so a build without them still runs.
const publicEnv = loadEnv(dev ? 'development' : 'production', process.cwd(), 'PUBLIC_');
const backendOrigins = [
	publicEnv.PUBLIC_API_URL,
	publicEnv.PUBLIC_MCP_URL,
	publicEnv.PUBLIC_SUPABASE_URL,
]
	.filter(Boolean)
	.map((url) => new URL(url).origin);
const prodConnectSrc =
	backendOrigins.length === 3 ? ['self', ...backendOrigins] : ['self', 'https:'];

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		adapter: adapter(),
		csp: {
			mode: 'nonce',
			directives: {
				'default-src': ['self'],
				'script-src': ['self'],
				'style-src': ['self', 'unsafe-inline', 'https://fonts.googleapis.com'],
				'font-src': ['self', 'https://fonts.gstatic.com'],
				'img-src': ['self', 'data:', 'https:'],
				// dev also needs localhost + the Vite HMR websocket
				'connect-src': dev
					? ['self', 'http://localhost:*', 'ws://localhost:*', 'https:', 'wss:']
					: prodConnectSrc,
				'frame-ancestors': ['none'],
				'base-uri': ['self'],
				'form-action': ['self'],
				'object-src': ['none']
			}
		}
	}
};

export default config;
