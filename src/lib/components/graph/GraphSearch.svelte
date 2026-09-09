<script lang="ts">
	import { onDestroy, tick, untrack } from 'svelte';
	import { getChatList, getChatListBySearchText } from '$lib/apis/chats';
	import Chat from '$lib/components/chat/Chat.svelte';
	import Spinner from '$lib/components/common/Spinner.svelte';
	import { graphStore } from './stores/graph.svelte';
	import { isSearchMatch } from './search-match';
	import type { KGNode } from './constants';

	type ChatRow = {
		id: string;
		title: string;
		updated_at: number;
		time_range: string;
		snippet?: string;
	};

	let {
		open = $bindable(false),
		onselect
	}: {
		open?: boolean;
		onselect: (chatId: string) => void;
	} = $props();

	let inputEl: HTMLInputElement | undefined = $state();
	let query = $state('');
	let activeIdx = $state(0);
	let chatList = $state<ChatRow[]>([]);
	let chatsLoading = $state(false);
	let serverTimer: ReturnType<typeof setTimeout> | null = null;
	let previewTimer: ReturnType<typeof setTimeout> | null = null;
	let chatGen = 0;
	let previewId = $state<string | null>(null);

	const token = () => (typeof localStorage !== 'undefined' ? (localStorage.token ?? '') : '');

	const isConversation = (node: KGNode) =>
		node.properties?.entity_type === 'Conversation' ||
		(node.labels ?? []).some((l) => l === 'Conversation');

	const canvasHits = $derived.by(() => {
		void graphStore.searchQuery;
		void graphStore.nodes;
		const ids = graphStore.searchMatchIds;
		const q = query.trim();
		if (!q || !ids) return [] as KGNode[];
		return graphStore.nodes
			.filter((n) => isSearchMatch(ids, n.id) && !isConversation(n))
			.slice(0, 24);
	});

	const selectableCount = $derived(chatList.length + canvasHits.length);

	const nodeTitle = (node: KGNode): string => {
		const p = node.properties ?? {};
		const title = String(p.title ?? p.name ?? '').trim();
		if (title) return title;
		for (const label of node.labels ?? []) {
			const l = String(label)
				.replace(/\s*\(conversation\)$/i, '')
				.trim();
			if (l && l.toLowerCase() !== 'conversation') return l;
		}
		return node.id;
	};

	const nodeKind = (node: KGNode): string => {
		const p = node.properties ?? {};
		return String(p.kind ?? p.entity_type ?? node.labels?.[0] ?? 'item');
	};

	const formatWhen = (updatedAt: number): string => {
		const ms = updatedAt > 1e12 ? updatedAt : updatedAt * 1000;
		if (!Number.isFinite(ms) || ms <= 0) return '';
		const d = new Date(ms);
		const now = new Date();
		const start = (x: Date) => Date.UTC(x.getFullYear(), x.getMonth(), x.getDate());
		const diff = Math.round((start(now) - start(d)) / 86400000);
		if (diff === 0) return 'Today';
		if (diff === 1) return 'Yesterday';
		if (diff > 1 && diff < 7) {
			return `Last ${d.toLocaleDateString(undefined, { weekday: 'long' })}`;
		}
		return d.toLocaleDateString(undefined, {
			month: '2-digit',
			day: '2-digit',
			year: 'numeric'
		});
	};

	const loadChats = async (q: string) => {
		const gen = ++chatGen;
		chatsLoading = true;
		try {
			const t = token();
			const trimmed = q.trim();
			let page = 1;
			let acc: ChatRow[] = [];
			while (page <= 25) {
				const rows = (
					trimmed
						? await getChatListBySearchText(t, trimmed, page)
						: await getChatList(t, page)
				) ?? [];
				if (gen !== chatGen) return;
				if (!Array.isArray(rows) || rows.length === 0) break;
				const seen = new Set(acc.map((c) => c.id));
				acc = [...acc, ...(rows as ChatRow[]).filter((c) => !seen.has(c.id))];
				chatList = acc;
				chatsLoading = false;
				page += 1;
			}
		} catch (err) {
			if (gen !== chatGen) return;
			console.error('[graph] search chats failed', err);
			if (chatList.length === 0) chatList = [];
		} finally {
			if (gen === chatGen) chatsLoading = false;
		}
	};

	const runQuery = (value: string) => {
		query = value;
		activeIdx = 0;
		graphStore.searchEntities(value);
		if (serverTimer) clearTimeout(serverTimer);
		serverTimer = setTimeout(() => {
			serverTimer = null;
			void graphStore.runServerSearch(token(), value);
			void loadChats(value);
		}, 220);
	};

	const schedulePreview = (chat: ChatRow) => {
		if (previewId === chat.id) return;
		if (previewTimer) clearTimeout(previewTimer);
		previewTimer = setTimeout(() => {
			previewTimer = null;
			previewId = chat.id;
		}, 80);
	};

	const activateChat = (i: number) => {
		activeIdx = i;
		const chat = chatList[i];
		if (chat) schedulePreview(chat);
	};

	const close = (clear = false) => {
		open = false;
		previewId = null;
		if (clear) {
			query = '';
			chatList = [];
			graphStore.clearSearch();
		}
	};

	const openSearch = () => {
		open = true;
	};

	const pickChat = (chat: ChatRow) => {
		onselect(chat.id);
		graphStore.requestFocus(chat.id);
		open = false;
	};

	const pickNode = (node: KGNode) => {
		graphStore.requestFocus(node.id);
		open = false;
	};

	const pickActive = () => {
		if (activeIdx < chatList.length) {
			const chat = chatList[activeIdx];
			if (chat) pickChat(chat);
			return;
		}
		const node = canvasHits[activeIdx - chatList.length];
		if (node) pickNode(node);
	};

	const onKeydown = (e: KeyboardEvent) => {
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			close(query.trim() === '');
			return;
		}
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			if (selectableCount) activateChat((activeIdx + 1) % selectableCount);
			return;
		}
		if (e.key === 'ArrowUp') {
			e.preventDefault();
			if (selectableCount) activateChat((activeIdx - 1 + selectableCount) % selectableCount);
			return;
		}
		if (e.key === 'Enter') {
			e.preventDefault();
			pickActive();
		}
	};

	$effect(() => {
		if (!open) return;
		const q = untrack(() => query);
		void loadChats(q);
		void tick().then(() => {
			inputEl?.focus();
			inputEl?.select();
		});
	});

	onDestroy(() => {
		if (serverTimer) clearTimeout(serverTimer);
		if (previewTimer) clearTimeout(previewTimer);
	});
