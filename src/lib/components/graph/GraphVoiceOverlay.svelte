<script lang="ts">
	import { VoiceCallService } from '$lib/components/chat/MessageInput/VoiceCallService.svelte';

	let {
		service
	}: {
		service: VoiceCallService;
	} = $props();

	let caption = $derived.by(() => {
		const log = service.messageLog;
		for (let i = log.length - 1; i >= 0; i--) {
			const msg = log[i];
			if (msg.role === 'assistant' && msg.content) return { role: msg.role, text: msg.content, pending: false };
			if (msg.role === 'user' && msg.content) return { role: msg.role, text: msg.content, pending: !!msg.pending };
		}
		return null;
	});
</script>

{#if caption}
	<div class="voice-caption-row">
		<p class="voice-caption" class:user={caption.role === 'user'} class:pending={caption.pending}>
			{caption.text}{#if caption.pending || (caption.role === 'assistant' && service.chatStreaming)}<span class="live-caret"></span>{/if}
		</p>
		{#if caption.role === 'assistant' && caption.text && !service.chatStreaming}
			<button
				type="button"
				class="voice-replay"
				class:playing={service.assistantSpeaking}
				aria-label="Replay message"
				onclick={() => service.replayLastAssistant()}
			>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<path d="M3 12a9 9 0 1 0 3-6.7" />
					<path d="M3 4v5h5" />
				</svg>
			</button>
		{/if}
	</div>
{/if}
<audio id="graph-voice-audio" style="display:none"></audio>

<style>
	.voice-caption-row {
		display: flex;
		align-items: flex-start;
		justify-content: center;
		gap: 8px;
		max-width: min(34rem, calc(100vw - 48px));
	}

	.voice-caption {
		margin: 0;
		flex: 1;
		min-width: 0;
		max-width: min(28rem, calc(100vw - 48px));
		max-height: min(36vh, 280px);
		overflow-y: auto;
		overscroll-behavior: contain;
		-webkit-overflow-scrolling: touch;
		padding: 10px 16px;
		border-radius: 14px;
		background: oklch(10% 0.02 255 / 72%);
		border: 1px solid oklch(82% 0.14 210 / 22%);
		text-align: left;
		font-size: 14px;
		line-height: 1.5;
		font-weight: 400;
		letter-spacing: 0.01em;
		font-family: var(--font-sans, Inter, system-ui, sans-serif);
		color: oklch(92% 0.02 210);
		text-wrap: pretty;
		pointer-events: auto;
	}

	.voice-caption.user {
		color: oklch(90% 0.02 210);
	}

	.voice-caption.pending {
		color: oklch(88% 0.04 210 / 88%);
	}

	.live-caret {
		display: inline-block;
		width: 2px;
		height: 0.9em;
		margin-left: 3px;
		vertical-align: -0.1em;
		background: oklch(82% 0.14 210);
		animation: caret-blink 1s steps(1) infinite;
	}

	@keyframes caret-blink {
		50% { opacity: 0; }
	}

	.voice-replay {
		flex-shrink: 0;
		width: 36px;
		height: 36px;
		border: 1px solid oklch(82% 0.14 210 / 22%);
		border-radius: 50%;
		background: oklch(10% 0.02 255 / 72%);
		color: oklch(82% 0.14 210);
		display: grid;
		place-items: center;
		cursor: pointer;
		padding: 0;
	}
	.voice-replay svg {
		width: 16px;
		height: 16px;
	}
	.voice-replay:hover,
	.voice-replay.playing {
		border-color: oklch(82% 0.14 210 / 45%);
		color: oklch(90% 0.08 210);
	}
</style>
