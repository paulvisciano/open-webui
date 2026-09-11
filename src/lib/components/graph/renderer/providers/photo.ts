import type { KGNode } from '../../constants';
import { isChatImageNode, isLocalAssetNode, isPhotoNode } from '../Layout';
import type { BuildCtx, CanvasNode } from '../types';
import type { NodeKindProvider } from '../NodeKindProvider';
import { getAssetThumbUrl, getChatFileUrl, getImageUrl } from '$lib/apis/graph';

function photoFilename(node: KGNode): string | null {
	const p = node.properties ?? {};
	const f =
		(p.source_id as string | undefined) ??
		(p.file_path as string | undefined) ??
		(p.filename as string | undefined) ??
		(p.file_source as string | undefined);
	if (typeof f !== 'string' || f.length === 0) return null;
	return f;
}

function isStalePhoto(node: KGNode): boolean {
	const sourceId = node.properties?.source_id ?? node.properties?.file_path;
	return !sourceId || sourceId === 'manual_creation';
}

function isLibraryPhoto(node: KGNode): boolean {
	return isLocalAssetNode(node) && node.properties?.kind === 'photo';
}

function chatFileIdOf(node: KGNode): string {
	const fid = node.properties?.file_id;
	if (typeof fid === 'string' && fid.length > 0) return fid;
	const id = node.id ?? '';
	return id.startsWith('chatfile:') ? id.slice('chatfile:'.length) : '';
}

function sourceIdOf(node: KGNode): string {
	const sid = node.properties?.source_id;
	return typeof sid === 'string' ? sid : '';
}

export const photoProvider: NodeKindProvider = {
	kind: 'photo',
	classify(node: KGNode): boolean {
		return isPhotoNode(node) || isLibraryPhoto(node);
	},
	shouldRender(node: KGNode, ctx: BuildCtx): boolean {
		if (isChatImageNode(node)) return chatFileIdOf(node).length > 0;
		if (isLocalAssetNode(node)) {
			return ctx.sourceOnline[sourceIdOf(node)] !== false;
		}
		return !isStalePhoto(node);
	},
	buildCanvasFields(node: KGNode, ctx: BuildCtx): Partial<CanvasNode> {
		if (isChatImageNode(node)) {
			const fileId = chatFileIdOf(node);
			const url = fileId ? getChatFileUrl(fileId) : undefined;
			const cached = ctx.photoImages[node.id];
			return { imageUrl: cached ?? url, fullUrl: url };
		}
		if (isLocalAssetNode(node)) {
			const cached = ctx.photoImages[node.id];
			const fullUrl = getAssetThumbUrl(node.id, 1024);
			if (cached) return { imageUrl: cached, fullUrl };
			return {
				imageUrl: getAssetThumbUrl(node.id, 512),
				fullUrl
			};
		}
		const cached = ctx.photoImages[node.id];
		const fname = photoFilename(node);
		const fullUrl = fname ? getImageUrl(fname, 1024) : undefined;
		if (cached) return { imageUrl: cached, fullUrl };
		if (!fname) return {};
		return {
			imageUrl: getImageUrl(fname, 512),
			fullUrl
		};
	},
	planeConfig: {
		color: 0xffffff,
		textureSource: 'url',
		lodEnabled: true
	}
};
