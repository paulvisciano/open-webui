import type { KGNode } from '../../constants';
import { isLocalAssetNode } from '../Layout';
import type { BuildCtx, CanvasNode } from '../types';
import type { NodeKindProvider } from '../NodeKindProvider';

function sourceIdOf(node: KGNode): string {
	const sid = node.properties?.source_id;
	return typeof sid === 'string' ? sid : '';
}

function audioFilename(node: KGNode): string {
	const p = node.properties ?? {};
	const title = p.title;
	if (typeof title === 'string' && title.length > 0) return title;
	const rel = p.rel_path;
	if (typeof rel === 'string' && rel.length > 0) {
		const base = rel.split(/[/\\]/).pop();
		if (base) return base;
	}
	return node.id;
}

export const audioProvider: NodeKindProvider = {
	kind: 'audio',
	classify(node: KGNode): boolean {
		return isLocalAssetNode(node) && node.properties?.kind === 'audio';
	},
	shouldRender(node: KGNode, ctx: BuildCtx): boolean {
		return ctx.sourceOnline[sourceIdOf(node)] !== false;
	},
	buildCanvasFields(node: KGNode, _ctx: BuildCtx): Partial<CanvasNode> {
		const filename = audioFilename(node);
		return { textContent: [filename, 'AUDIO'].join('\n') };
	},
	planeConfig: {
		color: 0x0b1220,
		textureSource: 'text',
		lodEnabled: false
	}
};
