import type { ConversationCard } from './conversation-card';

export const MOCK_CHATS = [
	{
		id: 'chat-trip',
		title: 'Trip planning',
		updated_at: 1_710_000_000,
		time_range: 'Today'
	},
	{
		id: 'chat-recipe',
		title: 'Recipe notes',
		updated_at: 1_700_000_000,
		time_range: 'Yesterday'
	}
];

export async function mockListChats(_token?: string, page: number | null = 1) {
	if (page && page > 1) return [];
	return MOCK_CHATS;
}

export async function mockSearchChats(_token: string, text: string, page: number = 1) {
	if (page > 1) return [];
	const q = text.trim().toLowerCase();
	if (!q) return MOCK_CHATS;
	return MOCK_CHATS.filter((chat) => chat.title.toLowerCase().includes(q));
}

export const PREVIEW_CARDS: ConversationCard[] = [
	{
		chatId: 'chat-trip',
		title: 'Trip planning',
		meta: 'Mar 12 · 2024',
		cx: 220,
		cy: 180,
		scale: 1,
		z: 3,
		dist: 40,
		lod: 'compact'
	},
	{
		chatId: 'chat-recipe',
		title: 'Recipe notes',
		meta: 'Feb 2 · 2024',
		cx: 480,
		cy: 260,
		scale: 0.92,
		z: 2,
		dist: 80,
		lod: 'compact'
	},
	{
		chatId: 'chat-garden',
		title: 'Garden log',
		meta: 'Jan 8 · 2024',
		cx: 720,
		cy: 200,
		scale: 0.86,
		z: 1,
		dist: 120,
		lod: 'compact'
	}
];
