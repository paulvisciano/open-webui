import { browser } from '$app/environment';

interface SheetDragOptions {
	sheet: HTMLElement;
	onDismiss: () => void;
	dismissThreshold?: number;
	velocityThreshold?: number;
}

export function createSheetDrag(options: SheetDragOptions) {
	if (!browser) return { destroy: () => {} };

	const { sheet, onDismiss, dismissThreshold = 110, velocityThreshold = 0.55 } = options;

	let startY = 0;
	let currentY = 0;
	let startTime = 0;
	let dragging = false;
	let armed = false;
	let scrollable: HTMLElement | null = null;

	const applyRest = (animate = true) => {
		if (animate) sheet.classList.remove('sheet-dragging');
		else sheet.classList.add('sheet-dragging');
		sheet.style.transform = 'translate3d(0, 0, 0)';
	};

	applyRest(false);
	requestAnimationFrame(() => applyRest(true));

	function isScrollableAtTop(el: HTMLElement): boolean {
		return el.scrollTop <= 1;
	}

	function findScrollableAncestor(target: EventTarget | null): HTMLElement | null {
		let node = target as HTMLElement | null;
		while (node && node !== sheet) {
			const style = getComputedStyle(node);
			if (
				(style.overflowY === 'auto' || style.overflowY === 'scroll') &&
				node.scrollHeight > node.clientHeight + 8
			) {
				return node;
			}
			node = node.parentElement;
		}
		return null;
	}

	function isHandle(target: EventTarget | null): boolean {
		let node = target as HTMLElement | null;
		while (node && node !== sheet) {
			if (node.dataset?.sheetHandle === 'true') return true;
			node = node.parentElement;
		}
		return false;
	}

	function onTouchStart(e: TouchEvent) {
		if (e.touches.length !== 1) return;
		startY = e.touches[0].clientY;
		currentY = startY;
		startTime = Date.now();
		scrollable = findScrollableAncestor(e.target);
		const atTop = scrollable ? isScrollableAtTop(scrollable) : true;
		armed = isHandle(e.target) || atTop;
		dragging = false;
	}

	function onTouchMove(e: TouchEvent) {
		if (!armed || e.touches.length !== 1) return;
		currentY = e.touches[0].clientY;
		const dy = currentY - startY;
		if (!dragging) {
			if (Math.abs(dy) < 8) return;
			if (dy < 0) {
				armed = false;
				return;
			}
			if (dy > 0 && scrollable && !isScrollableAtTop(scrollable) && !isHandle(e.target)) {
				armed = false;
				return;
			}
			dragging = true;
			sheet.classList.add('sheet-dragging');
		}
		e.preventDefault();
		const h = sheet.getBoundingClientRect().height;
		let y = dy;
		if (y < 0) y = y * 0.18;
		if (y > h) y = h;
		sheet.style.transform = `translate3d(0, ${y}px, 0)`;
	}

	function onTouchEnd() {
		if (!dragging) {
			armed = false;
			return;
		}
		const h = sheet.getBoundingClientRect().height;
		const dy = currentY - startY;
		const dt = Math.max(Date.now() - startTime, 1);
		const velocity = dy / dt;

		dragging = false;
		armed = false;
		sheet.classList.remove('sheet-dragging');

		if ((velocity > velocityThreshold && dy > 36) || dy > dismissThreshold || dy > h * 0.28) {
			onDismiss();
			return;
		}
		applyRest(true);
	}

	sheet.addEventListener('touchstart', onTouchStart, { passive: true });
	sheet.addEventListener('touchmove', onTouchMove, { passive: false });
	sheet.addEventListener('touchend', onTouchEnd, { passive: true });
	sheet.addEventListener('touchcancel', onTouchEnd, { passive: true });

	return {
		destroy() {
			sheet.removeEventListener('touchstart', onTouchStart);
			sheet.removeEventListener('touchmove', onTouchMove);
			sheet.removeEventListener('touchend', onTouchEnd);
			sheet.removeEventListener('touchcancel', onTouchEnd);
		}
	};
}
