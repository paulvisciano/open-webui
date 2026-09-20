/// <reference lib="webworker" />

import { bitmapForWebGL } from './bitmap-for-webgl';

type DecodeJob = {
	id: string;
	buffer: ArrayBuffer;
	mime: string;
	maxEdge: number;
};

self.onmessage = async (event: MessageEvent<DecodeJob>) => {
	const { id, buffer, mime, maxEdge } = event.data;
	try {
		const blob = new Blob([buffer], { type: mime || 'image/jpeg' });
		const bitmap = await bitmapForWebGL(blob, maxEdge);
		self.postMessage({ id, bitmap }, [bitmap]);
	} catch (err) {
		self.postMessage({ id, error: err instanceof Error ? err.message : 'decode failed' });
	}
};
