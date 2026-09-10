import { getAssetExif } from '$lib/apis/graph';
import { photoExifUrl } from '$lib/components/graph/services/graph-api-client';
import { isLocalAssetNode } from './renderer/Layout';

export type ExifRow = { label: string; value: string };

export const EXIF_DISPLAY_KEYS: Record<string, string> = {
	camera: 'Camera',
	date_taken_friendly: 'Date',
	location: 'Location',
	lens: 'Lens',
	f_number: 'f/',
	iso: 'ISO',
	focal_length: 'Focal Length',
	exposure_time: 'Exposure',
	image_width: 'Width',
	image_height: 'Height',
	flash: 'Flash',
	white_balance: 'White Balance',
	orientation: 'Orientation'
};

export function formatExifRows(exif: Record<string, unknown>): ExifRow[] {
	const rows: ExifRow[] = [];
	for (const [key, displayLabel] of Object.entries(EXIF_DISPLAY_KEYS)) {
		const val = exif[key];
		if (val == null || val === '') continue;
		const strVal = String(val);
		rows.push({
			label: displayLabel,
			value: key === 'f_number' ? `f/${strVal}` : strVal
		});
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

export function plaqueFromExif(rows: ExifRow[], fallbackDate = ''): PlaqueInfo {
  const pick = (label: string) => rows.find((r) => r.label === label)?.value ?? '';
  const title = formatCapturedDate(pick('Date')) || fallbackDate;
  const location = pick('Location');
  const camera = pick('Camera');
  const lens = pick('Lens');
  const focal = pick('Focal Length');
  const f = pick('f/');
  const iso = pick('ISO');
  const exp = pick('Exposure');
  const tech = [lens || focal, f, iso ? `ISO ${iso}` : '', exp].filter(Boolean).join(' · ');
  return { title, location, camera, tech };
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
