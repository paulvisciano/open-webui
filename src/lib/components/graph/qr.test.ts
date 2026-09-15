import { describe, expect, it } from 'vitest';
import { encodeQrMatrix } from './qr';

describe('encodeQrMatrix', () => {
	it('encodes a graph conversation URL with finder patterns', () => {
		const url = 'https://192.168.1.20:5173/gallery?chat=abc-123';
		const matrix = encodeQrMatrix(url);
		expect(matrix.size).toBeGreaterThan(20);
		expect(matrix.data).toHaveLength(matrix.size);
		expect(matrix.data[0]).toHaveLength(matrix.size);
		expect(matrix.data[2][2]).toBe(true);
		expect(matrix.data[2][matrix.size - 3]).toBe(true);
		expect(matrix.data[matrix.size - 3][2]).toBe(true);
	});
});