</script>

{#if open}
	<button
		type="button"
		class="graph-search-scrim"
		aria-label="Close search"
		onclick={() => close(false)}
	></button>
	<div class="graph-search-host open">
		<div class="graph-search-panel" data-testid="graph-search">
			<div class="graph-search-field">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<circle cx="11" cy="11" r="7" />
					<path d="M20 20l-3-3" />
				</svg>
				<input
					bind:this={inputEl}
					class="graph-search-input"
					type="search"
					placeholder="Search conversations"
					spellcheck="false"
					autocomplete="off"
					aria-label="Search conversations"
					value={query}
					oninput={(e) => runQuery((e.currentTarget as HTMLInputElement).value)}
					onkeydown={onKeydown}
				/>
				{#if query}
					<button type="button" class="graph-search-clear" aria-label="Clear search" onclick={() => close(true)}>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
							<path stroke-linecap="round" d="M6 6l12 12M18 6L6 18" />
						</svg>
					</button>
				{/if}
			</div>
			<div class="graph-search-body">
			<ul class="graph-search-results" role="listbox">
				{#if chatsLoading && chatList.length === 0}
					<li class="graph-search-empty">Loading conversations…</li>
				{:else if chatList.length === 0 && canvasHits.length === 0}
					<li class="graph-search-empty">{query.trim() ? 'No results found' : 'No conversations yet'}</li>
				{:else}
					{#each chatList as chat, i (chat.id)}
						{#if i === 0 || chat.time_range !== chatList[i - 1].time_range}
							<li class="graph-search-range">{chat.time_range}</li>
						{/if}
						<li>
							<button
								type="button"
								class="graph-search-chat"
								class:active={i === activeIdx}
								role="option"
								aria-selected={i === activeIdx}
								onmouseenter={() => activateChat(i)}
								onclick={() => pickChat(chat)}
							>
								<span class="graph-search-chat-main">
									<span class="graph-search-title">{chat.title}</span>
									{#if chat.snippet}
										<span class="graph-search-snippet">{chat.snippet}</span>
									{/if}
								</span>
								<span class="graph-search-when">{formatWhen(chat.updated_at)}</span>
							</button>
						</li>
					{/each}
					{#if canvasHits.length > 0}
						<li class="graph-search-range">On the canvas</li>
						{#each canvasHits as node, i (node.id)}
							<li>
								<button
									type="button"
									class="graph-search-hit"
									class:active={chatList.length + i === activeIdx}
									role="option"
									aria-selected={chatList.length + i === activeIdx}
									onmouseenter={() => (activeIdx = chatList.length + i)}
									onclick={() => pickNode(node)}
								>
									<span class="graph-search-kind">{nodeKind(node)}</span>
									<span class="graph-search-title">{nodeTitle(node)}</span>
								</button>
							</li>
						{/each}
					{/if}
				{/if}
			</ul>
			<div class="graph-search-preview graph-chat-panel">
				{#if previewId}
					{#key previewId}
						<Chat
							embedded={true}
							chatIdProp={previewId}
							embeddedChats={chatList}
							onSelectEmbeddedChat={(id) => {
								previewId = id;
							}}
							onCloseEmbedded={() => {
								previewId = null;
							}}
						/>
					{/key}
				{:else}
					<div class="graph-search-preview-empty">Hover a conversation to preview</div>
				{/if}
			</div>
			</div>
		</div>
	</div>
{/if}

<style>
	.graph-search-scrim {
		position: fixed;
		inset: 0;
		z-index: 49;
		border: 0;
		padding: 0;
		background: transparent;
		cursor: default;
	}

	.graph-search-host {
		position: fixed;
		top: calc(20px + env(safe-area-inset-top, 0px));
		left: 50%;
		transform: translateX(-50%);
		z-index: 50;
		pointer-events: auto;
		width: min(920px, calc(100% - 4rem));
	}

	.graph-search {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0;
		width: 44px;
		height: 44px;
		padding: 0;
		border: 1px solid transparent;
		border-radius: 50%;
		background: transparent;
		backdrop-filter: none;
		-webkit-backdrop-filter: none;
		box-shadow: none;
		color: oklch(92% 0.02 210);
		font-family: var(--font-mono, 'JetBrains Mono', ui-monospace, monospace);
		font-size: 13px;
		font-weight: 500;
		letter-spacing: 0.04em;
		white-space: nowrap;
		cursor: pointer;
		text-align: left;
		transition: background 0.2s, color 0.2s, border-color 0.2s, box-shadow 0.2s;
	}
	.graph-search svg {
		width: 20px;
		height: 20px;
		flex-shrink: 0;
		color: oklch(82% 0.14 210);
	}
	.graph-search:hover {
		background: oklch(14% 0.025 255 / 88%);
		border-color: oklch(82% 0.14 210 / 50%);
	}
	.graph-search:focus-visible {
		outline: none;
		border-color: oklch(82% 0.14 210 / 70%);
		box-shadow:
			0 8px 28px oklch(0% 0 0 / 45%),
			0 0 0 3px oklch(82% 0.14 210 / 25%);
	}

	.graph-search-panel {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 8px;
		border-radius: 20px;
		border: 1px solid oklch(82% 0.14 210 / 28%);
		background: oklch(10% 0.02 255 / 88%);
		backdrop-filter: blur(28px) saturate(1.5);
		-webkit-backdrop-filter: blur(28px) saturate(1.5);
		box-shadow:
			0 16px 48px oklch(0% 0 0 / 50%),
			0 0 0 1px oklch(50% 0.03 255 / 10%);
	}

	.graph-search-field {
		display: flex;
		align-items: center;
		gap: 10px;
		height: 40px;
		padding: 0 10px 0 14px;
		border-radius: 100px;
		background: oklch(16% 0.02 255 / 55%);
		border: 1px solid oklch(82% 0.14 210 / 18%);
	}
	.graph-search-field svg {
		width: 16px;
		height: 16px;
		flex-shrink: 0;
		color: oklch(82% 0.14 210);
	}
	.graph-search-input {
		flex: 1;
		min-width: 0;
		height: 100%;
		border: 0;
		background: transparent;
		color: oklch(92% 0.02 210);
		font-family: var(--font-mono, 'JetBrains Mono', ui-monospace, monospace);
		font-size: 13px;
		letter-spacing: 0.04em;
		outline: none;
	}
	.graph-search-input::placeholder {
		color: oklch(62% 0.02 250);
	}
	.graph-search-clear {
		width: 28px;
		height: 28px;
		display: flex;
		align-items: center;
		justify-content: center;
		border: 0;
		border-radius: 50%;
		background: transparent;
		color: oklch(70% 0.02 250);
		cursor: pointer;
	}
	.graph-search-clear svg {
		width: 14px;
		height: 14px;
	}
	.graph-search-clear:hover {
		color: oklch(92% 0.02 210);
		background: oklch(20% 0.02 255 / 50%);
	}

	.graph-search-body {
		display: flex;
		align-items: stretch;
		min-height: 0;
		max-height: min(70vh, 640px);
	}
	.graph-search-results {
		margin: 0;
		padding: 0 2px 4px;
		list-style: none;
		flex: 1 1 52%;
		min-width: 0;
		overflow-y: auto;
	}
	.graph-search-preview {
		flex: 1 1 48%;
		min-width: 0;
		display: flex;
		flex-direction: column;
		border-left: 1px solid oklch(82% 0.14 210 / 16%);
		background: oklch(7% 0.02 260 / 94%);
		border-radius: 0 12px 12px 0;
		overflow: hidden;
	}
	.graph-search-preview :global(#note-chat-container) {
		height: 100%;
		background: transparent;
	}
	.graph-search-preview-empty {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 220px;
		padding: 16px;
		color: oklch(62% 0.02 250);
		font-family: var(--font-mono, 'JetBrains Mono', ui-monospace, monospace);
		font-size: 12px;
		letter-spacing: 0.03em;
		text-align: center;
	}
	.graph-search-empty {
		padding: 10px 12px;
		color: oklch(62% 0.02 250);
		font-family: var(--font-mono, 'JetBrains Mono', ui-monospace, monospace);
		font-size: 12px;
	}
	.graph-search-range {
		padding: 10px 12px 4px;
		color: oklch(62% 0.02 250);
		font-family: var(--font-mono, 'JetBrains Mono', ui-monospace, monospace);
		font-size: 10px;
		font-weight: 500;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}
	.graph-search-chat {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		width: 100%;
		padding: 8px 12px;
		border: 0;
		border-radius: 12px;
		background: transparent;
		color: oklch(92% 0.01 210);
		cursor: pointer;
		text-align: left;
	}
	.graph-search-chat.active,
	.graph-search-chat:hover,
	.graph-search-hit.active,
	.graph-search-hit:hover {
		background: oklch(82% 0.14 210 / 12%);
	}
	.graph-search-chat-main {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
		flex: 1;
	}
	.graph-search-when {
		flex-shrink: 0;
		color: oklch(62% 0.02 250);
		font-family: var(--font-mono, 'JetBrains Mono', ui-monospace, monospace);
		font-size: 11px;
		letter-spacing: 0.02em;
		white-space: nowrap;
	}
	.graph-search-snippet {
		color: oklch(62% 0.02 250);
		font-size: 11px;
		line-height: 1.35;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.graph-search-hit {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
		width: 100%;
		padding: 8px 12px;
		border: 0;
		border-radius: 12px;
		background: transparent;
		color: oklch(92% 0.01 210);
		cursor: pointer;
		text-align: left;
	}
	.graph-search-kind {
		font-family: var(--font-mono, 'JetBrains Mono', ui-monospace, monospace);
		font-size: 9px;
		font-weight: 500;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: oklch(82% 0.14 210 / 80%);
	}
	.graph-search-title {
		font-size: 13px;
		font-weight: 500;
		line-height: 1.3;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 100%;
	}

	@media (max-width: 768px) {
		.graph-search-host,
		.graph-search-host.open {
			left: 16px;
			right: auto;
			transform: none;
			width: calc(100% - 5.5rem);
		}
		.graph-search-preview {
			display: none;
		}
	}
</style>
