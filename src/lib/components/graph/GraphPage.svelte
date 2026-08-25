<script lang="ts">
	import { getContext, onMount, tick, onDestroy } from 'svelte';
	import { fly } from 'svelte/transition';
	import type { Writable } from 'svelte/store';
	import type { i18n as i18nType } from 'i18next';

	import { showSidebar } from '$lib/stores';
	import { createNewChat, getChatList, deleteChatById } from '$lib/apis/chats';
	import { processImage } from '$lib/apis/graph';
	import { toast } from 'svelte-sonner';

	import CanvasView from './CanvasView.svelte';
	import Chat from '$lib/components/chat/Chat.svelte';
	import GraphVoiceOverlay from './GraphVoiceOverlay.svelte';
	import Spinner from '$lib/components/common/Spinner.svelte';
	import { VoiceCallService } from '$lib/components/chat/MessageInput/VoiceCallService.svelte';

	import { graphStore } from './stores/graph.svelte';
	import type { KGNode } from './constants';

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
	let chatLoading = $state(false);
	let orbOptionsOpen = $state(false);
	let orbCloseTimer: ReturnType<typeof setTimeout> | null = null;

	const orbScheduleClose = () => {
		if (orbCloseTimer) clearTimeout(orbCloseTimer);
		orbCloseTimer = setTimeout(() => { orbOptionsOpen = false; }, 100);
	};

	const orbCancelClose = () => {
		if (orbCloseTimer) { clearTimeout(orbCloseTimer); orbCloseTimer = null; }
	};

	let recentChats = $state<any[]>([]);

	let voiceActive = $state(false);
	let voiceService = $state<VoiceCallService | null>(null);
	let voiceChatApi: {
		eventTarget: EventTarget;
		submitPrompt: (content: string, opts?: Record<string, any>) => Promise<any>;
		stopResponse: (processQueue?: boolean) => Promise<void>;
		chatId: () => string;
		modelId: () => string;
	} | null = null;
	let voiceReadyResolve: (() => void) | null = null;

	// ── File upload (graph ingestion) ────────────────────────────────
	let fileInput: HTMLInputElement | undefined = $state();
	let uploading = $state(false);

	const openFilePicker = () => {
		fileInput?.click();
	};

	const handleFileChange = async (e: Event) => {
		const input = e.target as HTMLInputElement;
		const files = Array.from(input.files ?? []);
		if (files.length === 0) return;
		uploading = true;
		try {
			const token = localStorage.token;
			for (const file of files) {
				await processImage(token, file);
			}
			toast.success(
				$i18n ? $i18n.t('Uploaded {{count}} image(s) to the graph', { count: files.length }) : ''
			);
			if (graphStore.nodes.length === 0) {
				await graphStore.loadGraph(token);
				await graphStore.loadConversations(token);
			}
		} catch (err) {
			console.error('[graph] image upload failed', err);
			toast.error(err instanceof Error ? err.message : 'Image upload failed');
		} finally {
			uploading = false;
			input.value = '';
		}
	};

	// ── Conversation selection ───────────────────────────────────────
	const openChat = async (chatId: string) => {
		if (!chatId) return;
		chatLoading = true;
		selectedChatId = chatId;
		chatDraftKey = '';
		showChatPanel = true;
		graphStore.setActiveConversation(chatId);
		await tick();
		chatLoading = false;
	};

	const startNewChat = async () => {
		selectedChatId = '';
		chatDraftKey = `${Date.now()}`;
		showChatPanel = true;
	};

	const startVoiceChat = async () => {
		orbOptionsOpen = false;
		if (!showChatPanel) {
			await startNewChat();
		}
		await tick();
		if (!voiceChatApi) {
			await new Promise<void>((resolve) => {
				voiceReadyResolve = resolve;
			});
		}
		if (voiceChatApi) {
			voiceService = new VoiceCallService({
				eventTarget: voiceChatApi.eventTarget,
				submitPrompt: voiceChatApi.submitPrompt,
				stopResponse: voiceChatApi.stopResponse,
				chatId: voiceChatApi.chatId() ?? selectedChatId,
				modelId: voiceChatApi.modelId() ?? ''
			});
			voiceActive = true;
			await voiceService.start();
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
		graphStore.setActiveConversation('');
	};

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
		await deleteChatById(token, id).catch((err) => {
			console.error('[graph] deleteChat failed', err);
		});
		await refreshRecentChats();
		await graphStore.loadConversations(token);
		if (id === selectedChatId) {
			selectedChatId = '';
			chatDraftKey = '';
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

	const handleCanvasPointerDown = (e: PointerEvent) => {
		if (!showChatPanel || e.target.closest('.chat-side-panel')) return;
		panelClickStart = { x: e.clientX, y: e.clientY };
	};

	const handleCanvasPointerUp = (e: PointerEvent) => {
		if (!panelClickStart) return;
		const dx = Math.abs(e.clientX - panelClickStart.x);
		const dy = Math.abs(e.clientY - panelClickStart.y);
		panelClickStart = null;
		if (dx < 6 && dy < 6) {
			closeChatPanel();
		}
	};

	const handleKeydown = (e: KeyboardEvent) => {
		if (e.key === 'Escape' && showChatPanel) {
			if (voiceActive) {
				endVoiceChat();
			} else {
				closeChatPanel();
			}
		}
		if (e.key === ' ') {
			const target = e.target as HTMLElement;
			if (
				target.tagName !== 'INPUT' &&
				target.tagName !== 'TEXTAREA' &&
				!target.isContentEditable
			) {
				e.preventDefault();
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
	});

	onDestroy(() => {
		window.removeEventListener('keydown', handleKeydown);
	});
</script>

<div
	class="graph-page relative flex w-full h-screen max-h-[100dvh] overflow-hidden max-w-full"
>
	<div
		class="relative flex-1 min-w-0 h-full"
		onpointerdown={handleCanvasPointerDown}
		onpointerup={handleCanvasPointerUp}
	>
		<CanvasView
			onselectconversation={openChat}
			onqueryAbout={queryAbout}
		/>

		<div class="chat-collapsed-orb-host">
			{#if voiceActive && voiceService}
				<div class="voice-orb-row">
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

					<div class="voice-orb-center">
						<div
							class="chat-orb voice-active"
							role="button"
							tabindex="0"
							aria-label={voiceService.statusText}
							onclick={() => {
								if (voiceService.assistantSpeaking) {
									voiceService.stopAllAudio();
								}
							}}
							style:transform={`scale(${1 + Math.min(voiceService.rmsLevel * 100, 8) / 40})`}
						>
							{#if voiceService.emoji}
								<span class="voice-orb-emoji" style="font-size: {1.5 + Math.min(voiceService.rmsLevel * 100, 8) / 20}rem">{voiceService.emoji}</span>
							{:else if voiceService.loading || voiceService.assistantSpeaking}
								<svg class="voice-spinner" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
									<style>
										.spq { animation: sp8 1.05s infinite; }
										.spo { animation-delay: 0.1s; }
										.spz { animation-delay: 0.2s; }
										@keyframes sp8 {
											0%, 57.14% { animation-timing-function: cubic-bezier(0.33,0.66,0.66,1); transform: translate(0); }
											28.57% { animation-timing-function: cubic-bezier(0.33,0,0.66,0.33); transform: translateY(-6px); }
											100% { transform: translate(0); }
										}
									</style>
									<circle class="spq" cx="4" cy="12" r="3" />
									<circle class="spq spo" cx="12" cy="12" r="3" />
									<circle class="spq spz" cx="20" cy="12" r="3" />
								</svg>
							{:else}
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
							{/if}
						</div>
						<div class="voice-orb-status">{voiceService.statusText}</div>
					</div>

					<button
						class="voice-ctrl end-call"
						onclick={endVoiceChat}
						aria-label="End call"
					>
						<svg viewBox="0 0 20 20" fill="currentColor" class="size-5">
							<path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z"/>
						</svg>
					</button>
				</div>
			{:else}
				<div class="chat-collapsed-orb">
					<div
						class="chat-orb-add"
						style:opacity={orbOptionsOpen ? '1' : '0'}
						style:transform={orbOptionsOpen ? 'translateY(0) scale(1)' : 'translateY(20px) scale(0.9)'}
						style:pointer-events={orbOptionsOpen ? 'auto' : 'none'}
						role="button"
						tabindex="0"
						aria-label="Add images"
						onclick={(e) => { e.stopPropagation(); orbOptionsOpen = false; openFilePicker(); }}
						onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); orbOptionsOpen = false; openFilePicker(); } }}
						onmouseenter={orbCancelClose}
						onmouseleave={orbScheduleClose}
					>
						<div class="coa-icon">
							{#if uploading}
								<Spinner className="size-4" />
							{:else}
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
							{/if}
						</div>
						<span>Add images</span>
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
			{/if}
		</div>

		<input
			bind:this={fileInput}
			type="file"
			accept="image/*"
			multiple
			class="hidden"
			onchange={handleFileChange}
		/>
	</div>

	{#if showChatPanel}
		<div
			class="chat-side-panel absolute top-0 right-0 bottom-0 flex flex-col bg-white dark:bg-gray-900 border-l border-gray-100 dark:border-gray-800/50 z-20 {voiceActive ? 'voice-hide' : ''}"
			style="width: min(480px, 40vw); {voiceActive ? 'display: none;' : ''}"
			transition:fly={{ x: '100%', duration: 300, opacity: 1 }}
		>
		<div class="flex-1 overflow-hidden">
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
					/>
				{/if}
			</div>
		</div>
	{/if}

	{#if voiceActive && voiceService}
		<GraphVoiceOverlay service={voiceService} />
	{/if}
</div>

<style>
	.chat-collapsed-orb-host {
		position: absolute;
		left: 50%;
		bottom: calc(2rem + env(safe-area-inset-bottom, 0px));
		transform: translateX(-50%);
		z-index: 30;
		pointer-events: auto;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: flex-end;
	}

	.chat-collapsed-orb {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: flex-end;
		gap: 0;
		pointer-events: auto;
	}

	.chat-orb {
		width: 64px;
		height: 64px;
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
		width: 26px;
		height: 26px;
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
		margin-bottom: 10px;
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
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 16px 8px 8px;
		border-radius: 100px;
		background: oklch(16% 0.02 150 / 80%);
		backdrop-filter: blur(24px) saturate(1.5);
		-webkit-backdrop-filter: blur(24px) saturate(1.5);
		border: 1px solid oklch(50% 0.03 255 / 12%);
		box-shadow: 0 12px 40px oklch(0% 0 0 / 50%);
		cursor: pointer;
		color: oklch(90% 0.005 250);
		font-size: 14px;
		font-weight: 500;
		white-space: nowrap;
		margin-bottom: 10px;
		transition: all 0.35s cubic-bezier(0.16, 1, 0.3, 1) 0.1s;
	}
	.chat-orb-add .coa-icon {
		width: 32px;
		height: 32px;
		border-radius: 50%;
		background: oklch(72% 0.15 150 / 12%);
		display: flex;
		align-items: center;
		justify-content: center;
		color: oklch(72% 0.15 150);
		flex-shrink: 0;
	}
	.chat-orb-add .coa-icon svg { width: 16px; height: 16px; }
	.chat-orb-add:hover {
		border-color: oklch(72% 0.15 150 / 25%);
	}

	.chat-side-panel {
		box-shadow: -8px 0 24px -8px oklch(0% 0 0 / 20%);
	}

	.voice-hidden {
		opacity: 0 !important;
		pointer-events: none !important;
		transform: translateX(100%) !important;
	}

	.chat-orb.voice-active {
		transition: transform 0.1s ease-out;
	}
	.chat-orb.voice-active::before {
		animation-duration: 1.5s;
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
		gap: 8px;
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
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
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
</style>