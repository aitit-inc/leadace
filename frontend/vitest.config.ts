import { defineConfig } from 'vitest/config';

// Standalone vitest config (not the app's vite config) so unit tests run
// without the SvelteKit plugin / app bootstrap. Tests here cover pure
// modules under $lib (no Svelte components, no $app/$env imports).
export default defineConfig({
	test: {
		environment: 'node',
		include: ['src/**/*.test.ts'],
	},
});
