import { render, fireEvent } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import ConversationCloud from './ConversationCloud.svelte';
import { PREVIEW_CARDS } from './graph-story-fixtures';

describe('ConversationCloud', () => {
	it('calls onselectconversation with the card chat id', async () => {
		const onselectconversation = vi.fn();
		const { getByRole } = render(ConversationCloud, {
			props: {
				hidden: false,
				previewCards: PREVIEW_CARDS,
				onselectconversation
			}
		});

		await fireEvent.click(getByRole('button', { name: /Trip planning/ }));
		expect(onselectconversation).toHaveBeenCalledWith('chat-trip');
	});
});
