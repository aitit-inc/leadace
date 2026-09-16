import adapter from '@sveltejs/adapter-cloudflare';
import { loadEnv } from 'vite';

const dev = process.env.NODE_ENV !== 'production';

// Scoped from the same PUBLIC_ env the client uses, so self-host gets its own
// origins and a build without them still runs. An https source does not match a
// wss: URL, so the API's ws origin is listed on its own.
const publicEnv = loadEnv(dev ? 'development' : 'production', process.cwd(), 'PUBLIC_');
const originOf = (url) => url && new URL(url).origin;
const apiOrigin = originOf(publicEnv.PUBLIC_API_URL);
const mcpOrigin = originOf(publicEnv.PUBLIC_MCP_URL);
const supabaseOrigin = originOf(publicEnv.PUBLIC_SUPABASE_URL);
const connectSrc =
	apiOrigin && mcpOrigin && supabaseOrigin
		? ['self', apiOrigin, apiOrigin.replace(/^http/, 'ws'), mcpOrigin, supabaseOrigin]
		: ['self', 'https:', 'wss:'];

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
				// The wildcards also cover Vite's HMR socket.
				'connect-src': dev ? [...connectSrc, 'http://localhost:*', 'ws://localhost:*'] : connectSrc,
				'frame-src': [
					'https://www.youtube.com',
					'https://www.youtube-nocookie.com',
					'https://player.vimeo.com'
				],
				'frame-ancestors': ['none'],
				'base-uri': ['self'],
				'form-action': ['self'],
				'object-src': ['none']
			}
		}
	}
};

export default config;
