<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import type { SceneManager } from './renderer/SceneManager';
	import { conversationOverlay } from './renderer/conversation-overlay-flag';
	import { graphStore } from './stores/graph.svelte';
	import { isSearchMatch } from './search-match';
	import type { ConversationCard } from './conversation-card';

	let {
		sceneManager,
		onselectconversation,
		hidden = false,
		previewCards
	}: {
		sceneManager?: SceneManager;
		onselectconversation: (id: string) => void;
		hidden?: boolean;
		previewCards?: ConversationCard[];
	} = $props();

	let clouds = $state<ConversationCard[]>([]);
	let layerEl: HTMLDivElement | undefined = $state();
	let raf = 0;
	let lastKey = '';
	let tipOn = $state(false);
	let tipX = $state(0);
	let tipY = $state(0);

	function onCardMove(e: MouseEvent): void {
		const rect = layerEl?.getBoundingClientRect();
		if (!rect) return;
		tipOn = true;
		tipX = e.clientX - rect.left;
		tipY = e.clientY - rect.top;
	}
	const matchIds = $derived.by(() => {
		void graphStore.searchQuery;
		return graphStore.searchMatchIds;
	});

	function formatMeta(properties: Record<string, unknown>): string {
		const raw = properties.createdAt ?? properties.created_at;
		const ms = typeof raw === 'number' ? (raw > 1e12 ? raw : raw * 1000) : NaN;
		if (!Number.isFinite(ms)) return '';
		const d = new Date(ms);
		const day = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
		return `${day} · ${d.getFullYear()}`;
	}

	function cardExcerpt(properties: Record<string, unknown>, title: string): string {
		const raw = [properties.excerpt, properties.summary, properties.description]
			.find((v): v is string => typeof v === 'string' && v.trim().length > 0)
			?.trim();
		if (!raw || raw.toLowerCase() === title.toLowerCase()) return '';
		return raw;
	}

	function tick(): void {
		conversationOverlay.active = true;
		const sm = sceneManager;
		if (!sm) {
			if (clouds.length) clouds = [];
			return;
		}

		if (hidden) {
			if (clouds.length) clouds = [];
			lastKey = '';
			tipOn = false;
			return;
		}

		const cam = sm.cameraPosition;
		const seen = new Set<string>();
		const next: ConversationCard[] = [];
		for (const id of sm.getVisibleNodeIds()) {
			if (seen.has(id)) continue;
			seen.add(id);
			const cn = sm.getCanvasNode(id);
			if (cn?.kind !== 'conversation') continue;
			const world = sm.getPlaneWorldPosition(id);
			if (!world) continue;
			const screen = sm.projectToScreen(world);
			if (!screen) continue;
			if (screen.x < -200 || screen.y < -200 || screen.x > window.innerWidth + 200) continue;
			const dist = Math.hypot(world.x - cam.x, world.y - cam.y, world.z - cam.z);
			const scale = Math.max(0.34, Math.min(1.08, 420 / Math.max(dist, 90)));
			if (scale < 0.36) continue;
			const title =
				(cn.properties?.name as string) ??
				(cn.properties?.title as string) ??
				'Conversation';
			next.push({
				chatId: id,
				title,
				meta: formatMeta(cn.properties ?? {}),
				excerpt: cardExcerpt(cn.properties ?? {}, title),
				cx: screen.x,
				cy: screen.y,
				scale,
				z: Math.round(20000 - dist),
				dist,
				lod: 'compact'
			});
		}

		next.sort((a, b) => a.dist - b.dist);
		const kept: ConversationCard[] = [];
		for (const c of next) {
			const hits = kept.some((k) => {
				const dx = Math.abs(c.cx - k.cx);
				const dy = Math.abs(c.cy - k.cy);
				const ox = (176 * c.scale + 176 * k.scale) / 2 - dx;
				const oy = (228 * c.scale + 228 * k.scale) / 2 - dy;
				return ox > 8 && oy > 8;
			});
			if (!hits) kept.push(c);
		}
		kept.sort((a, b) => b.dist - a.dist);

		const key = kept
			.map((c) => `${c.chatId}:${Math.round(c.cx / 4)}:${Math.round(c.cy / 4)}:${c.scale.toFixed(2)}`)
			.join('|');
		if (key === lastKey) {
			return;
		}
		lastKey = key;
		clouds = kept;
	}

	$effect(() => {
		if (previewCards) clouds = previewCards;
	});

	onMount(() => {
		conversationOverlay.active = true;
		if (previewCards) {
			return () => {
				conversationOverlay.active = false;
			};
		}
		const el = layerEl;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			sceneManager?.handleWheel(e);
		};
		const onGesture = (e: Event) => {
			e.preventDefault();
		};
		if (el) {
			el.addEventListener('wheel', onWheel, { passive: false, capture: true });
			el.addEventListener('gesturestart', onGesture, { passive: false, capture: true });
			el.addEventListener('gesturechange', onGesture, { passive: false, capture: true });
		}
		const loop = () => {
			tick();
			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);
		return () => {
			cancelAnimationFrame(raf);
			if (!el) return;
			el.removeEventListener('wheel', onWheel, true);
			el.removeEventListener('gesturestart', onGesture, true);
			el.removeEventListener('gesturechange', onGesture, true);
		};
	});

	onDestroy(() => {
		if (raf) cancelAnimationFrame(raf);
		conversationOverlay.active = false;
	});
