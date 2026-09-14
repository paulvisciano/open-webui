import { encode } from './vendor/uqr.mjs';

export type QrMatrix = {
	size: number;
	data: boolean[][];
};

export function encodeQrMatrix(text: string): QrMatrix {
	const result = encode(text, { ecc: 'M', border: 2 });
	return { size: result.size, data: result.data };
}

export function paintQr(
	ctx: CanvasRenderingContext2D,
	matrix: QrMatrix,
	x: number,
	y: number,
	size: number
): void {
	const cell = size / matrix.size;
	ctx.fillStyle = '#ffffff';
	ctx.fillRect(x, y, size, size);
	ctx.fillStyle = '#111111';
	for (let row = 0; row < matrix.size; row++) {
		const line = matrix.data[row];
		for (let col = 0; col < matrix.size; col++) {
			if (!line[col]) continue;
			ctx.fillRect(x + col * cell, y + row * cell, cell + 0.4, cell + 0.4);
		}
	}
}

export function drawWallQrPlaque(text: string, canvasSize = 768): HTMLCanvasElement {
	const canvas = document.createElement('canvas');
	canvas.width = canvasSize;
	canvas.height = canvasSize;
	const ctx = canvas.getContext('2d');
	if (!ctx) return canvas;

	const wood = Math.round(canvasSize * 0.07);
	const gilt = Math.max(3, Math.round(wood * 0.22));
	ctx.fillStyle = '#241008';
	ctx.fillRect(0, 0, canvasSize, canvasSize);
	ctx.fillStyle = '#7a4a2c';
	ctx.fillRect(2, 2, canvasSize - 4, canvasSize - 4);
	ctx.fillStyle = '#d4a84a';
	ctx.fillRect(wood, wood, canvasSize - wood * 2, canvasSize - wood * 2);
	const inner = wood + gilt;
	ctx.fillStyle = '#f3e6d0';
	ctx.fillRect(inner, inner, canvasSize - inner * 2, canvasSize - inner * 2);

	const captionH = Math.round(canvasSize * 0.08);
	const pad = Math.round(canvasSize * 0.04);
	const qrX = inner + pad;
	const qrY = inner + pad;
	const qrSize = canvasSize - inner * 2 - pad * 2 - captionH;
	paintQr(ctx, encodeQrMatrix(text), qrX, qrY, qrSize);

	ctx.fillStyle = '#6e4c32';
	ctx.font = `600 ${Math.round(canvasSize * 0.032)}px "JetBrains Mono", ui-monospace, monospace`;
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.letterSpacing = '0.18em';
	ctx.fillText('SCAN', canvasSize / 2, qrY + qrSize + captionH * 0.55);

	return canvas;
}
