import { describe, expect, it } from 'vitest';
import {
	cameraLine,
	formatAperture,
	formatExposureTime,
	formatFocalLength,
	plaqueFromExif,
	type ExifRow
} from './exif';

describe('formatExposureTime', () => {
	it('turns a raw fraction into 1/N', () => {
		expect(formatExposureTime('303/500000')).toBe('1/1650');
	});

	it('keeps whole seconds', () => {
		expect(formatExposureTime('2')).toBe('2s');
	});

	it('passes through already-friendly values', () => {
		expect(formatExposureTime('1/125')).toBe('1/125');
	});
});

describe('formatFocalLength', () => {
	it('adds mm to a number', () => {
		expect(formatFocalLength(6.9)).toBe('6.9mm');
		expect(formatFocalLength(24)).toBe('24mm');
	});
});

describe('formatAperture', () => {
	it('prefixes f/', () => {
		expect(formatAperture(1.68)).toBe('f/1.68');
		expect(formatAperture('f/1.68')).toBe('f/1.68');
	});
});

describe('cameraLine', () => {
	it('drops a phone back-camera lens that repeats the body', () => {
		expect(cameraLine('Google Pixel 10 Pro XL', 'Pixel 10 Pro XL back camera')).toBe(
			'Google Pixel 10 Pro XL'
		);
	});
});

describe('plaqueFromExif', () => {
	it('does not put the date in the tech line or repeat camera/f-stop', () => {
		const rows: ExifRow[] = [
			{ label: 'Date', value: '2026-08-09 at 14:30' },
			{ label: 'Location', value: 'Saint Petersburg, Florida, US' },
			{ label: 'Camera', value: 'Google Pixel 10 Pro XL' },
			{ label: 'Lens', value: 'Pixel 10 Pro XL back camera' },
			{ label: 'Focal Length', value: '6.9' },
			{ label: 'f/', value: '1.68' },
			{ label: 'ISO', value: '24' },
			{ label: 'Exposure', value: '303/500000' }
		];
		const plaque = plaqueFromExif(rows, 'Aug 9 · 2026');
		expect(plaque.camera).toBe('Google Pixel 10 Pro XL');
		expect(plaque.location).toBe('Saint Petersburg, Florida, US');
		expect(plaque.tech).toBe('6.9mm · f/1.68 · ISO 24 · 1/1650');
		expect(plaque.tech).not.toMatch(/back camera/i);
		expect(plaque.title).toBe('Saint Petersburg, Florida, US');
	});
});
