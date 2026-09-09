import type { KGNode } from '../../constants';
import { isLocalAssetNode } from '../Layout';
import type { BuildCtx, CanvasNode } from '../types';
import type { NodeKindProvider } from '../NodeKindProvider';

const DOCUMENT_KINDS = new Set(['pdf', 'document']);

function sourceIdOf(node: KGNode): string {
	const sid = node.properties?.source_id;
	return typeof sid === 'string' ? sid : '';
}

function documentFilename(node: KGNode): string {
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

function typeBadge(node: KGNode): string {
	const p = node.properties ?? {};
	const rel = typeof p.rel_path === 'string' ? p.rel_path : '';
	const title = typeof p.title === 'string' ? p.title : '';
	const name = (rel.split(/[/\\]/).pop() ?? title).toLowerCase();
	if (p.kind === 'pdf' || name.endsWith('.pdf')) return 'PDF';
	if (name.endsWith('.md') || name.endsWith('.markdown')) return 'MD';
	if (name.endsWith('.doc') || name.endsWith('.docx')) return 'DOC';
	if (name.endsWith('.html') || name.endsWith('.htm')) return 'HTML';
	if (name.endsWith('.txt')) return 'TXT';
	return 'DOC';
}

export const documentProvider: NodeKindProvider = {
	kind: 'document',
	classify(node: KGNode): boolean {
		const k = node.properties?.kind;
		return isLocalAssetNode(node) && typeof k === 'string' && DOCUMENT_KINDS.has(k);
	},
	shouldRender(node: KGNode, ctx: BuildCtx): boolean {
		return ctx.sourceOnline[sourceIdOf(node)] !== false;
	},
	buildCanvasFields(node: KGNode, _ctx: BuildCtx): Partial<CanvasNode> {
		return { textContent: [documentFilename(node), typeBadge(node)].join('\n') };
	},
	planeConfig: {
		color: 0x0b1220,
		textureSource: 'text',
		lodEnabled: false
	}
};
