export const GRAPH_CHAT_PARAM = 'chat';

export function parseGraphChatId(url: URL | null | undefined): string | null {
	const id = url?.searchParams?.get(GRAPH_CHAT_PARAM)?.trim();
	return id ? id : null;
}

export const GALLERY_PATH = '/gallery';

export function graphConversationPath(chatId: string | null, pathname = GALLERY_PATH): string {
	if (!chatId) return pathname;
	const params = new URLSearchParams();
	params.set(GRAPH_CHAT_PARAM, chatId);
	return `${pathname}?${params.toString()}`;
}

export function isLoopbackHost(hostname: string): boolean {
	const host = hostname.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
	return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0';
}

export function lanOriginFrom(
	location: { protocol: string; hostname: string; port: string },
	lanIp?: string | null
): string {
	const port = location.port ? `:${location.port}` : '';
	if (lanIp && isLoopbackHost(location.hostname)) {
		return `${location.protocol}//${lanIp}${port}`;
	}
	return `${location.protocol}//${location.hostname}${port}`;
}

export function conversationDeepLink(
	origin: string,
	chatId: string,
	pathname = GALLERY_PATH
): string {
	return `${origin.replace(/\/$/, '')}${graphConversationPath(chatId, pathname)}`;
}

type LanOriginPayload = {
	ip?: string | null;
	origin?: string | null;
};

function envLanOrigin(location: { protocol: string; hostname: string; port: string }): string {
	const envIp = typeof import.meta !== 'undefined' ? import.meta.env?.VITE_LAN_IP : undefined;
	return lanOriginFrom(location, typeof envIp === 'string' && envIp ? envIp : null);
}

export async function resolveLanOrigin(
	fetchImpl: typeof fetch = fetch,
	location: { protocol: string; hostname: string; port: string } = window.location
): Promise<string> {
	try {
		const res = await fetchImpl('/__lan-origin');
		if (!res.ok) return envLanOrigin(location);
		const data = (await res.json()) as LanOriginPayload;
		if (typeof data.ip === 'string' && data.ip) {
			return lanOriginFrom(location, data.ip);
		}
		if (typeof data.origin === 'string' && data.origin) return data.origin;
		return envLanOrigin(location);
	} catch (_err) {
		return envLanOrigin(location);
	}
}
