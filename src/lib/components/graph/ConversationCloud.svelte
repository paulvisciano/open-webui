<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import type { SceneManager } from './renderer/SceneManager';
	import { conversationOverlay } from './renderer/conversation-overlay-flag';
	import { graphStore } from './stores/graph.svelte';
	import { isSearchMatch } from './search-match';
	import { SEARCH_DIM } from './renderer/constants';

	type Cloud = {
		chatId: string;
		title: string;
		meta: string;
		cx: number;
		cy: number;
		scale: number;
		z: number;
		dist: number;
		lod: 'compact';
	};

	let {
		sceneManager,
		onselectconversation,
		hidden = false
	}: {
		sceneManager?: SceneManager;
		onselectconversation: (id: string) => void;
		hidden?: boolean;
	} = $props();

	let clouds = $state<Cloud[]>([]);
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

	function searchOpacity(id: string): number {
		if (matchIds === null) return 1;
		return isSearchMatch(matchIds, id) ? 1 : SEARCH_DIM;
	}

	function formatMeta(properties: Record<string, unknown>): string {
		const raw = properties.createdAt ?? properties.created_at;
		const ms = typeof raw === 'number' ? (raw > 1e12 ? raw : raw * 1000) : NaN;
		if (!Number.isFinite(ms)) return '';
		const d = new Date(ms);
		const day = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
		return `${day} · ${d.getFullYear()}`;
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
		const next: Cloud[] = [];
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
			next.push({
				chatId: id,
				title:
					(cn.properties?.name as string) ??
					(cn.properties?.title as string) ??
					'Conversation',
				meta: formatMeta(cn.properties ?? {}),
				cx: screen.x,
				cy: screen.y,
				scale,
				z: Math.round(20000 - dist),
				dist,
				lod: 'compact'
			});
		}

		next.sort((a, b) => a.dist - b.dist);
		const kept: Cloud[] = [];
		for (const c of next) {
			const hits = kept.some((k) => {
				const dx = Math.abs(c.cx - k.cx);
				const dy = Math.abs(c.cy - k.cy);
				const ox = (252 * c.scale + 252 * k.scale) / 2 - dx;
				const oy = (132 * c.scale + 132 * k.scale) / 2 - dy;
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

	onMount(() => {
		conversationOverlay.active = true;
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
			style="left: {c.cx}px; top: {c.cy}px; z-index: {c.z}; opacity: {searchOpacity(c.chatId)}; transform: translate(-50%, -50%) scale({c.scale});"
			onclick={() => onselectconversation(c.chatId)}
			onmousemove={onCardMove}
			onmouseleave={() => (tipOn = false)}
		>
			<span class="month-glyph">Conversation</span>
			<span class="month-title">{c.title}</span>
			{#if c.meta}
				<time class="month-meta">{c.meta}</time>
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
		/* Scoped tokens from unused styles.css / vision deck — do not import styles.css (it would restyle OWUI). */
		--cyber-cyan: #00d4ff;
		--accent-cyan: #13dcf6;
		--glass-bg: linear-gradient(180deg, rgba(0, 212, 255, 0.07), rgba(8, 14, 26, 0.58));
		position: absolute;
		transform-origin: center center;
		pointer-events: auto;
		touch-action: none;
		box-sizing: border-box;
		width: 252px;
		min-height: 132px;
		padding: 18px 20px 16px;
		border: 1px solid rgba(0, 212, 255, 0.38);
		border-radius: 14px;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		text-align: left;
		cursor: pointer;
		color: #e8eef6;
		background: var(--glass-bg);
		backdrop-filter: blur(18px) saturate(1.2);
		-webkit-backdrop-filter: blur(18px) saturate(1.2);
		box-shadow:
			0 0 0 1px rgba(0, 212, 255, 0.08),
			0 0 15px rgba(0, 212, 255, 0.28),
			0 24px 60px rgba(0, 0, 0, 0.45);
	}

	.month-card:hover {
		border-color: rgba(0, 212, 255, 0.7);
		box-shadow:
			0 0 0 1px rgba(0, 212, 255, 0.16),
			0 0 18px rgba(19, 220, 246, 0.35),
			0 24px 60px rgba(0, 0, 0, 0.5);
	}

	.month-card.search-hit {
		border-color: var(--accent-cyan);
		box-shadow:
			0 0 0 1px rgba(19, 220, 246, 0.28),
			0 0 18px rgba(19, 220, 246, 0.5),
			0 24px 60px rgba(0, 0, 0, 0.45);
	}

	.month-glyph {
		font-family: 'JetBrains Mono', ui-monospace, monospace;
		font-size: 0.58rem;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: var(--cyber-cyan);
		margin-bottom: 10px;
	}

	.month-title {
		font-family: 'Fraunces', Georgia, serif;
		font-size: 1.15rem;
		font-weight: 400;
		line-height: 1.25;
		letter-spacing: -0.02em;
		color: #f4fbff;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.month-meta {
		display: block;
		margin-top: 8px;
		font-family: 'JetBrains Mono', ui-monospace, monospace;
		font-size: 0.62rem;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--cyber-cyan);
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
