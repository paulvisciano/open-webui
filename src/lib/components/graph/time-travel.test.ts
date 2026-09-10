import { describe, expect, it } from 'vitest';
import { INITIAL_CAMERA_Z, TIME_BUCKET_SPACING, CHUNK_SIZE } from './renderer/constants';
import {
	bucketIndexFromMs,
	cameraZToFractionalIndex,
	clockHandAngles,
	fallbackTimeForBucket,
	formatHudDate,
	formatLocationLabel,
	fractionalIndexToCameraZ,
	LIVE_BUCKET_EPSILON,
	viewInstantFromCameraZ,
	viewInstantFromWallZ,
	zForTime
} from './time-travel';

describe('time-travel', () => {
	it('maps camera Z to bucket index with oldest at INITIAL_CAMERA_Z', () => {
		expect(cameraZToFractionalIndex(INITIAL_CAMERA_Z)).toBeCloseTo(0);
		expect(cameraZToFractionalIndex(fractionalIndexToCameraZ(3))).toBeCloseTo(3);
		expect(fractionalIndexToCameraZ(1) - fractionalIndexToCameraZ(0)).toBe(
			TIME_BUCKET_SPACING * CHUNK_SIZE
		);
	});

	it('stays live at the newest end of the corridor', () => {
		const now = Date.UTC(2026, 8, 9, 18, 41, 7);
		const times = [
			Date.UTC(2022, 6, 21, 9, 51, 0),
			Date.UTC(2026, 7, 1, 12, 0, 0),
			now - 86_400_000
		];
		const locations = ['Gulfport, Florida', 'Saint Petersburg, Florida', null];
		const z = fractionalIndexToCameraZ(times.length - 1);
		const instant = viewInstantFromCameraZ(z, times, locations, now, 'St. Petersburg, FL');
		expect(instant.live).toBe(true);
		expect(instant.ms).toBe(now);
		expect(instant.location).toBe('St. Petersburg, FL');
	});

	it('rewinds toward older timestamps as camera Z decreases', () => {
		const now = Date.UTC(2026, 8, 9, 18, 41, 7);
		const oldest = Date.UTC(2022, 6, 21, 9, 51, 0);
		const times = [oldest, now - 86_400_000];
		const locations = ['Gulfport, Florida', null];
		const newestZ = fractionalIndexToCameraZ(1);
		const oldestZ = fractionalIndexToCameraZ(0);
		const midZ = (newestZ + oldestZ) / 2;

		const present = viewInstantFromCameraZ(newestZ, times, locations, now, 'Here');
		const past = viewInstantFromCameraZ(oldestZ, times, locations, now, 'Here');
		const mid = viewInstantFromCameraZ(midZ, times, locations, now, 'Here');

		expect(present.live).toBe(true);
		expect(past.live).toBe(false);
		expect(past.ms).toBe(oldest);
		expect(past.location).toBe('Gulfport, Florida');
		expect(mid.live).toBe(false);
		expect(mid.ms).toBeGreaterThan(oldest);
		expect(mid.ms).toBeLessThan(now);
	});

	it('treats a small zoom-out past the newest bucket as still live', () => {
		const now = 1_000_000;
		const times = [100, now];
		const z = fractionalIndexToCameraZ(1 - LIVE_BUCKET_EPSILON / 2);
		const instant = viewInstantFromCameraZ(z, times, [null, null], now, 'Here');
		expect(instant.live).toBe(true);
		expect(instant.ms).toBe(now);
	});

	it('points analog hands at 3:00 and 12:00', () => {
		const three = clockHandAngles(new Date(2026, 0, 1, 3, 0, 0));
		expect(three.hour).toBeCloseTo(90);
		expect(three.minute).toBeCloseTo(0);
		const noon = clockHandAngles(new Date(2026, 0, 1, 12, 0, 0));
		expect(noon.hour).toBeCloseTo(0);
	});

	it('shortens location strings to city and region', () => {
		expect(formatLocationLabel('Saint Petersburg, Florida, US')).toBe(
			'Saint Petersburg, Florida'
		);
		expect(formatLocationLabel('Gulfport')).toBe('Gulfport');
		expect(formatLocationLabel(null)).toBe('');
	});

	it('maps wall-column Z to the photo date at that column', () => {
		const aug9 = Date.UTC(2026, 7, 9, 16, 0, 0);
		const sep9 = Date.UTC(2026, 8, 9, 18, 0, 0);
		const samples = [
			{ t: Date.UTC(2022, 6, 21, 9, 0, 0), z: 0 },
			{ t: aug9, z: 5200 },
			{ t: Date.UTC(2026, 7, 20, 12, 0, 0), z: 5460 }
		];
		const atAug = viewInstantFromWallZ(5200, samples, sep9, null);
		expect(atAug?.live).toBe(false);
		expect(atAug?.ms).toBe(aug9);

		const buckets = ['2022-07', '2026-08', 'today'];
		expect(bucketIndexFromMs(aug9, buckets, sep9)).toBe(1);
		expect(formatHudDate(aug9, false, 'Today')).toBe(
			new Date(aug9).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
		);
		expect(zForTime(aug9, samples)).toBe(5200);
	});

	it('does not treat oldest-end photos as live just because they are newest in the library', () => {
		const aug9 = Date.UTC(2026, 7, 9, 16, 0, 0);
		const sep9 = Date.UTC(2026, 8, 9, 18, 0, 0);
		const samples = [{ t: aug9, z: 2600 }];
		const instant = viewInstantFromWallZ(2600, samples, sep9, 'Here');
		expect(instant?.live).toBe(false);
		expect(instant?.ms).toBe(aug9);
	});

	it('parses bucket keys into fallback timestamps', () => {
		const now = new Date(2026, 8, 9, 18, 41, 0);
		expect(fallbackTimeForBucket('today', now)).toBe(now.getTime());
		const yesterday = new Date(fallbackTimeForBucket('yesterday', now));
		expect(yesterday.getDate()).toBe(8);
		expect(new Date(fallbackTimeForBucket('2022-07', now)).getFullYear()).toBe(2022);
		expect(new Date(fallbackTimeForBucket('2022-07', now)).getMonth()).toBe(6);
	});
});
