import type { StorybookConfig } from '@storybook/sveltekit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));

const config: StorybookConfig = {
	stories: ['../src/lib/components/graph/**/*.stories.@(js|ts|svelte)'],
	addons: ['@storybook/addon-essentials', '@storybook/addon-interactions'],
	framework: {
		name: '@storybook/sveltekit',
		options: {}
	},
	docs: {
		autodocs: false
	},
	async viteFinal(config) {
		const chatStub = path.join(dirname, '../src/lib/components/graph/__mocks__/Chat.svelte');
		config.resolve ??= {};
		const existing = config.resolve.alias;
		if (Array.isArray(existing)) {
			config.resolve.alias = [
				{ find: '$lib/components/chat/Chat.svelte', replacement: chatStub },
				...existing
			];
		} else {
			config.resolve.alias = {
				'$lib/components/chat/Chat.svelte': chatStub,
				...existing
			};
		}
		return config;
	}
};

export default config;
