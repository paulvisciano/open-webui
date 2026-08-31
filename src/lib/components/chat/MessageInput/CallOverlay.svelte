<script lang="ts">
	import { showCallOverlay } from '$lib/stores';
	import { onMount, onDestroy, createEventDispatcher, getContext } from 'svelte';
	import type { Writable } from 'svelte/store';
	import type { i18n as i18nType } from 'i18next';

	import { toast } from 'svelte-sonner';

	import Tooltip from '$lib/components/common/Tooltip.svelte';
	import VideoInputMenu from './CallOverlay/VideoInputMenu.svelte';
	import { VoiceCallService } from './VoiceCallService.svelte';

	const i18n: Writable<i18nType> = getContext('i18n');

	const statusLabels = {
		thinking: 'Thinking...',
		muted: 'Muted',
		interrupt: 'Tap to interrupt',
		listening: 'Listening...'
	};

	const dispatch = createEventDispatcher();

	export let eventTarget: EventTarget;
	export let submitPrompt: Function;
	export let stopResponse: Function;
	export let files;
	export let chatId;
	export let modelId;

	let svc: VoiceCallService | null = null;

	onMount(async () => {
		svc = new VoiceCallService({
			eventTarget,
			submitPrompt: submitPrompt as any,
			stopResponse: stopResponse as any,
			chatId,
			modelId
		});
		await svc.start();
	});

	onDestroy(async () => {
		await svc?.stop();
	});
</script>

