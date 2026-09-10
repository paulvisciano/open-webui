import { describe, expect, it } from 'vitest';
import { isTrashSource } from './assets';

describe('isTrashSource', () => {
	it('matches Trash by name or path', () => {
		expect(isTrashSource({ name: 'Trash', lastAbsPath: '/photos' })).toBe(true);
		expect(isTrashSource({ name: 'Photos from 2026', lastAbsPath: '/Users/x/.Trash' })).toBe(true);
		expect(isTrashSource({ name: 'Photos from 2026', lastAbsPath: '/Users/x/Pictures' })).toBe(false);
	});
});
