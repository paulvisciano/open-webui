import type { KGNode } from '../../constants';
import { isLocalAssetNode } from '../Layout';
import type { BuildCtx, CanvasNode } from '../types';
import type { NodeKindProvider } from '../NodeKindProvider';
import { getAssetThumbUrl } from '$lib/apis/graph';

function sourceIdOf(node: KGNode): string {
	const sid = node.properties?.source_id;
	return typeof sid === 'string' ? sid : '';
}

export const videoProvider: NodeKindProvider = {
	kind: 'video',
	classify(node: KGNode): boolean {
		return isLocalAssetNode(node) && node.properties?.kind === 'video';
	},
	shouldRender(node: KGNode, ctx: BuildCtx): boolean {
		return ctx.sourceOnline[sourceIdOf(node)] !== false;
	},
	buildCanvasFields(node: KGNode, _ctx: BuildCtx): Partial<CanvasNode> {
		return { imageUrl: getAssetThumbUrl(node.id) };
	},
	planeConfig: {
		color: 0x0b1220,
		textureSource: 'url',
		lodEnabled: false
	}
};
