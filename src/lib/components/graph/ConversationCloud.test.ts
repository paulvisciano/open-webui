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

	it('treats the title as the artwork and drops the conversation kicker', () => {
		const { getByRole, queryByText } = render(ConversationCloud, {
			props: {
				hidden: false,
				previewCards: PREVIEW_CARDS,
				onselectconversation: vi.fn()
			}
		});

		expect(queryByText('Conversation')).toBeNull();
		expect(getByRole('button', { name: /Recipe notes/ })).toBeTruthy();
		expect(getByRole('button', { name: /Flights into Lisbon/ })).toBeTruthy();
	});
});
