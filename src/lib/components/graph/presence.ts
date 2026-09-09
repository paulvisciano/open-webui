/**
 * Per-source presence diff. Poll GET /sources; do not reload LightRAG/chats.
 * Missing-from-tick sources are kept (never hide internal-disk because another
 * volume flipped). Only explicit online→false removes nodes.
 */
import type { GraphSource } from './assets';

export const PRESENCE_POLL_MS = 3000;

export type PresenceFlip = {
	wentOffline: string[];
	cameOnline: string[];
	nextOnline: Record<string, boolean>;
};

export function diffPresence(
	prevOnline: Record<string, boolean>,
	nextSources: GraphSource[]
): PresenceFlip {
	const wentOffline: string[] = [];
	const cameOnline: string[] = [];
	const nextOnline: Record<string, boolean> = { ...prevOnline };

	for (const s of nextSources) {
		if (!s.id) continue;
		const prev = prevOnline[s.id];
		const online = Boolean(s.online);
		if (prev === true && !online) wentOffline.push(s.id);
		else if (prev === false && online) cameOnline.push(s.id);
		nextOnline[s.id] = online;
	}

	return { wentOffline, cameOnline, nextOnline };
}

/** Update/add from the poll; never drop a source omitted from this tick. */
export function mergeSources(
	current: GraphSource[],
	next: GraphSource[],
	online: Record<string, boolean>
): GraphSource[] {
	const byId = new Map<string, GraphSource>();
	for (const s of current) {
		if (s.id) byId.set(s.id, s);
	}
	for (const s of next) {
		if (!s.id) continue;
		byId.set(s.id, { ...s, online: online[s.id] ?? s.online });
	}
	return [...byId.values()];
}
