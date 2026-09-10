import type { Preview } from '@storybook/svelte';

const preview: Preview = {
	parameters: {
		backgrounds: {
			default: 'graph',
			values: [
				{ name: 'graph', value: '#1a1410' },
				{ name: 'paper', value: '#f3ead6' }
			]
		}
	}
};

export default preview;
