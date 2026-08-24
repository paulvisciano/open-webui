import { isEventNode } from '../Layout';
import type { CanvasNode } from '../types';
import type { NodeKindProvider } from '../NodeKindProvider';

export const eventProvider: NodeKindProvider = {
	kind: 'event',
	classify: isEventNode,
	shouldRender(): boolean {
		return false;
	},
	buildCanvasFields(): Partial<CanvasNode> {
		return {};
	},
	planeConfig: {
		color: 0xf6c344,
		textureSource: 'none',
		lodEnabled: false
	}
};