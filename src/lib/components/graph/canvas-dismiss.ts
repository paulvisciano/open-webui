/** Pointer travel (px) treated as a pan, not a canvas click. */
export const CANVAS_DISMISS_DRAG_PX = 6;

/**
 * Whether a canvas pointerup should close the conversation inspector.
 *
 * Clicking a conversation plaque sets `skipCanvasDismiss` in `openChat` so the
 * same pointerup that opened the panel cannot dismiss it. Empty-canvas clicks
 * still close the panel. A drag/pan never dismisses.
 */
export function shouldDismissChatPanel(input: {
	skipCanvasDismiss: boolean;
	panelOpen: boolean;
	dx?: number;
	dy?: number;
	dragThreshold?: number;
}): boolean {
	const threshold = input.dragThreshold ?? CANVAS_DISMISS_DRAG_PX;
	const dx = input.dx ?? 0;
	const dy = input.dy ?? 0;
	if (Math.abs(dx) >= threshold || Math.abs(dy) >= threshold) return false;
	if (input.skipCanvasDismiss) return false;
	return input.panelOpen;
}
