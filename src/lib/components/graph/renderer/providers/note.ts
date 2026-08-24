import type { KGNode } from '../../constants';
import { isNoteNode } from '../Layout';
import type { BuildCtx, CanvasNode } from '../types';
import type { NodeKindProvider } from '../NodeKindProvider';

export const noteProvider: NodeKindProvider = {
	kind: 'note',
	classify: isNoteNode,
	shouldRender(): boolean {
		return false;
	},
	buildCanvasFields(node: KGNode, _ctx: BuildCtx): Partial<CanvasNode> {
		const np = node.properties ?? {};
		const text =
			(np.description as string | undefined) ??
			(np.summary as string | undefined) ??
			(np.title as string | undefined) ??
			node.id;
		return { textContent: typeof text === 'string' ? text : node.id };
	},
	planeConfig: {
		color: 0xf5e9c8,
		textureSource: 'text',
		lodEnabled: false
	}
};