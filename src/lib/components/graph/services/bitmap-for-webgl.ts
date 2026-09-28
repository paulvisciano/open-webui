export async function bitmapForWebGL(blob: Blob, maxEdge: number): Promise<ImageBitmap> {
	const source = await createImageBitmap(blob, { imageOrientation: 'from-image' });
	let width = source.width;
	let height = source.height;
	if (width < 1 || height < 1) {
		source.close();
		throw new Error('image has no pixels');
	}
	const long = Math.max(width, height);
	if (maxEdge > 0 && long > maxEdge) {
		const scale = maxEdge / long;
		width = Math.max(1, Math.round(width * scale));
		height = Math.max(1, Math.round(height * scale));
	}
	if (typeof OffscreenCanvas === 'undefined') {
		source.close();
		return createImageBitmap(blob, {
			imageOrientation: 'flipY',
			resizeWidth: width,
			resizeHeight: height,
			resizeQuality: maxEdge <= 512 ? 'low' : 'medium',
		});
	}
	const canvas = new OffscreenCanvas(width, height);
	const ctx = canvas.getContext('2d');
	if (!ctx) {
		source.close();
		throw new Error('OffscreenCanvas 2d unavailable');
	}
	ctx.translate(0, height);
	ctx.scale(1, -1);
	ctx.drawImage(source, 0, 0, width, height);
	source.close();
	// Copy pixels instead of transferToImageBitmap(). Transferring that
	// bitmap out of a worker can arrive on the main thread already
	// detached (0×0), which makes WebGL throw texStorage2D / texSubImage2D.
	const bitmap = await createImageBitmap(canvas);
	canvas.width = 0;
	canvas.height = 0;
	return bitmap;
}
