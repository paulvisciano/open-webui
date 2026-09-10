/**
 * Map corridor camera Z onto a wall-clock instant so the HUD can rewind
 * as the user scrolls back through time.
 *
 * Index 0 is the oldest bucket; the last index is the newest. Camera Z
 * uses the same mapping as `flyToBucket`:
 *   z = index * TIME_BUCKET_SPACING * CHUNK_SIZE + INITIAL_CAMERA_Z
 */
import { CHUNK_SIZE, INITIAL_CAMERA_Z, TIME_BUCKET_SPACING } from './renderer/constants';

/** Fractional indices within this of the newest bucket count as "now". */
export const LIVE_BUCKET_EPSILON = 0.02;

export type ViewInstant = {
	ms: number;
	live: boolean;
	location: string | null;
	fractionalIndex: number;
};

export type WallTimeSample = { t: number; z: number };

const NEWEST_LIVE_MS = 18 * 60 * 60 * 1000;

export function cameraZToFractionalIndex(z: number): number {
	return (z - INITIAL_CAMERA_Z) / (TIME_BUCKET_SPACING * CHUNK_SIZE);
}

export function fractionalIndexToCameraZ(index: number): number {
	return index * TIME_BUCKET_SPACING * CHUNK_SIZE + INITIAL_CAMERA_Z;
}

function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

function clamp(n: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, n));
}

/**
 * Newest end of the corridor is always live (current time + current location).
 * Scrolling toward older buckets interpolates from now into that era, then
 * between stored bucket timestamps so the date races backward.
 */
export function viewInstantFromCameraZ(
	z: number,
	indexToTime: readonly number[],
	indexToLocation: readonly (string | null)[],
	nowMs: number,
	liveLocation: string | null
): ViewInstant {
	const n = indexToTime.length;
	if (n === 0) {
		return { ms: nowMs, live: true, location: liveLocation, fractionalIndex: 0 };
	}

	const last = n - 1;
	const frac = cameraZToFractionalIndex(z);
	if (frac >= last - LIVE_BUCKET_EPSILON) {
		return {
			ms: nowMs,
			live: true,
			location: liveLocation,
			fractionalIndex: frac
		};
	}

	const clamped = clamp(frac, 0, last);
	const i0 = Math.floor(clamped);
	const i1 = Math.min(last, i0 + 1);
	const u = clamped - i0;
	const t0 = indexToTime[i0] || nowMs;
	const t1 = i1 === last ? nowMs : indexToTime[i1] || t0;
	const loc = (u < 0.5 ? indexToLocation[i0] : indexToLocation[i1]) ?? liveLocation;

	return {
		ms: lerp(t0, t1, u),
		live: false,
		location: loc,
		fractionalIndex: frac
	};
}

function median(values: number[]): number {
	const s = [...values].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)] ?? 0;
}

export function collapseWallSamples(samples: readonly WallTimeSample[]): WallTimeSample[] {
	const byZ = new Map<number, number[]>();
	for (const s of samples) {
		const arr = byZ.get(s.z);
		if (arr) arr.push(s.t);
		else byZ.set(s.z, [s.t]);
	}
	return [...byZ.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([z, ts]) => ({ z, t: median(ts) }));
}

export function viewInstantFromWallZ(
	z: number,
	samples: readonly WallTimeSample[],
	nowMs: number,
	liveLocation: string | null
): ViewInstant | null {
	if (samples.length === 0) return null;
	const oldest = samples[0];
	const newest = samples[samples.length - 1];
	const span = Math.max(1, newest.z - oldest.z);
	const newestLive = nowMs - newest.t < NEWEST_LIVE_MS;
	const nearNewest = z >= newest.z - Math.min(130, span * 0.04);

	if (nearNewest && newestLive) {
		return { ms: nowMs, live: true, location: liveLocation, fractionalIndex: samples.length - 1 };
	}
	if (z >= newest.z) {
		return { ms: newest.t, live: false, location: liveLocation, fractionalIndex: samples.length - 1 };
	}
	if (z <= oldest.z) {
		return { ms: oldest.t, live: false, location: liveLocation, fractionalIndex: 0 };
	}

	let lo = 0;
	let hi = samples.length - 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (samples[mid].z <= z) lo = mid;
		else hi = mid;
	}
	const a = samples[lo];
	const b = samples[hi];
	const denom = b.z - a.z;
	const u = denom > 0 ? clamp((z - a.z) / denom, 0, 1) : 0;
	return {
		ms: lerp(a.t, b.t, u),
		live: false,
		location: liveLocation,
		fractionalIndex: lo + u
	};
}

