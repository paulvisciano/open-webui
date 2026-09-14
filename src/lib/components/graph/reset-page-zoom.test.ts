import { afterEach, describe, expect, it, vi } from 'vitest';
import { lockBrowserZoom, preventBrowserZoom, resetPageZoom } from './reset-page-zoom';

describe('resetPageZoom', () => {
	afterEach(() => {
		document.documentElement.style.zoom = '';
		document.body.style.zoom = '';
		document.head.querySelector('meta[name="viewport"]')?.remove();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it('forces viewport scale to 1 then restores the original meta content', () => {
		vi.useFakeTimers();
		vi.stubGlobal('scrollTo', vi.fn());
		const meta = document.createElement('meta');
		meta.name = 'viewport';
		meta.content = 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover';
		document.head.append(meta);

		resetPageZoom();

		expect(meta.content).toContain('user-scalable=0');
		expect(document.documentElement.style.zoom).toBe('1');
		expect(document.body.style.zoom).toBe('1');

		vi.advanceTimersByTime(50);

		expect(meta.content).toBe(
			'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover'
		);
		expect(document.documentElement.style.zoom || '').toBe('');
		expect(document.body.style.zoom || '').toBe('');
	});
});

describe('preventBrowserZoom', () => {
	it('prevents default on ctrl/meta wheel so the page does not zoom', () => {
		const ctrl = new WheelEvent('wheel', { ctrlKey: true, deltaY: 40 });
		const prevent = vi.spyOn(ctrl, 'preventDefault');
		preventBrowserZoom(ctrl);
		expect(prevent).toHaveBeenCalledOnce();

		const plain = new WheelEvent('wheel', { deltaY: 40 });
		const plainPrevent = vi.spyOn(plain, 'preventDefault');
		preventBrowserZoom(plain);
		expect(plainPrevent).not.toHaveBeenCalled();
	});
});

describe('lockBrowserZoom', () => {
	it('installs a capturing wheel listener and removes it on dispose', () => {
		const add = vi.spyOn(window, 'addEventListener');
		const remove = vi.spyOn(window, 'removeEventListener');
		const dispose = lockBrowserZoom();
		expect(add).toHaveBeenCalledWith('wheel', preventBrowserZoom, {
			passive: false,
			capture: true
		});
		dispose();
		expect(remove).toHaveBeenCalledWith('wheel', preventBrowserZoom, true);
		add.mockRestore();
		remove.mockRestore();
	});
});
