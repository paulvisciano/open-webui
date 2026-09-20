import { describe, expect, it } from 'vitest';
import { getChatFileUrl } from './index';

describe('getChatFileUrl', () => {
	it('omits w for the original file', () => {
		const url = getChatFileUrl('file-1');
		expect(url).toContain('/files/file-1/content');
		expect(url).not.toContain('w=');
	});

	it('adds w=512 and w=1024 for gallery LOD', () => {
		expect(getChatFileUrl('file-1', 512)).toContain('w=512');
		expect(getChatFileUrl('file-1', 1024)).toContain('w=1024');
		expect(getChatFileUrl('file-1', 512)).not.toBe(getChatFileUrl('file-1', 1024));
	});
});
