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
	<p class="voice-caption" class:user={caption.role === 'user'} class:pending={caption.pending}>
		{caption.text}{#if caption.pending || (caption.role === 'assistant' && service.chatStreaming)}<span class="live-caret"></span>{/if}
	</p>
{/if}

<style>
	.voice-caption {
		margin: 0;
		max-width: min(34rem, calc(100vw - 48px));
		text-align: center;
		font-size: clamp(1.15rem, 4.6vw, 1.55rem);
		line-height: 1.45;
		font-weight: 400;
		letter-spacing: -0.01em;
		font-family: var(--font-display);
		color: oklch(94% 0.01 210);
		text-wrap: pretty;
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
</style>
