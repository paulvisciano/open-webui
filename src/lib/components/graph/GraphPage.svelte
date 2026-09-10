<script lang="ts">
	import { getContext, onMount, tick, onDestroy } from 'svelte';
	import { fly } from 'svelte/transition';
	import type { Writable } from 'svelte/store';
	import type { i18n as i18nType } from 'i18next';

	import { showSidebar, mobile, showSearch } from '$lib/stores';
	import { createNewChat, getChatList, deleteChatById } from '$lib/apis/chats';
	import {
		browsePath,
		attachSource,
		detachSource,
		startScan
	} from '$lib/apis/graph';
	import type { GraphBrowseEntry } from '$lib/apis/graph';
	import { toast } from 'svelte-sonner';

	import CanvasView from './CanvasView.svelte';
	import GraphSearch from './GraphSearch.svelte';
	import Chat from '$lib/components/chat/Chat.svelte';
	import GraphVoiceOverlay from './GraphVoiceOverlay.svelte';
	import VoiceWaveform from './VoiceWaveform.svelte';
	import Spinner from '$lib/components/common/Spinner.svelte';
	import { VoiceCallService } from '$lib/components/chat/MessageInput/VoiceCallService.svelte';

	import { graphStore } from './stores/graph.svelte';
	import { scanProgressStore, countsFromScanResponse } from './stores/scan-progress.svelte';
	import type { KGNode } from './constants';
	import { createSheetDrag, type SheetSnap } from './composables/use-sheet-drag';
	import { CANVAS_DISMISS_DRAG_PX, shouldDismissChatPanel } from './canvas-dismiss';

	const i18n: Writable<i18nType> = getContext('i18n');

	const voiceStatusLabels = {
		thinking: 'Thinking...',
		muted: 'Muted',
		interrupt: 'Tap to interrupt',
		listening: 'Listening...'
	};

	// ── Chat panel state ──────────────────────────────────────────────
	let selectedChatId = $state<string>('');
	let chatDraftKey = $state<string>('');
	let showChatPanel = $state(false);
	let chatSheetEl: HTMLDivElement | undefined = $state();
	let sheetSnap: SheetSnap = $state('peek');
	let chatLoading = $state(false);
	let orbOptionsOpen = $state(false);
	let graphSearchOpen = $state(false);
	let corridorDate = $state<string | null>(null);
	let corridorTimelineOpen = $state(false);
	let orbCloseTimer: ReturnType<typeof setTimeout> | null = null;

	$effect(() => {
		if (!$showSearch) return;
		showSearch.set(false);
		graphSearchOpen = !graphSearchOpen;
	});

	const orbScheduleClose = () => {
		if (orbCloseTimer) clearTimeout(orbCloseTimer);
		orbCloseTimer = setTimeout(() => { orbOptionsOpen = false; }, 100);
	};

	const orbCancelClose = () => {
		if (orbCloseTimer) { clearTimeout(orbCloseTimer); orbCloseTimer = null; }
	};

	let recentChats = $state<any[]>([]);

	let voiceActive = $state(false);
	let voiceStarting = $state(false);
	let voiceService = $state<VoiceCallService | null>(null);
	let voiceChatApi: {
		eventTarget: EventTarget;
		submitPrompt: (content: string, opts?: Record<string, any>) => Promise<any>;
		stopResponse: (processQueue?: boolean) => Promise<void>;
		chatId: () => string;
		modelId: () => string;
	} | null = null;
	let voiceReadyResolve: (() => void) | null = null;

	// ── Folder attach (index in place; not the copy+VLM pipeline) ──
	const DEFAULT_FOLDER_PATH = '/Users/paulvisciano/Desktop/Takeout';
	let folderSheetOpen = $state(false);
	let folderPath = $state(DEFAULT_FOLDER_PATH);
	let folderPathInput: HTMLInputElement | undefined = $state();
	let browseEntries = $state<GraphBrowseEntry[]>([]);
	let browseLoading = $state(false);
	let browseError = $state('');
	let attaching = $state(false);
	let detachingId = $state('');
	const displayedSources = $derived.by(() =>
		graphStore.sources.map((s) => ({
			...s,
			online: graphStore.sourceOnline[s.id] ?? s.online
		}))
	);

	const graphToken = () =>
		typeof localStorage !== 'undefined' ? (localStorage.token ?? '') : '';

	const folderErrText = (err: unknown, fallback: string) => {
		if (typeof err === 'string' && err) return err;
		if (err instanceof Error && err.message) return err.message;
		return fallback;
	};

	const runBrowse = async (path: string) => {
		browseLoading = true;
		browseError = '';
		try {
			browseEntries = await browsePath(graphToken(), path);
		} catch (err) {
			browseEntries = [];
			browseError = folderErrText(err, 'Cannot browse path');
		} finally {
			browseLoading = false;
		}
	};

	const closeFolderSheet = () => {
		folderSheetOpen = false;
		browseError = '';
	};

	const openFolderSheet = async () => {
		folderSheetOpen = true;
		if (!folderPath.trim()) folderPath = DEFAULT_FOLDER_PATH;
		await runBrowse(folderPath.trim());
		await tick();
		folderPathInput?.focus();
		folderPathInput?.select();
	};

	const parentOf = (path: string) => {
		const trimmed = path.replace(/\/+$/, '');
		if (!trimmed || trimmed === '/') return '';
		const idx = trimmed.lastIndexOf('/');
		if (idx <= 0) return '/';
		return trimmed.slice(0, idx);
	};

	const enterBrowsePath = async (path: string) => {
		folderPath = path;
		await runBrowse(path);
	};

	const confirmAttachFolder = async () => {
		const absPath = folderPath.trim();
		if (!absPath || attaching) return;
		attaching = true;
		browseError = '';
		let startedId = '';
		try {
			const source = await attachSource(graphToken(), absPath);
			if (!source?.id) throw new Error('Attach failed');
			startedId = source.id;
			scanProgressStore.start(source.id, source.name || absPath);
			const scanRes = await startScan(graphToken(), source.id);
			scanProgressStore.applyCounts(source.id, countsFromScanResponse(scanRes));
			graphStore.sources = [source, ...graphStore.sources.filter((s) => s.id !== source.id)];
			graphStore.sourceOnline = { ...graphStore.sourceOnline, [source.id]: source.online };
			graphStore.startScanPoll(graphToken, source.id);
			toast.success(`Indexing ${source.name || absPath}`);
			closeFolderSheet();
		} catch (err) {
			console.error('[graph] attach folder failed', err);
			const msg = folderErrText(err, 'Attach failed');
			if (startedId) scanProgressStore.fail(startedId, msg);
			browseError = msg;
			toast.error(msg);
		} finally {
			attaching = false;
		}
	};

	const removeFolderFromGraph = async (sourceId: string) => {
		if (!sourceId || detachingId) return;
		detachingId = sourceId;
		try {
			await detachSource(graphToken(), sourceId);
			await graphStore.dropSource(sourceId);
			toast.success('Removed from graph. Files on disk were not deleted.');
		} catch (err) {
			console.error('[graph] detach folder failed', err);
			toast.error(folderErrText(err, 'Could not remove folder'));
		} finally {
			detachingId = '';
		}
	};

	// ── Conversation selection ───────────────────────────────────────
	const openChat = async (chatId: string) => {
		if (!chatId) return;
		// Same pointerup that selected this conversation also bubbles to the
		// canvas dismiss handler — skip that dismiss so the panel stays open.
		skipCanvasDismiss = true;
		showSidebar.set(false);
		chatLoading = true;
		selectedChatId = chatId;
		chatDraftKey = '';
		sheetSnap = 'peek';
		showChatPanel = true;
		graphStore.setActiveConversation(chatId);
		await tick();
		document.getElementById('chat-input')?.blur();
		(document.activeElement as HTMLElement | null)?.blur();
		chatLoading = false;
	};

	const startNewChat = async () => {
		showSidebar.set(false);
		selectedChatId = '';
		chatDraftKey = `${Date.now()}`;
		sheetSnap = 'peek';
		showChatPanel = true;
	};

	const startVoiceChat = async ({ continueChat = false } = {}) => {
		if (voiceStarting) return;
		if (voiceService) {
			await voiceService.stop();
			voiceService = null;
			voiceActive = false;
		}
		orbOptionsOpen = false;
		voiceStarting = true;
		const t0 = performance.now();
		console.log('[voice-timing]', new Date().toISOString().slice(11, 23), 'ui_start_pressed');

		let stream: MediaStream | null = null;
		let audioContext: AudioContext | null = null;
		try {
			stream = await navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
			});
			audioContext = new AudioContext();
			if (audioContext.state === 'suspended') await audioContext.resume();
			console.log(
				'[voice-timing]',
				new Date().toISOString().slice(11, 23),
				`getUserMedia_done  +${(performance.now() - t0).toFixed(0)}ms`
			);
		} catch {
			toast.error('Microphone permission denied');
			voiceStarting = false;
			return;
		}

		try {
			if (!continueChat) {
				await startNewChat();
			} else if (!showChatPanel) {
				await startNewChat();
			}
			await tick();
			if (!voiceChatApi) {
				await new Promise<void>((resolve) => {
					voiceReadyResolve = resolve;
				});
			}
			if (!voiceChatApi) {
				stream.getTracks().forEach((t) => t.stop());
				await audioContext.close();
				voiceStarting = false;
				return;
			}
			voiceService = new VoiceCallService({
				eventTarget: voiceChatApi.eventTarget,
				submitPrompt: voiceChatApi.submitPrompt,
				stopResponse: voiceChatApi.stopResponse,
				chatId: voiceChatApi.chatId() ?? selectedChatId,
				modelId: voiceChatApi.modelId() ?? '',
				audioStream: stream,
				audioContext
			});
			voiceActive = true;
			await voiceService.start();
		} catch (err) {
			console.error('[graph] startVoiceChat failed', err);
			stream.getTracks().forEach((t) => t.stop());
			await audioContext.close();
			voiceService = null;
			voiceActive = false;
		} finally {
			voiceStarting = false;
		}
	};

	const endVoiceChat = async () => {
		await voiceService?.stop();
		voiceService = null;
		voiceActive = false;
		showChatPanel = false;
	};

	const closeChatPanel = () => {
		if (voiceActive) return;
		showChatPanel = false;
		sheetSnap = 'peek';
		graphStore.setActiveConversation('');
	};

	$effect(() => {
		if ($showSidebar && showChatPanel) {
			showChatPanel = false;
		}
	});

	$effect(() => {
		const id = graphStore.pendingOpenChatId;
		if (!id) return;
		queueMicrotask(() => {
			if (graphStore.pendingOpenChatId === id) graphStore.pendingOpenChatId = null;
		});
		void openChat(id);
	});

	$effect(() => {
		if (!showChatPanel || !chatSheetEl || !$mobile || voiceActive) return;
		const drag = createSheetDrag({
			sheet: chatSheetEl,
			onDismiss: closeChatPanel,
			getSnap: () => sheetSnap,
			setSnap: (snap) => {
				sheetSnap = snap;
			}
		});
		return () => drag.destroy();
	});

	const createChatOnFirstMessage = async () => {
		const token = localStorage.token;
		const chat = await createNewChat(token, { messages: [] }, null).catch((err) => {
			console.error('[graph] createNewChat failed', err);
			toast.error(err?.message ?? 'Failed to create chat');
			return null;
		});
		if (chat?.id) {
			selectedChatId = chat.id;
			chatDraftKey = '';
			await refreshRecentChats();
			// Live-update the graph so the new conversation node appears immediately.
			await graphStore.loadConversations(token);
		}
		return chat;
	};

	const selectEmbeddedChat = async (id: string) => {
		if (!id || id === selectedChatId) return;
		selectedChatId = id;
		chatDraftKey = '';
		graphStore.setActiveConversation(id);
	};

	const deleteEmbeddedChat = async (id: string) => {
		if (!id) return;
		const token = localStorage.token;
		const wasCurrent = id === selectedChatId;
		await deleteChatById(token, id).catch((err) => {
			console.error('[graph] deleteChat failed', err);
			toast.error(err instanceof Error ? err.message : 'Failed to delete conversation');
			return null;
		});
		await refreshRecentChats();
		await graphStore.loadConversations(token);
		if (wasCurrent) {
			selectedChatId = '';
			chatDraftKey = '';
			showChatPanel = false;
			sheetSnap = 'peek';
			graphStore.setActiveConversation('');
		}
	};

	const onEmbeddedChatTitle = async (id: string, title: string) => {
		recentChats = recentChats.map((c) =>
			c.id === id ? { ...c, title, chat: { ...(c.chat ?? {}), title } } : c
		);
		// Live-update the conversation node title in the graph.
		const token = localStorage.token;
		await graphStore.loadConversations(token);
	};

	const refreshRecentChats = async () => {
		const token = localStorage.token;
		const chats = await getChatList(token, 0).catch((err) => {
			console.error('[graph] getChatList failed', err);
			return null;
		});
		if (chats) recentChats = chats;
	};

	const queryAbout = (node: KGNode) => {
		const label = node.labels?.[0] ?? 'entity';
		const name = (node.properties?.name as string) ?? (node.properties?.title as string) ?? node.id;
		const seedPrompt = `Tell me about ${name} (${label})`;
		chatDraftKey = `${Date.now()}`;
		showChatPanel = true;
		pendingSeedPrompt = seedPrompt;
	};

	let pendingSeedPrompt = $state<string>('');

	let panelClickStart: { x: number; y: number } | null = null;
	let skipCanvasDismiss = false;

	const handleCanvasPointerDown = (e: PointerEvent) => {
		skipCanvasDismiss = false;
		const target = e.target as HTMLElement;
		if (
			target.closest(
				'.graph-folder-hud, .graph-search-host, .graph-search-scrim, .graph-folder-sheet, .graph-folder-backdrop, .graph-menu-btn, .chat-collapsed-orb-host, .chat-side-panel, .video-wall-hud, .graph-clock, .flip-cal-dock'
			)
		)
			return;
		panelClickStart = { x: e.clientX, y: e.clientY };
	};

	const handleCanvasPointerUp = (e: PointerEvent) => {
		if (!panelClickStart) return;
		const dx = e.clientX - panelClickStart.x;
		const dy = e.clientY - panelClickStart.y;
		panelClickStart = null;
		if (Math.abs(dx) >= CANVAS_DISMISS_DRAG_PX || Math.abs(dy) >= CANVAS_DISMISS_DRAG_PX) return;
		const skip = skipCanvasDismiss;
		skipCanvasDismiss = false;
		if ($showSidebar) showSidebar.set(false);
		if (shouldDismissChatPanel({ skipCanvasDismiss: skip, panelOpen: showChatPanel, dx, dy })) {
			closeChatPanel();
		}
	};

	const handleKeydown = (e: KeyboardEvent) => {
		if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'f' || e.key === 'F')) {
			e.preventDefault();
			e.stopPropagation();
			graphSearchOpen = true;
			return;
		}
		if (e.key === 'Escape' && graphSearchOpen) {
			graphSearchOpen = false;
			return;
		}
		if (e.key === 'Escape' && folderSheetOpen) {
			closeFolderSheet();
			return;
		}
		if (e.key === 'Escape' && showChatPanel) {
			if (voiceActive) {
				endVoiceChat();
			} else {
				closeChatPanel();
			}
		}
		if (e.key === ' ') {
			const target = e.target as HTMLElement;
			if (folderSheetOpen || graphSearchOpen) return;
			if (
				target.tagName !== 'INPUT' &&
				target.tagName !== 'TEXTAREA' &&
				!target.isContentEditable
			) {
				e.preventDefault();
				if (voiceStarting) return;
				if (voiceActive) {
					endVoiceChat();
				} else {
					startVoiceChat();
				}
			}
		}
	};

	onMount(async () => {
		window.addEventListener('keydown', handleKeydown);
		await refreshRecentChats();
		graphStore.startPresencePoll(graphToken);
	});

	onDestroy(() => {
		window.removeEventListener('keydown', handleKeydown);
		graphStore.stopPresencePoll();
		graphStore.stopScanPoll();
	});
