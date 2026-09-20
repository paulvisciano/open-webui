import { describe, expect, it } from 'vitest';
import { maxEdgeForUrl } from './texture-decode';

describe('maxEdgeForUrl', () => {
	it('reads w=512 and w=1024 from the query', () => {
		expect(maxEdgeForUrl('https://localhost/api/v1/files/abc/content?w=512', 'https://localhost')).toBe(
			512
		);
		expect(
			maxEdgeForUrl('https://localhost/api/v1/files/abc/content?w=1024', 'https://localhost')
		).toBe(1024);
	});

	it('clamps other w values to the 512/1024 rungs', () => {
		expect(maxEdgeForUrl('https://localhost/api/v1/files/abc/content?w=800', 'https://localhost')).toBe(
			512
		);
		expect(
			maxEdgeForUrl('https://localhost/api/v1/graph/assets/x/thumb?w=2048', 'https://localhost')
		).toBe(1024);
	});

	it('treats /thumb without w as 512', () => {
		expect(maxEdgeForUrl('https://localhost/api/v1/graph/assets/x/thumb', 'https://localhost')).toBe(
			512
		);
	});

	it('caps unknown urls at 1024 so originals never decode at sensor size', () => {
		expect(maxEdgeForUrl('https://localhost/api/v1/files/abc/content', 'https://localhost')).toBe(1024);
	});
});