export function zForTime(t: number, samples: readonly WallTimeSample[]): number | null {
	if (samples.length === 0) return null;
	if (t <= samples[0].t) return samples[0].z;
	const last = samples[samples.length - 1];
	if (t >= last.t) return last.z;
	for (let i = 1; i < samples.length; i++) {
		if (t <= samples[i].t) {
			const a = samples[i - 1];
			const b = samples[i];
			const span = b.t - a.t;
			const u = span > 0 ? (t - a.t) / span : 0;
			return a.z + u * (b.z - a.z);
		}
	}
	return last.z;
}

function monthKeyOf(d: Date): string {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function bucketIndexFromMs(
	ms: number,
	indexToBucket: readonly string[],
	nowMs: number
): number {
	if (indexToBucket.length === 0) return 0;
	const d = new Date(ms);
	const now = new Date(nowMs);
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
	let key: string;
	if (
		d.getFullYear() === today.getFullYear() &&
		d.getMonth() === today.getMonth() &&
		d.getDate() === today.getDate()
	) {
		key = 'today';
	} else if (
		d.getFullYear() === yesterday.getFullYear() &&
		d.getMonth() === yesterday.getMonth() &&
		d.getDate() === yesterday.getDate()
	) {
		key = 'yesterday';
	} else {
		key = monthKeyOf(d);
	}
	const exact = indexToBucket.indexOf(key);
	if (exact >= 0) return exact;
	const month = indexToBucket.indexOf(monthKeyOf(d));
	if (month >= 0) return month;
	let best = 0;
	let bestDist = Infinity;
	for (let i = 0; i < indexToBucket.length; i++) {
		const fb = fallbackTimeForBucket(indexToBucket[i], now);
		const dist = Math.abs(fb - ms);
		if (dist < bestDist) {
			bestDist = dist;
			best = i;
		}
	}
	return best;
}

export function formatHudDate(ms: number, live: boolean, liveLabel: string | null): string {
	if (live) return liveLabel ?? 'Today';
	return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function clockHandAngles(d: Date): { hour: number; minute: number; second: number } {
	const s = d.getSeconds() + d.getMilliseconds() / 1000;
	const m = d.getMinutes() + s / 60;
	const h = (d.getHours() % 12) + m / 60;
	return {
		hour: (h / 12) * 360,
		minute: (m / 60) * 360,
		second: (s / 60) * 360
	};
}

export function formatClockTime(d: Date): string {
	return d.toLocaleTimeString(undefined, {
		hour: 'numeric',
		minute: '2-digit',
		second: '2-digit'
	});
}

export function formatClockDate(d: Date, live: boolean): string {
	return d.toLocaleDateString(undefined, {
		weekday: 'long',
		month: 'short',
		day: 'numeric',
		year: live ? undefined : 'numeric'
	});
}

export function formatLocationLabel(raw: string | null | undefined): string {
	if (!raw) return '';
	const parts = raw
		.split(',')
		.map((p) => p.trim())
		.filter(Boolean);
	if (parts.length === 0) return '';
	if (parts.length === 1) return parts[0];
	return `${parts[0]}, ${parts[1]}`;
}

export function nodeTimeMs(p?: Record<string, unknown> | null): number | null {
	if (!p) return null;
	const raw =
		p.date_taken_friendly ??
		p.datetime_original ??
		p.date_taken ??
		p.datetime ??
		p.taken_at ??
		p.created_at ??
		p.createdAt ??
		p.timestamp;
	if (typeof raw === 'number' && Number.isFinite(raw)) return raw > 1e12 ? raw : raw * 1000;
	if (typeof raw === 'string' && raw) {
		const m1 = raw.match(/^(\d{4})[:\-](\d{2})[:\-](\d{2})(?:[ T]| at )(\d{2}):(\d{2})(?::(\d{2}))?/);
		if (m1) {
			const [, Y, Mo, D, H, Mi, S] = m1;
			const t = Date.parse(`${Y}-${Mo}-${D}T${H}:${Mi}:${S ?? '00'}`);
			return Number.isFinite(t) ? t : null;
		}
		const t = Date.parse(raw);
		return Number.isFinite(t) ? t : null;
	}
	return null;
}

export function timezoneFallbackLabel(): string {
	const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
	const city = tz.split('/').pop()?.replace(/_/g, ' ') ?? '';
	return city;
}

export function fallbackTimeForBucket(key: string, now: Date): number {
	if (key === 'today') return now.getTime();
	if (key === 'yesterday') {
		return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12, 0, 0).getTime();
	}
	const ym = /^(\d{4})-(\d{2})$/.exec(key);
	if (ym) {
		return new Date(Number(ym[1]), Number(ym[2]) - 1, 15, 12, 0, 0).getTime();
	}
	const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
	if (ymd) {
		return new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]), 12, 0, 0).getTime();
	}
	return now.getTime();
}