{#if $showCallOverlay && svc}
	<div class="max-w-lg w-full h-full max-h-[100dvh] flex flex-col justify-between p-3 md:p-6">
		{#if svc.camera}
			<button
				type="button"
				class="flex justify-center items-center w-full h-20 min-h-20"
				on:click={() => {
					if (svc!.assistantSpeaking) {
						svc!.stopAllAudio();
					}
				}}
			>
				{#if svc.emoji}
					<div
						class="  transition-all rounded-full"
						style="font-size:{svc.rmsLevel * 100 > 4
							? '4.5'
							: svc.rmsLevel * 100 > 2
								? '4.25'
								: svc.rmsLevel * 100 > 1
									? '3.75'
									: '3.5'}rem;width: 100%; text-align:center;"
					>
						{svc.emoji}
					</div>
				{:else if svc.loading || svc.assistantSpeaking}
					<svg
						class="size-12 text-gray-900 dark:text-gray-400"
						viewBox="0 0 24 24"
						fill="currentColor"
						xmlns="http://www.w3.org/2000/svg"
						><style>
							.spinner_qM83 {
								animation: spinner_8HQG 1.05s infinite;
							}
							.spinner_oXPr {
								animation-delay: 0.1s;
							}
							.spinner_ZTLf {
								animation-delay: 0.2s;
							}
							@keyframes spinner_8HQG {
								0%,
								57.14% {
									animation-timing-function: cubic-bezier(0.33, 0.66, 0.66, 1);
									transform: translate(0);
								}
								28.57% {
									animation-timing-function: cubic-bezier(0.33, 0, 0.66, 0.33);
									transform: translateY(-6px);
								}
								100% {
									transform: translate(0);
								}
							}
						</style><circle class="spinner_qM83" cx="4" cy="12" r="3" /><circle
							class="spinner_qM83 spinner_oXPr"
							cx="12"
							cy="12"
							r="3"
						/><circle class="spinner_qM83 spinner_ZTLf" cx="20" cy="12" r="3" /></svg
					>
				{:else}
					<div
						class=" {svc.rmsLevel * 100 > 4
							? ' size-[4.5rem]'
							: svc.rmsLevel * 100 > 2
								? ' size-16'
								: svc.rmsLevel * 100 > 1
									? 'size-14'
									: 'size-12'}  transition-all rounded-full bg-cover bg-center bg-no-repeat"
						style={`background-image: url('${svc.modelImageUrl}');`}
					/>
				{/if}
			</button>
		{/if}

		<div class="flex justify-center items-center flex-1 h-full w-full max-h-full">
			{#if !svc.camera}
				<button
					type="button"
					on:click={() => {
						if (svc!.assistantSpeaking) {
							svc!.stopAllAudio();
						}
					}}
				>
					{#if svc.emoji}
						<div
							class="  transition-all rounded-full"
							style="font-size:{svc.rmsLevel * 100 > 4
								? '13'
								: svc.rmsLevel * 100 > 2
									? '12'
									: svc.rmsLevel * 100 > 1
										? '11.5'
										: '11'}rem;width:100%;text-align:center;"
						>
							{svc.emoji}
						</div>
					{:else if svc.loading || svc.assistantSpeaking}
						<svg
							class="size-44 text-gray-900 dark:text-gray-400"
							viewBox="0 0 24 24"
							fill="currentColor"
							xmlns="http://www.w3.org/2000/svg"
							><style>
								.spinner_qM83 {
									animation: spinner_8HQG 1.05s infinite;
								}
								.spinner_oXPr {
									animation-delay: 0.1s;
								}
								.spinner_ZTLf {
									animation-delay: 0.2s;
								}
								@keyframes spinner_8HQG {
									0%,
									57.14% {
										animation-timing-function: cubic-bezier(0.33, 0.66, 0.66, 1);
										transform: translate(0);
									}
									28.57% {
										animation-timing-function: cubic-bezier(0.33, 0, 0.66, 0.33);
										transform: translateY(-6px);
									}
									100% {
										transform: translate(0);
									}
								}
							</style><circle class="spinner_qM83" cx="4" cy="12" r="3" /><circle
								class="spinner_qM83 spinner_oXPr"
								cx="12"
								cy="12"
								r="3"
							/><circle class="spinner_qM83 spinner_ZTLf" cx="20" cy="12" r="3" /></svg
						>
					{:else}
						<div
							class=" {svc.rmsLevel * 100 > 4
								? ' size-52'
								: svc.rmsLevel * 100 > 2
									? 'size-48'
									: svc.rmsLevel * 100 > 1
										? 'size-44'
										: 'size-40'} transition-all rounded-full bg-cover bg-center bg-no-repeat"
							style={`background-image: url('${svc.modelImageUrl}');`}
						/>
					{/if}
				</button>
			{:else}
				<div class="relative flex video-container w-full max-h-full pt-2 pb-4 md:py-6 px-2 h-full">
					<!-- svelte-ignore a11y-media-has-caption -->
					<video
						id="camera-feed"
						autoplay
						class="rounded-2xl h-full min-w-full object-cover object-center"
						playsinline
					/>

					<canvas id="camera-canvas" style="display:none;" />

					<div class=" absolute top-4 md:top-8 left-4">
						<button
							type="button"
							aria-label="Stop camera"
							class="p-1.5 text-white cursor-pointer backdrop-blur-xl bg-black/10 rounded-full"
							on:click={() => svc!.stopCamera()}
						>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								viewBox="0 0 16 16"
								fill="currentColor"
								class="size-6"
							>
								<path
									d="M5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94 5.28 4.22Z"
								/>
							</svg>
						</button>
					</div>
				</div>
			{/if}
		</div>

		<div class="flex flex-col items-center gap-4 pb-4 w-full">
			<button
				type="button"
				class="z-10"
				on:click={() => {
					if (svc!.assistantSpeaking) {
						svc!.stopAllAudio();
					}
				}}
			>
				<div class="font-display line-clamp-1 text-sm font-normal">
					{$i18n.t(statusLabels[svc.statusText] ?? svc.statusText)}
				</div>
			</button>

			<div class="flex items-center justify-center gap-4 z-10">
				{#if svc.camera}
					<VideoInputMenu
						devices={svc.videoInputDevices}
						on:change={async (e) => {
							svc!.selectedVideoInputDeviceId = e.detail;
							localStorage.setItem('selectedVideoInputDeviceId', e.detail);
							await svc!.stopVideoStream();
							await svc!.startVideoStream();
						}}
					>
						<button
							aria-label="Switch camera"
							class="p-3 rounded-full bg-gray-50 dark:bg-gray-900"
							type="button"
						>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								viewBox="0 0 20 20"
								fill="currentColor"
								class="size-5"
							>
								<path
									fill-rule="evenodd"
									d="M15.312 11.424a5.5 5.5 0 0 1-9.201 2.466l-.312-.311h2.433a.75.75 0 0 0 0-1.5H3.989a.75.75 0 0 0-.75.75v4.242a.75.75 0 0 0 1.5 0v-2.43l.31.31a7 7 0 0 0 11.712-3.138.75.75 0 0 0-1.449-.39Zm1.23-3.723a.75.75 0 0 0 .219-.53V2.929a.75.75 0 0 0-1.5 0V5.36l-.31-.31A7 7 0 0 0 3.239 8.188a.75.75 0 1 0 1.448.389A5.5 5.5 0 0 1 13.89 6.11l.311.31h-2.432a.75.75 0 0 0 0 1.5h4.243a.75.75 0 0 0 .53-.219Z"
									clip-rule="evenodd"
								/>
							</svg>
						</button>
					</VideoInputMenu>
				{:else}
					<Tooltip content="Camera">
						<button
							aria-label="Camera"
							class="p-3 rounded-full bg-gray-50 dark:bg-gray-900"
							type="button"
							on:click={async () => {
								await navigator.mediaDevices.getUserMedia({ video: true });
								svc!.startCamera();
							}}
						>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								fill="none"
								viewBox="0 0 24 24"
								stroke-width="1.5"
								stroke="currentColor"
								class="size-5"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									d="M6.827 6.175A2.31 2.31 0 0 1 5.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 0 0-1.134-.175 2.31 2.31 0 0 1-1.64-1.055l-.822-1.316a2.192 2.192 0 0 0-1.736-1.039 48.774 48.774 0 0 0-5.232 0 2.192 2.192 0 0 0-1.736 1.039l-.821 1.316a2.31 2.31 0 0 0-.511.532Z"
								/>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									d="M16.5 12.75a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0ZM18.75 10.5h.008v.008h-.008V10.5Z"
								/>
							</svg>
						</button>
					</Tooltip>
				{/if}

				<Tooltip content={svc.muted ? 'Unmute (M)' : 'Mute (M)'}>
					<button
						class="p-3 rounded-full transition-colors duration-200 {svc.muted
							? 'bg-red-500 text-white'
							: 'bg-gray-50 dark:bg-gray-900'}"
						type="button"
						aria-label={svc.muted ? 'Unmute' : 'Mute'}
						on:click={() => svc!.toggleMute()}
					>
						{#if svc.muted}
							<svg
								xmlns="http://www.w3.org/2000/svg"
								fill="none"
								viewBox="0 0 24 24"
								stroke-width="1.5"
								stroke="currentColor"
								class="size-5"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z"
								/>
								<line
									x1="3"
									y1="3"
									x2="21"
									y2="21"
									stroke="currentColor"
									stroke-width="1.5"
									stroke-linecap="round"
								/>
							</svg>
						{:else}
							<svg
								xmlns="http://www.w3.org/2000/svg"
								fill="none"
								viewBox="0 0 24 24"
								stroke-width="1.5"
								stroke="currentColor"
								class="size-5"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z"
								/>
							</svg>
						{/if}
					</button>
				</Tooltip>

				<button
					aria-label="End call"
					class="p-3 rounded-full bg-gray-50 dark:bg-gray-900"
					on:click={async () => {
						await svc!.stopAllAudio();
						await svc!.stopAudioStream();
						await svc!.stopVideoStream();
						showCallOverlay.set(false);
						dispatch('close');
					}}
					type="button"
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						viewBox="0 0 20 20"
						fill="currentColor"
						class="size-5"
					>
						<path
							d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z"
						/>
					</svg>
				</button>
			</div>
		</div>
	</div>
{/if}