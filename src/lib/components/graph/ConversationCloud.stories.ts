import type { Meta, StoryObj } from '@storybook/svelte';
import { fn, expect, userEvent, within } from '@storybook/test';
import ConversationCloud from './ConversationCloud.svelte';
import { PREVIEW_CARDS } from './graph-story-fixtures';

const meta = {
	title: 'Graph/ConversationCloud',
	component: ConversationCloud,
	parameters: { layout: 'fullscreen' },
	args: {
		hidden: false,
		previewCards: PREVIEW_CARDS,
		onselectconversation: fn()
	}
} satisfies Meta<typeof ConversationCloud>;

export default meta;
type Story = StoryObj<typeof meta>;

export const VisibleCards: Story = {
	play: async ({ canvasElement, args }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('button', { name: /Trip planning/ }));
		await expect(args.onselectconversation).toHaveBeenCalledWith('chat-trip');
	}
};
