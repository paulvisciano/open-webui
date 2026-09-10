import { getAssetExif } from '$lib/apis/graph';
import { photoExifUrl } from '$lib/components/graph/services/graph-api-client';
import { isLocalAssetNode } from './renderer/Layout';

export type ExifRow = { label: string; value: string };

export const EXIF_DISPLAY_KEYS: Record<string, string> = {
	camera: 'Camera',
	date_taken_friendly: 'Date',
	location: 'Location',
	gps_location: 'Location',
	friendly_location: 'Location',
	place_name: 'Location',
	lens: 'Lens',
	f_number: 'f/',
	iso: 'ISO',
	focal_length_mm: 'Focal Length',
	focal_length: 'Focal Length',
	exposure_time: 'Exposure',
	image_width: 'Width',
	image_height: 'Height',
	flash: 'Flash',
	white_balance: 'White Balance',
	orientation: 'Orientation'
};

export function formatExposureTime(raw: unknown): string {
	if (raw == null || raw === '') return '';
	const s = String(raw).trim().replace(/s$/i, '');
	let seconds: number | null = null;
	const frac = s.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
	if (frac) {
		const n = Number(frac[1]);
		const d = Number(frac[2]);
		if (d) seconds = n / d;
	} else {
		const n = Number(s);
		if (Number.isFinite(n)) seconds = n;
	}
	if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return String(raw).trim();
	if (seconds >= 1) {
		const shown = Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1).replace(/\.0$/, '');
		return `${shown}s`;
	}
	return `1/${Math.max(1, Math.round(1 / seconds))}`;
}

export function formatFocalLength(raw: unknown): string {
	if (raw == null || raw === '') return '';
	const s = String(raw).trim();
	if (/mm$/i.test(s)) return s;
	const n = Number(s);
	if (!Number.isFinite(n) || n <= 0) return s;
	const shown = n >= 10 ? String(Math.round(n)) : String(n);
	return `${shown}mm`;
}

export function formatAperture(raw: unknown): string {
	if (raw == null || raw === '') return '';
	const s = String(raw).trim();
	if (/^f\/?/i.test(s)) return s.replace(/^f\/?/i, 'f/');
	const n = Number(s);
	if (!Number.isFinite(n) || n <= 0) return s;
	const shown = Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
	return `f/${shown}`;
}

export function cameraLine(camera: string, lens = ''): string {
	const cam = camera.trim();
	const ln = lens.trim();
	if (!ln) return cam;
	if (!cam) return ln;
	const camLower = cam.toLowerCase();
	const lnLower = ln.toLowerCase();
	if (lnLower.includes(camLower)) return cam;
	if (/(back|front|wide|ultra.?wide|telephoto)\s+camera/i.test(ln)) return cam;
	return cam;
}

export function formatExifRows(exif: Record<string, unknown>): ExifRow[] {
	const rows: ExifRow[] = [];
	const seen = new Set<string>();
	for (const [key, displayLabel] of Object.entries(EXIF_DISPLAY_KEYS)) {
		const val = exif[key];
		if (val == null || val === '') continue;
		if (seen.has(displayLabel)) continue;
		let value = String(val);
		if (key === 'f_number') value = formatAperture(val);
		else if (key === 'exposure_time') value = formatExposureTime(val);
		else if (key === 'focal_length' || key === 'focal_length_mm') value = formatFocalLength(val);
		if (!value) continue;
		seen.add(displayLabel);
		rows.push({ label: displayLabel, value });
	}
	return rows;
}

export function formatCapturedDate(raw: unknown): string {
  if (raw == null || raw === '') return '';
  let d: Date | null = null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    d = new Date(raw > 1e12 ? raw : raw * 1000);
  } else if (typeof raw === 'string') {
    const m1 = raw.match(/^(\d{4})[:\-](\d{2})[:\-](\d{2})(?:[ T]| at )(\d{2}):(\d{2})(?::(\d{2}))?/);
    if (m1) {
      const [, Y, Mo, D, H, Mi, S] = m1;
      d = new Date(`${Y}-${Mo}-${D}T${H}:${Mi}:${S ?? '00'}`);
    } else {
      d = new Date(raw);
    }
  }
  if (!d || isNaN(d.getTime())) return typeof raw === 'string' ? raw : '';
  const day = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${day} · ${d.getFullYear()}`;
}

export function dateFromProperties(properties?: Record<string, unknown>): string {
  if (!properties) return '';
  return formatCapturedDate(
    properties.date_taken_friendly ??
      properties.datetime_original ??
      properties.date_taken ??
      properties.taken_at ??
      properties.createdAt ??
      properties.created_at
  );
}

export function compactExifLine(rows: ExifRow[]): string {
  const pick = (label: string) => rows.find((r) => r.label === label)?.value;
  const date = formatCapturedDate(pick('Date') ?? '');
  const loc = pick('Location');
  return [date, loc].filter((v): v is string => Boolean(v)).join(' · ');
}

export type PlaqueInfo = {
  title: string;
  location: string;
  camera: string;
  tech: string;
};

export function plaqueFromExif(rows: ExifRow[], _fallbackDate = ''): PlaqueInfo {
  const pick = (label: string) => rows.find((r) => r.label === label)?.value ?? '';
  const location = pick('Location');
  const camera = cameraLine(pick('Camera'), pick('Lens'));
  const focal = formatFocalLength(pick('Focal Length'));
  const f = formatAperture(pick('f/'));
  const iso = pick('ISO');
  const exp = formatExposureTime(pick('Exposure'));
  const seen = `${camera} ${pick('Lens')}`.toLowerCase();
  const tech = [
    focal && !seen.includes(focal.toLowerCase()) ? focal : '',
    f && !seen.includes(f.toLowerCase()) ? f : '',
    iso ? `ISO ${iso}` : '',
    exp
  ]
    .filter(Boolean)
    .join(' · ');
  return { title: location, location, camera, tech };
}

const cache = new Map<string, ExifRow[]>();
const inflight = new Map<string, Promise<ExifRow[]>>();

export function peekExif(nodeId: string): ExifRow[] | undefined {
	return cache.get(nodeId);
}

export function loadPhotoExif(
	nodeId: string,
	properties?: Record<string, unknown>
): Promise<ExifRow[]> {
	const hit = cache.get(nodeId);
	if (hit) return Promise.resolve(hit);
	const pending = inflight.get(nodeId);
	if (pending) return pending;

	const run = (async () => {
		try {
			const token = typeof localStorage !== 'undefined' ? (localStorage.getItem('token') ?? '') : '';
			let raw: Record<string, unknown> = {};
			if (nodeId.startsWith('asset:') || isLocalAssetNode({ id: nodeId, properties })) {
				raw = await getAssetExif(token, nodeId);
			} else {
				const fileSource =
					(properties?.source_id as string | undefined) ??
					(properties?.file_path as string | undefined);
				if (!fileSource) {
					cache.set(nodeId, []);
					return [];
				}
				const resp = await fetch(photoExifUrl(fileSource));
				if (resp.ok) raw = (await resp.json()) as Record<string, unknown>;
			}
			if (!raw.location && typeof properties?.location === 'string' && properties.location) {
				raw = { ...raw, location: properties.location };
			}
			const rows = formatExifRows(raw ?? {});
			cache.set(nodeId, rows);
			return rows;
		} catch {
			cache.set(nodeId, []);
			return [];
		} finally {
			inflight.delete(nodeId);
		}
	})();
	inflight.set(nodeId, run);
	return run;
}
