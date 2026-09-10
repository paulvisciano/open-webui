import { render, fireEvent, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import GraphSearch from './GraphSearch.svelte';
import { mockListChats, mockSearchChats } from './graph-story-fixtures';

describe('GraphSearch', () => {
	it('selecting a chat row calls onselect and closes the palette', async () => {
		const onselect = vi.fn();
		const { getByRole, queryByTestId } = render(GraphSearch, {
			props: {
				open: true,
				onselect,
				listChats: mockListChats,
				searchChats: mockSearchChats
			}
		});

		const row = await waitFor(() => getByRole('option', { name: /Trip planning/ }));
		await fireEvent.click(row);

		expect(onselect).toHaveBeenCalledWith('chat-trip');
		expect(queryByTestId('graph-search')).toBeNull();
	});
});
