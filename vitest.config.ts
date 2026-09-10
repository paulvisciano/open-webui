import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	plugins: [svelte({ hot: false, compilerOptions: { css: 'injected' } })],
	define: {
		APP_VERSION: JSON.stringify('test'),
		APP_BUILD_HASH: JSON.stringify('test')
	},
	resolve: {
		conditions: ['browser'],
		alias: [
			{
				find: '$lib/components/chat/Chat.svelte',
				replacement: path.join(dirname, 'src/lib/components/graph/__mocks__/Chat.svelte')
			},
			{
				find: '$app/environment',
				replacement: path.join(
					dirname,
					'src/lib/components/graph/__mocks__/app-environment.ts'
				)
			},
			{ find: '$lib', replacement: path.join(dirname, 'src/lib') }
		]
	},
	test: {
		environment: 'jsdom',
		include: ['src/**/*.{test,spec}.{js,ts}'],
		setupFiles: ['./src/vitest-setup.ts'],
		passWithNoTests: true
	}
});
