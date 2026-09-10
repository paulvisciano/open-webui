import { describe, expect, it } from 'vitest';
import { hoverCaption, whenPhrase } from './hover-caption';

const wed = Date.UTC(2026, 8, 9, 18, 0, 0);
const now = Date.UTC(2026, 8, 10, 18, 0, 0);

describe('whenPhrase', () => {
	it('uses today, yesterday, and last weekday', () => {
		expect(whenPhrase(now, now)).toBe('today');
		expect(whenPhrase(wed, now)).toBe('yesterday');
		expect(whenPhrase(Date.UTC(2026, 8, 8, 12, 0, 0), now)).toMatch(/^last /);
	});
});

describe('hoverCaption', () => {
	it('differs by kind and includes the date', () => {
		expect(hoverCaption('photo', wed, now)).toBe('Relive yesterday');
		expect(hoverCaption('video', wed, now)).toBe('Watch yesterday');
		expect(hoverCaption('conversation', wed, now)).toBe('Reopen yesterday');
	});

	it('falls back without a date', () => {
		expect(hoverCaption('photo', null)).toBe('Look closer');
		expect(hoverCaption('video', null)).toBe('Play this');
		expect(hoverCaption('conversation', null)).toBe('Open this chat');
	});
});
