import { describe, expect, it } from 'vitest';
import { CANVAS_DISMISS_DRAG_PX, shouldDismissChatPanel } from './canvas-dismiss';

describe('shouldDismissChatPanel', () => {
	it('does not close the inspector on the same pointerup that opened it', () => {
		expect(
			shouldDismissChatPanel({
				skipCanvasDismiss: true,
				panelOpen: true,
				dx: 0,
				dy: 0
			})
		).toBe(false);
	});

	it('closes the inspector on an empty canvas click', () => {
		expect(
			shouldDismissChatPanel({
				skipCanvasDismiss: false,
				panelOpen: true,
				dx: 0,
				dy: 0
			})
		).toBe(true);
	});

	it('does not dismiss when the panel is already closed', () => {
		expect(
			shouldDismissChatPanel({
				skipCanvasDismiss: false,
				panelOpen: false,
				dx: 0,
				dy: 0
			})
		).toBe(false);
	});

	it('does not dismiss when the pointer moved (pan)', () => {
		expect(
			shouldDismissChatPanel({
				skipCanvasDismiss: false,
				panelOpen: true,
				dx: CANVAS_DISMISS_DRAG_PX,
				dy: 0
			})
		).toBe(false);
	});
});
