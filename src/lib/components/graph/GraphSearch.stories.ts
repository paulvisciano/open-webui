import type { Meta, StoryObj } from '@storybook/svelte';
import { fn, expect, userEvent, waitFor, within } from '@storybook/test';
import GraphSearch from './GraphSearch.svelte';
import { mockListChats, mockSearchChats } from './graph-story-fixtures';

const meta = {
	title: 'Graph/GraphSearch',
	component: GraphSearch,
	parameters: { layout: 'fullscreen' },
	args: {
		open: true,
		onselect: fn(),
		listChats: mockListChats,
		searchChats: mockSearchChats
	}
} satisfies Meta<typeof GraphSearch>;

export default meta;
type Story = StoryObj<typeof meta>;

export const OpenPalette: Story = {
	play: async ({ canvasElement, args }) => {
		const canvas = within(canvasElement);
		const row = await waitFor(() => canvas.getByRole('option', { name: /Trip planning/ }));
		await userEvent.click(row);
		await expect(args.onselect).toHaveBeenCalledWith('chat-trip');
		await waitFor(() => {
			expect(canvas.queryByTestId('graph-search')).toBeNull();
		});
	}
};
