import type { KGNode } from '../../constants';
import type { BuildCtx, CanvasNode } from '../types';
import type { NodeKindProvider } from '../NodeKindProvider';

function isConversationNode(node: KGNode): boolean {
	const et = node.properties?.entity_type;
	if (typeof et === 'string' && et === 'Conversation') return true;
	return node.labels?.some((l) => l === 'Conversation' || l.endsWith(' (Conversation)')) ?? false;
}

function formatConversationDate(ms: number): string {
	const d = new Date(ms > 1e12 ? ms : ms * 1000);
	if (isNaN(d.getTime())) return '';
	const day = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	return `${day} · ${d.getFullYear()}`;
}

export const conversationProvider: NodeKindProvider = {
	kind: 'conversation',
	classify: isConversationNode,
	shouldRender(): boolean {
		return true;
	},
	buildCanvasFields(node: KGNode, _ctx: BuildCtx): Partial<CanvasNode> {
		const np = node.properties ?? {};
		const title = (np.name as string) ?? (np.title as string) ?? node.id;
		const createdAt =
			typeof np.createdAt === 'number'
				? np.createdAt
				: typeof np.created_at === 'number'
					? np.created_at
					: null;
		const dateLabel = createdAt !== null ? formatConversationDate(createdAt) : '';
		const excerpt = [np.excerpt, np.summary, np.description]
			.find((v): v is string => typeof v === 'string' && v.trim().length > 0)
			?.trim();
		const lines = [title];
		if (excerpt && excerpt.toLowerCase() !== String(title).toLowerCase()) lines.push(excerpt);
		if (dateLabel) lines.push(dateLabel);
		return { textContent: lines.join('\n') };
	},
	planeConfig: {
		color: 0x0b1220,
		textureSource: 'text',
		lodEnabled: false
	}
};