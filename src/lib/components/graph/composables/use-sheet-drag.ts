import { browser } from '$app/environment';

export type SheetSnap = 'peek' | 'full';

interface SheetDragOptions {
	sheet: HTMLElement;
	onDismiss: () => void;
	getSnap: () => SheetSnap;
	setSnap: (snap: SheetSnap) => void;
	peekRatio?: number;
	dismissThreshold?: number;
	velocityThreshold?: number;
}

export function createSheetDrag(options: SheetDragOptions) {
	if (!browser) return { destroy: () => {} };

	const {
		sheet,
		onDismiss,
		getSnap,
		setSnap,
		peekRatio = 0.42,
		dismissThreshold = 110,
		velocityThreshold = 0.55
	} = options;

	let startY = 0;
	let currentY = 0;
	let startTime = 0;
	let startTranslate = 0;
	let dragging = false;
	let armed = false;
	let scrollable: HTMLElement | null = null;

	const restY = (snap: SheetSnap, h: number) => (snap === 'full' ? 0 : h * peekRatio);

	const applyRest = (snap: SheetSnap, animate = true) => {
		const y = restY(snap, sheet.getBoundingClientRect().height);
		sheet.classList.toggle('sheet-expanded', snap === 'full');
		if (animate) sheet.classList.remove('sheet-dragging');
		else sheet.classList.add('sheet-dragging');
		sheet.style.transform = `translate3d(0, ${y}px, 0)`;
	};

	applyRest(getSnap(), false);
	requestAnimationFrame(() => applyRest(getSnap(), true));

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
		startTranslate = restY(getSnap(), sheet.getBoundingClientRect().height);
		scrollable = findScrollableAncestor(e.target);
		const atTop = scrollable ? isScrollableAtTop(scrollable) : true;
		const handle = isHandle(e.target);
		armed = handle || atTop || getSnap() === 'peek';
		dragging = false;
	}

	function onTouchMove(e: TouchEvent) {
		if (!armed || e.touches.length !== 1) return;
		currentY = e.touches[0].clientY;
		const dy = currentY - startY;
		if (!dragging) {
			if (Math.abs(dy) < 8) return;
			if (dy < 0 && getSnap() === 'full' && scrollable && !isScrollableAtTop(scrollable)) {
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
		let y = startTranslate + dy;
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
		const y = Math.max(0, startTranslate + dy);
		const dt = Math.max(Date.now() - startTime, 1);
		const velocity = dy / dt;
		const peekY = restY('peek', h);
		const snap = getSnap();

		dragging = false;
		armed = false;
		sheet.classList.remove('sheet-dragging');

		if (velocity > velocityThreshold && dy > 36) {
			if (snap === 'full') {
				setSnap('peek');
				applyRest('peek');
			} else {
				onDismiss();
			}
			return;
		}
		if (velocity < -velocityThreshold && dy < -28) {
			setSnap('full');
			applyRest('full');
			return;
		}

		const midPeekDismiss = (peekY + h) / 2;
		const midFullPeek = peekY / 2;
		if (y >= midPeekDismiss || (snap === 'peek' && dy > dismissThreshold)) {
			onDismiss();
			return;
		}
		if (y <= midFullPeek) {
			setSnap('full');
			applyRest('full');
			return;
		}
		setSnap('peek');
		applyRest('peek');
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
