<script lang="ts">
	import { fly } from 'svelte/transition';

	import { VoiceCallService } from '$lib/components/chat/MessageInput/VoiceCallService.svelte';

	let {
		service
	}: {
		service: VoiceCallService;
	} = $props();

	let scrollEl: HTMLDivElement | undefined = $state();

	let showTypingUser = $derived(service.loading && !service.transcript);
	let hasMessages = $derived(service.messageLog.length > 0);

	$effect(() => {
		void service.messageLog;
		void service.assistantText;
		if (scrollEl) {
			scrollEl.scrollTop = scrollEl.scrollHeight;
		}
	});
</script>

{#if hasMessages || showTypingUser}
	<div class="voice-messages-container">
		<div class="voice-messages-backdrop"></div>
		<div class="voice-messages" bind:this={scrollEl}>
			{#each service.messageLog as msg (msg)}
				{#if msg.role === 'user'}
					<div class="voice-bubble user-bubble" in:fly={{ y: 10, duration: 200 }}>
						{msg.content}
					</div>
				{:else}
					<div class="voice-bubble assistant-bubble" in:fly={{ y: 10, duration: 200 }}>
						{#if msg.content}
							{msg.content}
						{:else}
							<span class="typing-dots"><span></span><span></span><span></span></span>
						{/if}
					</div>
				{/if}
			{/each}

			{#if showTypingUser}
				<div class="voice-bubble user-bubble" in:fly={{ y: 10, duration: 200 }}>
					<span class="typing-dots"><span></span><span></span><span></span></span>
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	.voice-messages-container {
		position: absolute;
		right: 24px;
		bottom: calc(2rem + env(safe-area-inset-bottom, 0px));
		z-index: 40;
		width: min(360px, 35vw);
		pointer-events: auto;
	}

	.voice-messages-backdrop {
		position: absolute;
		inset: -8px;
		border-radius: 20px;
		background: oklch(10% 0.02 260 / 50%);
		backdrop-filter: blur(16px) saturate(1.2);
		-webkit-backdrop-filter: blur(16px) saturate(1.2);
		border: 1px solid oklch(50% 0.03 255 / 8%);
		box-shadow: 0 12px 40px oklch(0% 0 0 / 40%);
	}

	.voice-messages {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 8px;
		max-height: calc(4 * 72px);
		overflow-y: auto;
		scrollbar-width: thin;
		scrollbar-color: oklch(50% 0.03 255 / 30%) transparent;
		padding: 4px;
	}

	.voice-messages::-webkit-scrollbar {
		width: 4px;
	}
	.voice-messages::-webkit-scrollbar-track {
		background: transparent;
	}
	.voice-messages::-webkit-scrollbar-thumb {
		background: oklch(50% 0.03 255 / 30%);
		border-radius: 2px;
	}

	.voice-bubble {
		padding: 10px 16px;
		border-radius: 16px;
		font-size: 14px;
		line-height: 1.5;
		animation: bubble-in 0.3s cubic-bezier(0.16, 1, 0.3, 1) both;
		word-break: break-word;
	}

	.user-bubble {
		align-self: flex-end;
		background: oklch(18% 0.02 255 / 90%);
		backdrop-filter: blur(24px) saturate(1.4);
		-webkit-backdrop-filter: blur(24px) saturate(1.4);
		border: 1px solid oklch(82% 0.14 210 / 20%);
		color: oklch(90% 0.005 250);
		border-bottom-right-radius: 4px;
		box-shadow: 0 4px 16px oklch(0% 0 0 / 30%);
		max-width: 90%;
	}

	.assistant-bubble {
		align-self: flex-start;
		background: oklch(20% 0.015 255 / 90%);
		backdrop-filter: blur(24px) saturate(1.4);
		-webkit-backdrop-filter: blur(24px) saturate(1.4);
		border: 1px solid oklch(50% 0.03 255 / 15%);
		color: oklch(88% 0.01 250);
		border-bottom-left-radius: 4px;
		box-shadow: 0 4px 16px oklch(0% 0 0 / 30%);
		max-width: 90%;
	}

	@keyframes bubble-in {
		from { opacity: 0; transform: translateY(8px); }
		to   { opacity: 1; transform: translateY(0); }
	}

	.typing-dots {
		display: inline-flex;
		gap: 4px;
		align-items: center;
	}
	.typing-dots span {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: oklch(65% 0.02 255);
		animation: dot-bounce 1.4s infinite ease-in-out;
	}
	.typing-dots span:nth-child(2) { animation-delay: 0.16s; }
	.typing-dots span:nth-child(3) { animation-delay: 0.32s; }
	@keyframes dot-bounce {
		0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
		40% { transform: scale(1); opacity: 1; }
	}
</style>