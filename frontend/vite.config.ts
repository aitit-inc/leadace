import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	// 5273, not Vite's default 5173, which every other Vite project also claims.
	// strictPort so a collision fails loudly instead of moving the app off the
	// port the docs, preflight, and the Worker vars all name.
	server: { port: 5273, strictPort: true }
});
