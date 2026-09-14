import { describe, expect, it, vi } from 'vitest';
import {
	GRAPH_CHAT_PARAM,
	conversationDeepLink,
	graphConversationPath,
	isLoopbackHost,
	lanOriginFrom,
	parseGraphChatId,
	resolveLanOrigin
} from './deeplink';

describe('graph conversation deeplink', () => {
	it('parses the chat query param', () => {
		expect(parseGraphChatId(new URL('https://localhost:5173/graph'))).toBeNull();
		expect(parseGraphChatId(new URL('https://localhost:5173/graph?chat='))).toBeNull();
		expect(parseGraphChatId(new URL('https://localhost:5173/graph?chat=abc-123'))).toBe('abc-123');
		expect(parseGraphChatId(null)).toBeNull();
		expect(parseGraphChatId(undefined)).toBeNull();
	});

	it('builds /graph?chat= paths', () => {
		expect(graphConversationPath(null)).toBe('/graph');
		expect(graphConversationPath('abc-123')).toBe(`/graph?${GRAPH_CHAT_PARAM}=abc-123`);
	});

	it('treats localhost aliases as loopback', () => {
		expect(isLoopbackHost('localhost')).toBe(true);
		expect(isLoopbackHost('127.0.0.1')).toBe(true);
		expect(isLoopbackHost('::1')).toBe(true);
		expect(isLoopbackHost('192.168.1.20')).toBe(false);
	});

	it('swaps loopback for the LAN IP and keeps https + port', () => {
		expect(
			lanOriginFrom({ protocol: 'https:', hostname: 'localhost', port: '5173' }, '192.168.1.20')
		).toBe('https://192.168.1.20:5173');
		expect(
			lanOriginFrom({ protocol: 'https:', hostname: '192.168.1.20', port: '5173' }, '10.0.0.2')
		).toBe('https://192.168.1.20:5173');
	});

	it('encodes a phone-reachable conversation URL', () => {
		expect(conversationDeepLink('https://192.168.1.20:5173', 'chat-1')).toBe(
			'https://192.168.1.20:5173/graph?chat=chat-1'
		);
	});

	it('prefers the live LAN IP endpoint when on localhost', async () => {
		const fetchImpl = vi.fn(async () => ({
			ok: true,
			json: async () => ({ ip: '192.168.4.12', origin: 'https://192.168.4.12:5173' })
		})) as unknown as typeof fetch;
		await expect(
			resolveLanOrigin(fetchImpl, {
				protocol: 'https:',
				hostname: 'localhost',
				port: '5173'
			})
		).resolves.toBe('https://192.168.4.12:5173');
	});
});
