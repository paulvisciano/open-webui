import TextureDecodeWorker from './texture-decode.worker?worker';
import { bitmapForWebGL } from './bitmap-for-webgl';

export function maxEdgeForUrl(url: string, origin = ''): number {
	try {
		const base =
			origin ||
			(typeof window !== 'undefined' ? window.location.origin : 'http://localhost');
		const parsed = new URL(url, base);
		const raw = parsed.searchParams.get('w');
		const w = raw ? Number(raw) : NaN;
		if (Number.isFinite(w) && w > 0) return w >= 1024 ? 1024 : 512;
		if (parsed.pathname.includes('/thumb')) return w >= 1024 ? 1024 : 512;
	} catch {
		return 1024;
	}
	return 1024;
}

export async function decodeImageBitmap(
	buffer: ArrayBuffer,
	mime: string,
	maxEdge: number,
	signal?: AbortSignal,
): Promise<ImageBitmap> {
	if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
	const worker = getDecodeWorker();
	if (!worker) return decodeBitmapOnThisThread(buffer, mime, maxEdge, signal);
	const id = String(++decodeSeq);
	return new Promise<ImageBitmap>((resolve, reject) => {
		const onAbort = () => {
			const pending = decodePending.get(id);
			decodePending.delete(id);
			if (pending) pending.reject(new DOMException('Aborted', 'AbortError'));
		};
		if (signal) {
			if (signal.aborted) {
				reject(new DOMException('Aborted', 'AbortError'));
				return;
			}
			signal.addEventListener('abort', onAbort, { once: true });
		}
		decodePending.set(id, {
			resolve: (bitmap) => {
				signal?.removeEventListener('abort', onAbort);
				resolve(bitmap);
			},
			reject: (err) => {
				signal?.removeEventListener('abort', onAbort);
				reject(err);
			},
		});
		worker.postMessage({ id, buffer, mime, maxEdge }, [buffer]);
	});
}

export async function decodeBitmapOnThisThread(
	buffer: ArrayBuffer,
	mime: string,
	maxEdge: number,
	signal?: AbortSignal,
): Promise<ImageBitmap> {
	if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
	const blob = new Blob([buffer], { type: mime || 'image/jpeg' });
	const bitmap = await bitmapForWebGL(blob, maxEdge);
	if (signal?.aborted) {
		bitmap.close();
		throw new DOMException('Aborted', 'AbortError');
	}
	return bitmap;
}

type DecodeOk = { id: string; bitmap: ImageBitmap };
type DecodeErr = { id: string; error: string };
type Pending = {
	resolve: (bitmap: ImageBitmap) => void;
	reject: (err: Error) => void;
};

let decodeWorker: Worker | null = null;
let decodeWorkerFailed = false;
let decodeSeq = 0;
const decodePending = new Map<string, Pending>();

function getDecodeWorker(): Worker | null {
	if (decodeWorkerFailed) return null;
	if (decodeWorker) return decodeWorker;
	if (typeof Worker === 'undefined') return null;
	try {
		decodeWorker = new TextureDecodeWorker();
		decodeWorker.onmessage = (event: MessageEvent<DecodeOk | DecodeErr>) => {
			const msg = event.data;
			const pending = decodePending.get(msg.id);
			if (!pending) {
				if ('bitmap' in msg) msg.bitmap.close();
				return;
			}
			decodePending.delete(msg.id);
			if ('bitmap' in msg) pending.resolve(msg.bitmap);
			else pending.reject(new Error(msg.error || 'decode failed'));
		};
		decodeWorker.onerror = () => {
			decodeWorkerFailed = true;
			for (const pending of decodePending.values()) {
				pending.reject(new Error('decode worker failed'));
			}
			decodePending.clear();
			decodeWorker?.terminate();
			decodeWorker = null;
		};
		return decodeWorker;
	} catch {
		decodeWorkerFailed = true;
		return null;
	}
}
