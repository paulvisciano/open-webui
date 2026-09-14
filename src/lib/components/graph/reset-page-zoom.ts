const VIEWPORT_RESET =
	'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=0, viewport-fit=cover, interactive-widget=resizes-content';

/** Force visual-viewport scale back to 1 after a pinch-zoomed image overlay closes. */
export function resetPageZoom(): void {
	if (typeof document === 'undefined') return;

	window.scrollTo(0, 0);

	const root = document.documentElement;
	const body = document.body;
	const prevRootZoom = root.style.zoom;
	const prevBodyZoom = body.style.zoom;
	root.style.zoom = '1';
	body.style.zoom = '1';

	const meta = document.querySelector('meta[name="viewport"]');
	const original = meta?.getAttribute('content');
	if (meta) {
		meta.setAttribute('content', VIEWPORT_RESET);
	}

	window.setTimeout(() => {
		if (meta && original != null) {
			meta.setAttribute('content', original);
		}
		root.style.zoom = prevRootZoom;
		body.style.zoom = prevBodyZoom;
	}, 50);
}

export function preventBrowserZoom(event: WheelEvent): void {
	if (event.ctrlKey || event.metaKey) event.preventDefault();
}

export function lockBrowserZoom(): () => void {
	window.addEventListener('wheel', preventBrowserZoom, { passive: false, capture: true });
	return () => window.removeEventListener('wheel', preventBrowserZoom, true);
}