</script>

<div
	class="graph-page absolute inset-0 flex w-full h-screen max-h-[100dvh] overflow-hidden max-w-full"
>
	<div
		class="absolute inset-0"
		onpointerdown={handleCanvasPointerDown}
		onpointerup={handleCanvasPointerUp}
	>
		<CanvasView
			onselectconversation={openChat}
			onqueryAbout={queryAbout}
			bind:dateLabel={corridorDate}
			bind:timelineOpen={corridorTimelineOpen}
		/>

		{#if !$showSidebar && !showChatPanel && !(voiceStarting || (voiceActive && voiceService))}
			<button
				type="button"
				id="sidebar-toggle-button"
				class="graph-menu-btn"
				aria-label="Open menu"
				onclick={() => {
					showChatPanel = false;
					showSidebar.set(true);
				}}
			>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
					<line x1="4" y1="7" x2="20" y2="7" />
					<line x1="4" y1="12" x2="20" y2="12" />
					<line x1="4" y1="17" x2="20" y2="17" />
				</svg>
			</button>
		{/if}

		{#if displayedSources.length > 0}
		<div class="graph-folder-hud" data-testid="graph-source-list">
			<p class="graph-folder-kicker">On view</p>
			<ul class="graph-source-list">
				{#each displayedSources as source (source.id)}
					<li
						class="graph-source-row"
						class:is-offline={!source.online}
						class:is-indexing={graphStore.scanningSourceIds.has(source.id)}
						data-testid="graph-source-pill"
						title={source.lastAbsPath || source.name}
					>
						{#if source.online}
							<svg class="graph-source-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
								<path d="M4 7.5h5.2l1.4 1.6H20v8.4a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 17.5V7.5Z" />
								<path d="M4 11h16" />
							</svg>
						{:else}
							<svg class="graph-source-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
								<path d="M4 8h5l1.5 2H20v8.5a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 18.5V8Z" />
							</svg>
						{/if}
						<span class="graph-source-name">{source.name || source.lastAbsPath || source.id}</span>
						{#if graphStore.scanningSourceIds.has(source.id)}
							<span class="graph-source-label">Indexing</span>
						{:else if !source.online}
							<span class="graph-source-label">Offline</span>
						{/if}
						<button
							type="button"
							class="graph-source-remove"
							aria-label="Remove {source.name || source.lastAbsPath || source.id} from graph"
							title="Remove from graph (keeps files on disk)"
							disabled={detachingId === source.id}
							onclick={(e) => {
								e.stopPropagation();
								void removeFolderFromGraph(source.id);
							}}
						>
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
								<path d="M6 6l12 12M18 6L6 18" />
							</svg>
						</button>
					</li>
				{/each}
			</ul>
		</div>
		{/if}

		{#if folderSheetOpen}
			<button
				type="button"
				class="graph-folder-backdrop"
				aria-label="Close attach folder"
				onclick={closeFolderSheet}
			></button>
			<div
				class="graph-folder-sheet"
				data-testid="graph-folder-sheet"
				role="dialog"
				aria-modal="true"
				aria-labelledby="graph-folder-title"
				transition:fly={{ y: 10, duration: 220 }}
			>
				<header class="graph-folder-head">
					<div>
						<p class="graph-folder-kicker">Index in place</p>
						<h2 id="graph-folder-title">Attach folder</h2>
					</div>
					<button type="button" class="graph-folder-x" aria-label="Close" onclick={closeFolderSheet}>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
							<path stroke-linecap="round" d="M6 6l12 12M18 6L6 18" />
						</svg>
					</button>
				</header>
				<p class="graph-folder-hint">Walk the disk from the server. Files stay on disk — nothing is copied.</p>
				<form
					class="graph-folder-pathrow"
					onsubmit={(e) => {
						e.preventDefault();
						runBrowse(folderPath.trim());
					}}
				>
					<input
						bind:this={folderPathInput}
						bind:value={folderPath}
						class="graph-folder-path"
						data-testid="graph-folder-path"
						type="text"
						placeholder="/Users/paulvisciano/Desktop/Takeout"
						spellcheck="false"
						autocomplete="off"
						aria-label="Folder path"
					/>
					<button type="submit" class="graph-folder-browse" data-testid="graph-folder-browse" disabled={browseLoading}>
						{browseLoading ? '…' : 'Browse'}
					</button>
				</form>
				<div class="graph-folder-crumb">
					<button
						type="button"
						class="graph-folder-up"
						disabled={!folderPath.trim()}
						onclick={() => enterBrowsePath(parentOf(folderPath.trim()))}
					>
						Up
					</button>
					<code>{folderPath.trim() || 'roots'}</code>
				</div>
				<div class="graph-folder-list" data-testid="graph-folder-list">
					{#if browseLoading}
						<div class="graph-folder-empty">Listing…</div>
					{:else if browseEntries.length === 0}
						<div class="graph-folder-empty">{browseError ? '' : 'No entries'}</div>
					{:else}
						{#each browseEntries as entry (entry.path)}
							<button
								type="button"
								class="graph-folder-entry {entry.isDir ? 'is-dir' : 'is-file'}"
								disabled={!entry.isDir}
								onclick={() => entry.isDir && enterBrowsePath(entry.path)}
							>
								<span class="graph-folder-entry-icon" aria-hidden="true">{entry.isDir ? '▸' : '·'}</span>
								<span class="graph-folder-entry-name">{entry.name}</span>
							</button>
						{/each}
					{/if}
				</div>
				{#if browseError}
					<p class="graph-folder-error" data-testid="graph-folder-error">{browseError}</p>
				{/if}
				<footer class="graph-folder-foot">
					<button type="button" class="graph-folder-cancel" onclick={closeFolderSheet}>Cancel</button>
					<button
						type="button"
						class="graph-folder-confirm"
						data-testid="graph-folder-confirm"
						disabled={attaching || !folderPath.trim()}
						onclick={confirmAttachFolder}
					>
						{attaching ? 'Attaching…' : 'Attach & scan'}
					</button>
				</footer>
			</div>
		{/if}

		{#if voiceStarting || (voiceActive && voiceService)}
			<div class="voice-stage">
				<div class="voice-vignette" aria-hidden="true"></div>
				<div class="voice-hero">
					<p class="voice-status">{voiceStarting && !voiceService ? 'Starting microphone…' : voiceService?.statusText}</p>
					{#if voiceService}
						<GraphVoiceOverlay service={voiceService} />
					{/if}
				</div>
			</div>
		{/if}

		<GraphSearch bind:open={graphSearchOpen} onselect={openChat} />
		<div class="graph-toolbar">
			<button
				type="button"
				class="graph-toolbar-search"
				data-testid="graph-search"
				aria-label="Search"
				onclick={() => (graphSearchOpen = true)}
			>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<circle cx="11" cy="11" r="7" />
					<path d="M20 20l-3-3" />
				</svg>
			</button>
		{#if voiceStarting || (voiceActive && voiceService)}
			<div class="voice-dock">
				{#if voiceService}
					<button
						class="voice-ctrl {voiceService.muted ? 'muted' : ''}"
						onclick={() => voiceService.toggleMute()}
						aria-label={voiceService.muted ? 'Unmute' : 'Mute'}
					>
						{#if voiceService.muted}
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="size-5">
								<path stroke-linecap="round" stroke-linejoin="round" d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z"/>
								<line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
							</svg>
						{:else}
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="size-5">
								<path stroke-linecap="round" stroke-linejoin="round" d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z"/>
							</svg>
						{/if}
					</button>
					<div class="voice-pulse {voiceService.speaking ? 'recording' : ''} {voiceService.assistantSpeaking ? 'speaking' : ''}">
						<VoiceWaveform
							rms={voiceService?.speaking ? voiceService.visualRms : 0}
							mode={voiceService?.speaking ? 'user' : voiceService?.assistantSpeaking ? 'assistant' : 'idle'}
						/>
					</div>
					<button class="voice-stop" onclick={endVoiceChat} aria-label="Stop">Stop</button>
				{:else}
					<div class="voice-pulse" aria-hidden="true"></div>
					<button class="voice-stop" disabled>…</button>
				{/if}
			</div>
		{:else}
		<div class="chat-collapsed-orb-host">
				<div class="chat-collapsed-orb">
					<div
						class="chat-orb-add"
						data-testid="graph-add-folder"
						style:opacity={orbOptionsOpen ? '1' : '0'}
						style:transform={orbOptionsOpen ? 'translateY(0) scale(1)' : 'translateY(20px) scale(0.9)'}
						style:pointer-events={orbOptionsOpen ? 'auto' : 'none'}
						role="button"
						tabindex="0"
						aria-label="Add folder"
						onclick={(e) => { e.stopPropagation(); orbOptionsOpen = false; openFolderSheet(); }}
						onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); orbOptionsOpen = false; openFolderSheet(); } }}
						onmouseenter={orbCancelClose}
						onmouseleave={orbScheduleClose}
					>
						<div class="coa-icon">
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
								<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
								<path d="M12 11v6M9 14h6" />
							</svg>
						</div>
						<span>Add folder</span>
					</div>

					<div
						class="chat-orb-expand"
						style:opacity={orbOptionsOpen ? '1' : '0'}
						style:transform={orbOptionsOpen ? 'translateY(0) scale(1)' : 'translateY(20px) scale(0.9)'}
						style:pointer-events={orbOptionsOpen ? 'auto' : 'none'}
						role="button"
						tabindex="0"
						aria-label="Type a message"
						onclick={(e) => { e.stopPropagation(); orbOptionsOpen = false; startNewChat(); }}
						onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); orbOptionsOpen = false; startNewChat(); } }}
						onmouseenter={orbCancelClose}
						onmouseleave={orbScheduleClose}
					>
						<div class="coe-icon">
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
						</div>
						<span>Type a message</span>
					</div>

					<div
						class="chat-orb {orbOptionsOpen ? 'options-open' : ''}"
						role="button"
						tabindex="0"
						aria-label="Voice input"
						onclick={() => { orbOptionsOpen = false; startVoiceChat(); }}
						onmouseenter={() => { orbCancelClose(); orbOptionsOpen = true; }}
						onmouseleave={orbScheduleClose}
					>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
					</div>
				</div>
		</div>
		{/if}
		</div>
	</div>

	{#if showChatPanel && $mobile && !voiceActive}
		<button type="button" class="chat-sheet-backdrop" aria-label="Close conversation" onclick={closeChatPanel}></button>
	{/if}

	{#if showChatPanel}
		<div
			bind:this={chatSheetEl}
			class="chat-side-panel graph-chat-panel flex flex-col z-30 {voiceActive ? 'voice-hide' : ''} {$mobile ? 'chat-sheet' : ''} {sheetSnap === 'full' ? 'sheet-expanded' : ''}"
			style={voiceActive
				? 'display: none;'
				: $mobile
					? ''
					: 'width: min(480px, 40vw);'}
			transition:fly={$mobile ? { duration: 0 } : { x: '100%', duration: 320 }}
		>
			{#if $mobile}
				<div class="sheet-handle" data-sheet-handle="true">
					<div class="sheet-handle-pill"></div>
				</div>
			{/if}
		<div class="flex-1 overflow-hidden min-h-0">
				{#if chatLoading}
					<div class="flex h-full items-center justify-center">
						<Spinner className="size-5" />
					</div>
				{:else}
				<Chat
					embedded={true}
					chatIdProp={selectedChatId}
					embeddedChats={recentChats}
					embeddedDraftKey={chatDraftKey}
					suggestedPrompts={pendingSeedPrompt ? [pendingSeedPrompt] : []}
					embeddedVoiceActive={voiceActive}
					onNewEmbeddedChat={startNewChat}
					onCreateEmbeddedChat={createChatOnFirstMessage}
					onSelectEmbeddedChat={selectEmbeddedChat}
					onDeleteEmbeddedChat={deleteEmbeddedChat}
					onEmbeddedChatTitle={onEmbeddedChatTitle}
					onCloseEmbedded={closeChatPanel}
					onVoiceReady={(api) => {
							voiceChatApi = api;
							if (voiceReadyResolve) {
								voiceReadyResolve();
								voiceReadyResolve = null;
							}
						}}
					onStartEmbeddedVoice={() => startVoiceChat({ continueChat: true })}
					/>
				{/if}
			</div>
		</div>
	{/if}

</div>

<style>
	.graph-menu-btn {
		position: absolute;
		top: calc(20px + env(safe-area-inset-top, 0px));
		right: 0.7rem;
		z-index: 50;
		width: 40px;
		height: 40px;
		display: flex;
		align-items: center;
		justify-content: center;
		border: 1px solid oklch(82% 0.14 210 / 28%);
		border-radius: 100px;
		background: oklch(10% 0.02 255 / 82%);
		backdrop-filter: blur(24px) saturate(1.5);
		-webkit-backdrop-filter: blur(24px) saturate(1.5);
		color: oklch(92% 0.01 210);
		box-shadow:
			0 8px 28px oklch(0% 0 0 / 45%),
			0 0 0 1px oklch(50% 0.03 255 / 10%);
		cursor: pointer;
	}
	.graph-menu-btn svg {
		width: 22px;
		height: 22px;
	}

	.graph-folder-hud,
	.graph-folder-sheet,
	.graph-folder-backdrop {
		--folder-bg: var(--color-cyber-bg, #0a0e17);
		--folder-surface: var(--color-cyber-surface, #111827);
		--folder-surface-2: var(--color-cyber-surface-2, #1a2235);
		--folder-border: var(--color-cyber-border, #1e2d45);
		--folder-text: var(--color-cyber-text, #c8d6e5);
		--folder-dim: var(--color-cyber-text-dim, #5a6b80);
		--folder-cyan: var(--color-cyber-cyan, #00d4ff);
		--folder-cyan-dim: var(--color-cyber-cyan-dim, #007a99);
		--folder-green: var(--color-cyber-green, #00ff88);
		--folder-red: var(--color-cyber-red, #ff3366);
		font-family: var(--font-sans);
	}

	.graph-folder-hud {
		position: absolute;
		left: 16px;
		bottom: calc(20px + env(safe-area-inset-bottom, 0px));
		top: auto;
		z-index: 40;
		display: flex;
		flex-direction: column;
		align-items: stretch;
		max-width: min(240px, calc(100% - 8rem));
		pointer-events: auto;
		padding: 8px 10px;
		border-radius: 16px;
		background: oklch(10% 0.02 255 / 72%);
		backdrop-filter: blur(24px) saturate(1.4);
		-webkit-backdrop-filter: blur(24px) saturate(1.4);
		box-shadow:
			0 8px 28px oklch(0% 0 0 / 40%),
			0 0 0 1px oklch(50% 0.03 255 / 10%);
	}

	@media (max-width: 768px) {
		.graph-folder-hud {
			bottom: calc(88px + env(safe-area-inset-bottom, 0px));
			max-width: calc(100% - 7rem);
		}
	}

	.graph-source-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.graph-folder-kicker {
		margin: 0 2px 6px;
		font-family: 'Fraunces', Georgia, serif;
		font-size: 9px;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: #c4a056;
	}
	.graph-source-row {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		padding: 4px 2px;
		color: #efe6d2;
		font-family: 'Fraunces', Georgia, serif;
		font-size: 12px;
		line-height: 1.25;
	}
	.graph-source-row.is-offline {
		color: #8a7d6a;
	}
	.graph-source-icon {
		width: 14px;
		height: 14px;
		flex-shrink: 0;
		opacity: 0.9;
	}
	.graph-source-row.is-offline .graph-source-icon {
		opacity: 0.45;
	}
	.graph-source-row.is-indexing .graph-source-icon {
		animation: source-pulse 1.2s ease-in-out infinite;
	}
	.graph-source-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 500;
	}
	.graph-source-label {
		margin-left: auto;
		color: #c4a056;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		font-size: 9px;
		flex-shrink: 0;
	}
	.graph-source-row.is-offline .graph-source-label {
		color: #8a7d6a;
	}
	.graph-source-remove {
		flex-shrink: 0;
		margin-left: auto;
		width: 22px;
		height: 22px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		border: 0;
		border-radius: 4px;
		background: transparent;
		color: #8a7d6a;
		cursor: pointer;
	}
	.graph-source-remove svg {
		width: 11px;
		height: 11px;
	}
	.graph-source-remove:hover:not(:disabled) {
		color: #efe6d2;
		background: oklch(40% 0.04 30 / 35%);
	}
	.graph-source-remove:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.graph-source-row:has(.graph-source-label) .graph-source-remove {
		margin-left: 4px;
	}
	@keyframes source-pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.35; }
	}

	.graph-folder-backdrop {
		position: absolute;
		inset: 0;
		z-index: 41;
		border: 0;
		background: color-mix(in srgb, var(--folder-bg) 45%, transparent);
		cursor: pointer;
	}

	.graph-folder-sheet {
		position: absolute;
		top: calc(4.2rem + env(safe-area-inset-top, 0px));
		left: 0.7rem;
		z-index: 42;
		display: flex;
		flex-direction: column;
		width: min(420px, calc(100% - 1.4rem));
		max-height: calc(100% - 8.5rem);
		padding: 16px;
		border-radius: 16px;
		border: 1px solid color-mix(in srgb, var(--folder-cyan) 22%, var(--folder-border));
		background: color-mix(in srgb, var(--folder-bg) 92%, var(--folder-surface));
		box-shadow:
			0 0 0 1px color-mix(in srgb, var(--folder-cyan) 8%, transparent),
			0 24px 48px color-mix(in srgb, var(--folder-bg) 70%, transparent);
		color: var(--folder-text);
		pointer-events: auto;
	}

	.graph-folder-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 8px;
	}
	.graph-folder-kicker {
		margin: 0 0 2px;
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--folder-cyan);
	}
	.graph-folder-head h2 {
		margin: 0;
		font-family: var(--font-sans);
		font-size: 16px;
		font-weight: 600;
		color: var(--folder-text);
	}
	.graph-folder-x {
		width: 32px;
		height: 32px;
		display: flex;
		align-items: center;
		justify-content: center;
		border: 0;
		border-radius: 8px;
		background: transparent;
		color: var(--folder-dim);
		cursor: pointer;
	}
	.graph-folder-x svg {
		width: 16px;
		height: 16px;
	}
	.graph-folder-x:hover {
		color: var(--folder-text);
		background: var(--folder-surface-2);
	}
	.graph-folder-hint {
		margin: 0 0 12px;
		font-size: 12px;
		line-height: 1.4;
		color: var(--folder-dim);
	}

	.graph-folder-pathrow {
		display: flex;
		gap: 8px;
		margin-bottom: 8px;
	}
	.graph-folder-path {
		flex: 1;
		min-width: 0;
		height: 40px;
		padding: 0 12px;
		border-radius: 10px;
		border: 1px solid var(--folder-border);
		background: var(--folder-surface);
		color: var(--folder-text);
		font-family: var(--font-mono);
		font-size: 12px;
		outline: none;
	}
	.graph-folder-path::placeholder {
		color: var(--folder-dim);
	}
	.graph-folder-path:focus {
		border-color: var(--folder-cyan);
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--folder-cyan) 40%, transparent);
	}
	.graph-folder-browse,
	.graph-folder-up,
	.graph-folder-cancel,
	.graph-folder-confirm {
		height: 40px;
		padding: 0 12px;
		border-radius: 10px;
		font-size: 12px;
		font-weight: 600;
		cursor: pointer;
		font-family: var(--font-sans);
	}
	.graph-folder-browse {
		border: 1px solid color-mix(in srgb, var(--folder-cyan) 35%, transparent);
		background: color-mix(in srgb, var(--folder-cyan) 12%, transparent);
		color: var(--folder-cyan);
	}
	.graph-folder-browse:disabled,
	.graph-folder-confirm:disabled,
	.graph-folder-up:disabled {
		opacity: 0.45;
		cursor: default;
	}

	.graph-folder-crumb {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 8px;
		min-width: 0;
	}
	.graph-folder-up {
		height: 28px;
		padding: 0 10px;
		border: 1px solid var(--folder-border);
		background: var(--folder-surface-2);
		color: var(--folder-text);
	}
	.graph-folder-crumb code {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--folder-dim);
	}

	.graph-folder-list {
		flex: 1;
		min-height: 120px;
		max-height: 240px;
		overflow: auto;
		border-radius: 10px;
		border: 1px solid var(--folder-border);
		background: var(--folder-surface);
	}
	.graph-folder-empty {
		padding: 24px 12px;
		text-align: center;
		font-size: 12px;
		color: var(--folder-dim);
	}
	.graph-folder-entry {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 8px 12px;
		border: 0;
		border-bottom: 1px solid var(--folder-border);
		background: transparent;
		color: var(--folder-text);
		font-family: var(--font-sans);
		font-size: 13px;
		text-align: left;
		cursor: pointer;
	}
	.graph-folder-entry:last-child {
		border-bottom: 0;
	}
	.graph-folder-entry.is-dir:hover {
		background: color-mix(in srgb, var(--folder-cyan) 8%, transparent);
		color: var(--folder-cyan);
	}
	.graph-folder-entry.is-file {
		color: var(--folder-dim);
		cursor: default;
	}
	.graph-folder-entry-icon {
		width: 12px;
		color: var(--folder-cyan-dim);
		flex-shrink: 0;
	}
	.graph-folder-entry-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.graph-folder-error {
		margin: 8px 0 0;
		font-size: 12px;
		color: var(--folder-red);
	}

	.graph-folder-foot {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 12px;
	}
	.graph-folder-cancel {
		border: 1px solid var(--folder-border);
		background: transparent;
		color: var(--folder-dim);
	}
	.graph-folder-confirm {
		border: 0;
		background: var(--folder-cyan);
		color: var(--folder-bg);
	}
	.graph-folder-confirm:hover:not(:disabled) {
		box-shadow: 0 0 16px color-mix(in srgb, var(--folder-cyan) 40%, transparent);
	}

	.graph-toolbar {
		position: absolute;
		right: calc(16px + env(safe-area-inset-right, 0px));
		bottom: calc(0.95rem + env(safe-area-inset-bottom, 0px));
		z-index: 41;
		display: flex;
		flex-direction: row;
		align-items: center;
		gap: 6px;
		padding: 6px;
		border-radius: 100px;
		background: oklch(10% 0.02 255 / 82%);
		backdrop-filter: blur(24px) saturate(1.5);
		-webkit-backdrop-filter: blur(24px) saturate(1.5);
		border: 1px solid oklch(82% 0.14 210 / 28%);
		box-shadow:
			0 8px 28px oklch(0% 0 0 / 45%),
			0 0 0 1px oklch(50% 0.03 255 / 10%);
		pointer-events: auto;
	}

	.graph-toolbar-search {
		width: 44px;
		height: 44px;
		padding: 0;
		border: 1px solid transparent;
		border-radius: 50%;
		background: transparent;
		color: oklch(82% 0.14 210);
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
	}
	.graph-toolbar-search svg {
		width: 20px;
		height: 20px;
	}
	.graph-toolbar-search:hover {
		background: oklch(82% 0.14 210 / 12%);
	}

	.chat-collapsed-orb-host {
		position: relative;
		left: auto;
		right: auto;
		bottom: auto;
		transform: none;
		z-index: 1;
		pointer-events: auto;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: flex-end;
	}

	.graph-toolbar .chat-orb {
		background: transparent;
		border-color: transparent;
		box-shadow: none;
	}
	.graph-toolbar .chat-orb:hover,
	.graph-toolbar .chat-collapsed-orb:hover .chat-orb {
		transform: none;
		background: oklch(82% 0.14 210 / 12%);
		border-color: transparent;
		box-shadow: none;
	}

	.chat-collapsed-orb {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: flex-end;
		gap: 0;
		pointer-events: auto;
	}

	.chat-orb {
		width: 48px;
		height: 48px;
		border-radius: 50%;
		background: oklch(18% 0.02 255 / 85%);
		backdrop-filter: blur(24px) saturate(1.5);
		-webkit-backdrop-filter: blur(24px) saturate(1.5);
		border: 1px solid oklch(82% 0.14 210 / 25%);
		box-shadow:
			0 0 0 1px oklch(82% 0.14 210 / 12%),
			0 0 32px oklch(82% 0.14 210 / 20%),
			0 0 64px oklch(82% 0.14 210 / 8%),
			0 12px 40px oklch(0% 0 0 / 50%);
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		color: oklch(82% 0.14 210);
		transition: all 0.4s cubic-bezier(0.16, 1, 0.3, 1);
		position: relative;
		touch-action: none;
		user-select: none;
		flex-shrink: 0;
	}
	.chat-orb svg {
		width: 20px;
		height: 20px;
		transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
	}
	.chat-orb::after {
		content: '';
		position: absolute;
		inset: -4px;
		border-radius: 50%;
		border: 1px solid oklch(82% 0.14 210 / 0%);
		transition: border-color 0.4s, inset 0.4s;
		pointer-events: none;
	}
	.chat-collapsed-orb:hover .chat-orb,
	.chat-orb:hover {
		border-color: oklch(82% 0.14 210 / 40%);
		box-shadow:
			0 0 0 1px oklch(82% 0.14 210 / 20%),
			0 0 48px oklch(82% 0.14 210 / 30%),
			0 0 96px oklch(82% 0.14 210 / 12%),
			0 16px 48px oklch(0% 0 0 / 60%);
		transform: scale(1.08);
	}
	.chat-orb::before {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: 50%;
		border: 2px solid oklch(82% 0.14 210 / 0%);
		animation: orbPulse 3s ease-in-out infinite;
		pointer-events: none;
	}
	@keyframes orbPulse {
		0%, 100% { border-color: oklch(82% 0.14 210 / 0%); inset: 0; }
		50% { border-color: oklch(82% 0.14 210 / 15%); inset: -6px; }
	}
	.chat-orb:active {
		transform: scale(0.95);
	}

	.chat-orb-expand {
		position: absolute;
		right: 0;
		bottom: calc(100% + 10px);
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 16px 8px 8px;
		border-radius: 100px;
		background: oklch(16% 0.015 255 / 80%);
		backdrop-filter: blur(24px) saturate(1.5);
		-webkit-backdrop-filter: blur(24px) saturate(1.5);
		border: 1px solid oklch(50% 0.03 255 / 12%);
		box-shadow: 0 12px 40px oklch(0% 0 0 / 50%);
		cursor: pointer;
		color: oklch(90% 0.005 250);
		font-size: 14px;
		font-weight: 500;
		white-space: nowrap;
		margin-bottom: 0;
		transition: all 0.35s cubic-bezier(0.16, 1, 0.3, 1) 0.05s;
	}
	.chat-orb-expand .coe-icon {
		width: 32px;
		height: 32px;
		border-radius: 50%;
		background: oklch(82% 0.14 210 / 12%);
		display: flex;
		align-items: center;
		justify-content: center;
		color: oklch(82% 0.14 210);
		flex-shrink: 0;
	}
	.chat-orb-expand .coe-icon svg { width: 16px; height: 16px; }
	.chat-orb-expand:hover {
		border-color: oklch(82% 0.14 210 / 25%);
	}

	.chat-orb-add {
		position: absolute;
		right: 0;
		bottom: calc(100% + 62px);
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 16px 8px 8px;
		border-radius: 100px;
		background: oklch(16% 0.015 255 / 80%);
		backdrop-filter: blur(24px) saturate(1.5);
		-webkit-backdrop-filter: blur(24px) saturate(1.5);
		border: 1px solid oklch(50% 0.03 255 / 12%);
		box-shadow: 0 12px 40px oklch(0% 0 0 / 50%);
		cursor: pointer;
		color: oklch(90% 0.005 250);
		font-size: 14px;
		font-weight: 500;
		white-space: nowrap;
		margin-bottom: 0;
		transition: all 0.35s cubic-bezier(0.16, 1, 0.3, 1) 0.1s;
	}
	.chat-orb-add .coa-icon {
		width: 32px;
		height: 32px;
		border-radius: 50%;
		background: oklch(82% 0.14 210 / 12%);
		display: flex;
		align-items: center;
		justify-content: center;
		color: oklch(82% 0.14 210);
		flex-shrink: 0;
	}
	.chat-orb-add .coa-icon svg { width: 16px; height: 16px; }
	.chat-orb-add:hover {
		border-color: oklch(82% 0.14 210 / 25%);
	}

	.chat-side-panel {
		position: fixed;
		top: 0;
		right: 0;
		bottom: 0;
		z-index: 45;
		background: oklch(7% 0.02 260 / 94%);
		border-left: 1px solid oklch(82% 0.14 210 / 16%);
		box-shadow: -18px 0 48px oklch(0% 0 0 / 45%);
		backdrop-filter: blur(28px) saturate(1.25);
		-webkit-backdrop-filter: blur(28px) saturate(1.25);
		color: oklch(90% 0.005 250);
	}
	.graph-chat-panel :global(#note-chat-container) {
		background: transparent;
	}
	.graph-chat-panel :global(.h-10.shrink-0) {
		position: relative;
		z-index: 2;
		border-color: oklch(82% 0.14 210 / 14%) !important;
		background: oklch(8% 0.02 260);
		color: oklch(90% 0.005 250);
	}
	.chat-sheet-backdrop {
		position: absolute;
		inset: 0;
		z-index: 25;
		border: 0;
		background: oklch(0% 0 0 / 42%);
		cursor: pointer;
	}
	.chat-sheet {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		top: 0;
		width: 100%;
		height: 100dvh;
		max-height: 100dvh;
		border-left: 0;
		border-radius: 18px 18px 0 0;
		transform: translate3d(0, 42%, 0);
		transition: transform 0.4s cubic-bezier(0.32, 0.72, 0, 1);
		box-shadow: 0 -12px 40px oklch(0% 0 0 / 35%);
		padding-bottom: env(safe-area-inset-bottom, 0px);
	}
	.chat-sheet.sheet-dragging {
		transition: none;
	}
	.chat-sheet.sheet-expanded {
		border-radius: 0;
	}
	.sheet-handle {
		flex-shrink: 0;
		display: flex;
		justify-content: center;
		padding: 10px 0 8px;
		touch-action: none;
		cursor: grab;
	}
	.sheet-handle-pill {
		width: 36px;
		height: 5px;
		border-radius: 99px;
		background: oklch(55% 0.02 255 / 45%);
	}

	.voice-hidden {
		opacity: 0 !important;
		pointer-events: none !important;
		transform: translateX(100%) !important;
	}

	.chat-orb.voice-active {
		transition: transform 0.1s ease-out, border-color 0.25s ease, box-shadow 0.25s ease;
	}
	.chat-orb.voice-active::before {
		animation-duration: 1.5s;
	}
	.chat-orb.starting {
		opacity: 0.7;
		border-color: oklch(60% 0.04 210 / 30%);
	}
	.chat-orb.mic-ready {
		border-color: oklch(82% 0.14 210 / 45%);
		box-shadow:
			0 0 0 1px oklch(82% 0.14 210 / 18%),
			0 0 28px oklch(82% 0.14 210 / 28%),
			0 12px 40px oklch(0% 0 0 / 50%);
	}
	.chat-orb.recording {
		border-color: oklch(62% 0.2 18 / 70%);
		box-shadow:
			0 0 0 1px oklch(62% 0.2 18 / 25%),
			0 0 32px oklch(62% 0.2 18 / 30%),
			0 12px 40px oklch(0% 0 0 / 50%);
	}
	.chat-orb.recording::after {
		content: '';
		position: absolute;
		top: 8px;
		right: 8px;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: oklch(62% 0.22 18);
		box-shadow: 0 0 8px oklch(62% 0.22 18 / 80%);
	}
	.voice-orb-emoji {
		line-height: 1;
	}
	.voice-spinner {
		width: 26px;
		height: 26px;
		color: oklch(82% 0.14 210);
	}

	.voice-orb-row {
		display: flex;
		align-items: flex-end;
		gap: 16px;
		pointer-events: auto;
	}
	.voice-orb-center {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 10px;
		justify-content: flex-end;
		position: relative;
	}
	.voice-orb-status {
		position: absolute;
		top: 100%;
		left: 50%;
		transform: translateX(-50%);
		white-space: nowrap;
		font-size: 12px;
		color: oklch(65% 0.02 255);
		font-family: var(--font-display);
		margin-top: 8px;
	}
	.voice-ctrl {
		width: 40px;
		height: 40px;
		border-radius: 50%;
		background: oklch(16% 0.015 255 / 80%);
		backdrop-filter: blur(24px) saturate(1.4);
		-webkit-backdrop-filter: blur(24px) saturate(1.4);
		border: 1px solid oklch(50% 0.03 255 / 12%);
		box-shadow: 0 8px 24px oklch(0% 0 0 / 40%);
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		color: oklch(80% 0.01 250);
		transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
		flex-shrink: 0;
	}
	.voice-ctrl:hover {
		border-color: oklch(82% 0.14 210 / 25%);
		transform: scale(1.08);
	}
	.voice-ctrl.muted {
		background: oklch(62% 0.2 18 / 80%);
		color: white;
	}
	.voice-ctrl.end-call:hover {
		background: oklch(62% 0.2 18 / 80%);
		color: white;
		border-color: oklch(62% 0.2 18 / 40%);
	}
	.voice-ctrl svg {
		width: 18px;
		height: 18px;
	}

	.voice-stage {
		position: absolute;
		inset: 0;
		z-index: 42;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		justify-content: flex-end;
		padding: 0 calc(16px + env(safe-area-inset-right, 0px)) calc(5.4rem + env(safe-area-inset-bottom, 0px));
		pointer-events: none;
	}
	.voice-vignette {
		position: absolute;
		inset: 0;
		background: linear-gradient(to top, oklch(6% 0.02 260 / 40%) 0%, transparent 36%);
		pointer-events: none;
	}
	.voice-hero {
		position: relative;
		z-index: 1;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 0.5rem;
		pointer-events: none;
		width: min(28rem, calc(100vw - 2rem));
		margin-bottom: 0;
	}
	.voice-hero :global(.voice-caption) {
		text-align: right;
		margin-left: auto;
	}
	.voice-status {
		margin: 0;
		font-size: 11px;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: oklch(82% 0.14 210 / 75%);
		text-align: right;
		font-family: var(--font-mono, 'JetBrains Mono', ui-monospace, monospace);
	}
	.voice-dock {
		position: relative;
		z-index: 2;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 4px;
		padding: 0;
		border-radius: 0;
		background: transparent;
		border: 0;
		box-shadow: none;
		pointer-events: auto;
	}
	.voice-dock .voice-ctrl {
		width: 44px;
		height: 44px;
		background: transparent;
		border-color: transparent;
		box-shadow: none;
	}
	.voice-pulse {
		width: 44px;
		height: 44px;
		border-radius: 50%;
		overflow: hidden;
		background: oklch(82% 0.14 210 / 12%);
		box-shadow: 0 0 16px oklch(82% 0.14 210 / 20%);
		flex-shrink: 0;
	}
	.voice-pulse.recording {
		background: oklch(62% 0.2 18 / 22%);
		box-shadow: 0 0 18px oklch(62% 0.2 18 / 28%);
	}
	.voice-pulse.speaking {
		box-shadow: 0 0 20px oklch(82% 0.14 210 / 35%);
	}
	.voice-stop {
		min-width: 44px;
		height: 44px;
		padding: 0 14px;
		border-radius: 999px;
		border: 1px solid oklch(82% 0.14 210 / 30%);
		background: transparent;
		color: oklch(90% 0.02 210);
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		font-family: var(--font-mono, 'JetBrains Mono', ui-monospace, monospace);
		cursor: pointer;
	}
	.voice-stop:hover {
		background: oklch(82% 0.14 210 / 12%);
	}
	.voice-spinner .spq {
		animation: sp8 1.05s infinite;
	}
	.voice-spinner .spo { animation-delay: 0.1s; }
	.voice-spinner .spz { animation-delay: 0.2s; }
	@keyframes sp8 {
		0%, 57.14% { animation-timing-function: cubic-bezier(0.33, 0.66, 0.66, 1); transform: translate(0); }
		28.57% { animation-timing-function: cubic-bezier(0.33, 0, 0.66, 0.33); transform: translateY(-6px); }
		100% { transform: translate(0); }
	}
</style>