</script>

<div bind:this={layerEl} class="cloud-layer" class:hidden aria-hidden={hidden || clouds.length === 0}>
	{#each clouds as c (c.chatId)}
		<button
			type="button"
			class="month-card"
			class:search-hit={isSearchMatch(matchIds, c.chatId)}
			style="left: {c.cx}px; top: {c.cy}px; z-index: {c.z}; transform: translate(-50%, -50%) scale({c.scale});"
			onclick={() => onselectconversation(c.chatId)}
			onmousemove={onCardMove}
			onmouseleave={() => (tipOn = false)}
		>
			<span class="month-title">{c.excerpt || c.title}</span>
			{#if c.meta || c.excerpt}
				<span class="month-caption">
					{#if c.excerpt}
						<span class="month-caption-title">{c.title}</span>
					{/if}
					{#if c.meta}
						<time class="month-meta">{c.meta}</time>
					{/if}
				</span>
			{/if}
		</button>
	{/each}
	{#if tipOn}
		<div class="hover-tooltip" style="left: {tipX + 14}px; top: {tipY + 14}px;">Click to view convo</div>
	{/if}
</div>

<style>
	.cloud-layer {
		position: absolute;
		inset: 0;
		z-index: 12;
		pointer-events: none;
		overflow: hidden;
		touch-action: none;
		opacity: 1;
		transition: opacity 0.12s linear;
	}

	.cloud-layer.hidden {
		opacity: 0;
		pointer-events: none;
	}

	.cloud-layer.hidden .month-card {
		pointer-events: none;
	}

	.month-card {
		position: absolute;
		transform-origin: center center;
		pointer-events: auto;
		touch-action: none;
		box-sizing: border-box;
		width: 176px;
		min-height: 228px;
		padding: 22px 18px 14px;
		border: 10px solid #2a1c14;
		border-radius: 1px;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		text-align: left;
		cursor: pointer;
		color: #2a1c12;
		background:
			linear-gradient(180deg, rgba(40, 24, 12, 0.12), transparent 14%),
			linear-gradient(90deg, rgba(40, 24, 12, 0.08), transparent 10%),
			linear-gradient(180deg, rgba(255, 248, 230, 0.22), transparent 40%),
			#f4ead8;
		box-shadow:
			inset 0 0 0 3px #c4a056,
			inset 0 0 0 4px #1a120c,
			0 14px 32px rgba(0, 0, 0, 0.48);
	}

	.month-card:hover {
		background:
			linear-gradient(180deg, rgba(40, 24, 12, 0.1), transparent 14%),
			linear-gradient(90deg, rgba(40, 24, 12, 0.06), transparent 10%),
			linear-gradient(180deg, rgba(255, 248, 230, 0.38), transparent 40%),
			#f7efe0;
		box-shadow:
			inset 0 0 0 3px #e0c878,
			inset 0 0 0 4px #1a120c,
			0 18px 36px rgba(0, 0, 0, 0.55);
	}

	.month-card.search-hit {
		box-shadow:
			inset 0 0 0 3px #e8d48a,
			inset 0 0 0 4px #1a120c,
			0 0 0 1px rgba(196, 160, 86, 0.45),
			0 18px 36px rgba(0, 0, 0, 0.55);
	}

	.month-title {
		font-family: 'Fraunces', Georgia, serif;
		font-size: 1.28rem;
		font-weight: 500;
		line-height: 1.16;
		letter-spacing: -0.03em;
		color: #24180f;
		flex: 1;
		display: -webkit-box;
		-webkit-line-clamp: 5;
		line-clamp: 5;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.month-caption {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
		width: 100%;
		margin-top: 12px;
		padding-top: 10px;
		border-top: 1px solid rgba(110, 92, 68, 0.28);
	}

	.month-caption-title {
		font-family: 'JetBrains Mono', ui-monospace, monospace;
		font-size: 0.58rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: #6e5c44;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}

	.month-meta {
		display: block;
		margin-left: auto;
		font-family: 'JetBrains Mono', ui-monospace, monospace;
		font-size: 0.58rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: #6e5c44;
		white-space: nowrap;
	}

	.hover-tooltip {
		position: absolute;
		z-index: 30;
		padding: 5px 12px;
		background: oklch(16% 0.015 255 / 45%);
		backdrop-filter: blur(20px) saturate(1.4);
		-webkit-backdrop-filter: blur(20px) saturate(1.4);
		border-radius: 100px;
		box-shadow: 0 0 0 1px oklch(50% 0.03 255 / 8%);
		color: oklch(65% 0.02 255);
		font-family: 'JetBrains Mono', ui-monospace, monospace;
		font-size: 11px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		white-space: nowrap;
		pointer-events: none;
	}
</style>
