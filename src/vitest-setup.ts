import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/svelte';

afterEach(() => {
	cleanup();
});

if (typeof HTMLCanvasElement !== 'undefined') {
	HTMLCanvasElement.prototype.getContext = function getContext() {
		const gradient = { addColorStop() {} };
		return {
			setTransform() {},
			clearRect() {},
			beginPath() {},
			moveTo() {},
			lineTo() {},
			closePath() {},
			fill() {},
			fillRect() {},
			createRadialGradient: () => gradient,
			fillStyle: ''
		} as unknown as CanvasRenderingContext2D;
	};
}

if (typeof globalThis.requestAnimationFrame !== 'function') {
	globalThis.requestAnimationFrame = (cb: FrameRequestCallback) =>
		setTimeout(() => cb(0), 0) as unknown as number;
	globalThis.cancelAnimationFrame = (id: number) => clearTimeout(id);
}
