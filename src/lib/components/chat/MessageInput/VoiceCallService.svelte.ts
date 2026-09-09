/**
 * VoiceCallService — extracted from CallOverlay.svelte.
 *
 * Encapsulates the entire voice-call lifecycle: microphone recording,
 * silence detection, transcription, TTS playback (browser / Kokoro /
 * OpenAI), audio level analysis (RMS), and chat-event orchestration.
 *
 * Reactive state uses Svelte 5 runes ($state) so any consuming component
 * can bind to the same values the old CallOverlay did.
 *
 * Usage:
 *   const svc = new VoiceCallService({ eventTarget, submitPrompt, stopResponse, chatId, modelId });
 *   await svc.start();
 *   // ... svc.rmsLevel, svc.assistantSpeaking, svc.muted, etc. are reactive
 *   await svc.stop();
 */

import { config, models, settings, TTSWorker } from '$lib/stores';
import { get } from 'svelte/store';
import { tick } from 'svelte';
import type { Writable } from 'svelte/store';
import type { i18n as i18nType } from 'i18next';

import { blobToFile } from '$lib/utils';
import { generateEmoji } from '$lib/apis';
import { synthesizeOpenAISpeech, transcribeAudio } from '$lib/apis/audio';
import { toast } from 'svelte-sonner';
import { KokoroWorker } from '$lib/workers/KokoroWorker';
import { WEBUI_API_BASE_URL } from '$lib/constants';

const MIN_DECIBELS = -55;
const RECORDER_TIMESLICE_MS = 400;

const voiceMark = (callMs: number, uttMs: number | null, step: string, extra?: string) => {
	const clock = new Date().toISOString().slice(11, 23);
	const utt = uttMs === null ? '-' : `+${uttMs.toFixed(0)}ms`;
	console.log(`[voice-timing] ${clock}  call+${callMs.toFixed(0)}ms  utt${utt}  ${step}${extra ? `  ${extra}` : ''}`);
};

export interface VoiceCallOptions {
	eventTarget: EventTarget;
	submitPrompt: (content: string, opts?: any) => Promise<any>;
	stopResponse: (processQueue?: boolean) => Promise<void>;
	chatId: string;
	modelId: string;
	audioStream?: MediaStream;
	audioContext?: AudioContext;
}

export interface VoiceMessage {
	role: 'user' | 'assistant';
	content: string;
	pending?: boolean;
}

export class VoiceCallService {
	// ── Reactive state ($state) ────────────────────────────────────────
	loading = $state(false);
	confirmed = $state(false);
	interrupted = $state(false);
	assistantSpeaking = $state(false);
	muted = $state(false);
	emoji = $state<string | null>(null);
	camera = $state(false);
	chatStreaming = $state(false);
	rmsLevel = $state(0);
	visualRms = $state(0);
	speaking = $state(false);
	micReady = $state(false);
	transcribing = $state(false);

	transcript = $state('');
	liveTranscript = $state('');
	assistantText = $state('');
	messageLog = $state<VoiceMessage[]>([]);

	// ── Non-reactive internal state ────────────────────────────────────
	private hasStartedSpeaking = false;
	private recorderMime = 'audio/webm';
	private usedPassedContext = false;
	private callOrigin = 0;
	private utteranceOrigin = 0;
	private firstTokenLogged = false;

	private mark(step: string, extra?: string) {
		const now = performance.now();
		voiceMark(
			this.callOrigin ? now - this.callOrigin : 0,
			this.utteranceOrigin ? now - this.utteranceOrigin : null,
			step,
			extra
		);
	}
	private mediaRecorder: MediaRecorder | false = false;
	private audioStream: MediaStream | null = null;
	private audioChunks: Blob[] = [];

	private cameraStream: MediaStream | null = null;
	videoInputDevices: MediaDeviceInfo[] = [];
	selectedVideoInputDeviceId: string | null = null;

	private finishedMessages: Record<string, boolean> = {};
	private currentMessageId: string | null = null;
	private currentUtterance: SpeechSynthesisUtterance | null = null;

	private audioAbortController = new AbortController();
	private audioCache = new Map<string, any>();
	private audioInflight = new Map<string, Promise<any>>();
	private emojiCache = new Map<string, string>();
	private messages: Record<string, string[]> = {};

	private model: any = null;
	private wakeLock: any = null;

	// Files can be set externally (e.g. for camera screenshots)
	files: any[] = [];

	private opts: VoiceCallOptions;

	constructor(opts: VoiceCallOptions) {
		this.opts = opts;
	}

	// ── Public API ─────────────────────────────────────────────────────

	async start() {
		this.callOrigin = performance.now();
		this.mark('call_start');
		this.model = get(models).find((m) => m.id === this.opts.modelId);
		if (this.opts.audioStream) this.audioStream = this.opts.audioStream;
		void this.initTTSWorker();
		await this.startRecording();
		this.attachChatListeners();
		document.addEventListener('keydown', this.handleKeydown);
		await this.acquireWakeLock();
		document.addEventListener('visibilitychange', this.handleVisibilityChange);
		this.mark('call_ready');
	}

	private async initTTSWorker() {
		const s = get(settings);
		if (s?.audio?.tts?.engine === 'browser-kokoro' && !get(TTSWorker)) {
			const worker = new KokoroWorker({
				dtype: s?.audio?.tts?.engineConfig?.dtype ?? 'fp32'
			});
			TTSWorker.set(worker);
			await worker.init();
		}
	}

	async stop() {
		this.micReady = false;
		await this.stopAllAudio();
		this.speaking = false;
		this.liveTranscript = '';
		await this.stopRecordingCallback(false);
		await this.stopCamera();
		await this.stopAudioStream();
		this.detachChatListeners();
		document.removeEventListener('keydown', this.handleKeydown);
		document.removeEventListener('visibilitychange', this.handleVisibilityChange);
		this.audioAbortController.abort();
		this.releaseWakeLock();
	}

	toggleMute() {
		this.muted = !this.muted;
		if (this.muted && this.hasStartedSpeaking) {
			this.hasStartedSpeaking = false;
			this.speaking = false;
			this.confirmed = false;
			this.audioChunks = [];
			if (this.mediaRecorder && (this.mediaRecorder as MediaRecorder).state === 'recording') {
				(this.mediaRecorder as MediaRecorder).stop();
			}
		}
		if (this.muted) {
			this.liveTranscript = '';
		}
	}

	// ── Video / Camera ─────────────────────────────────────────────────

	async getVideoInputDevices() {
		const devices = await navigator.mediaDevices.enumerateDevices();
		this.videoInputDevices = devices.filter((d) => d.kind === 'videoinput');
		if (!!navigator.mediaDevices.getDisplayMedia) {
			this.videoInputDevices = [
				...this.videoInputDevices,
				{ deviceId: 'screen', label: 'Screen Share' } as any
			];
		}
		if (this.selectedVideoInputDeviceId === null && this.videoInputDevices.length > 0) {
			const saved = localStorage.getItem('selectedVideoInputDeviceId');
			if (saved && this.videoInputDevices.some((d) => d.deviceId === saved)) {
				this.selectedVideoInputDeviceId = saved;
			} else {
				this.selectedVideoInputDeviceId = this.videoInputDevices[0].deviceId;
			}
		}
	}

	async startCamera() {
		await this.getVideoInputDevices();
		if (this.cameraStream === null) {
			this.camera = true;
			try {
				await this.startVideoStream();
			} catch (err) {
				console.error('Error accessing webcam: ', err);
			}
		}
	}

	async startVideoStream() {
		const video = document.getElementById('camera-feed') as HTMLVideoElement | null;
		if (!video) return;
		if (this.selectedVideoInputDeviceId === 'screen') {
			this.cameraStream = await navigator.mediaDevices.getDisplayMedia({
				video: { cursor: 'always' },
				audio: false
			});
		} else {
			this.cameraStream = await navigator.mediaDevices.getUserMedia({
				video: {
					deviceId: this.selectedVideoInputDeviceId
						? { exact: this.selectedVideoInputDeviceId }
						: undefined
				}
			});
		}
		if (this.cameraStream) {
			await this.getVideoInputDevices();
			video.srcObject = this.cameraStream;
			await video.play();
		}
	}

	async stopVideoStream() {
		if (this.cameraStream) {
			this.cameraStream.getTracks().forEach((t) => t.stop());
		}
		this.cameraStream = null;
	}

	takeScreenshot(): string | void {
		const video = document.getElementById('camera-feed') as HTMLVideoElement | null;
		const canvas = document.getElementById('camera-canvas') as HTMLCanvasElement | null;
		if (!canvas) return;
		const ctx = canvas.getContext('2d')!;
		canvas.width = video!.videoWidth;
		canvas.height = video!.videoHeight;
		ctx.drawImage(video!, 0, 0, video!.videoWidth, video!.videoHeight);
		return canvas.toDataURL('image/png');
	}

	async stopCamera() {
		await this.stopVideoStream();
		this.camera = false;
	}

	// ── Recording + Transcription ──────────────────────────────────────

	private transcribeHandler = async (audioBlob: Blob) => {
		if (!audioBlob || audioBlob.size < 100) return;
		await tick();
		this.transcribing = true;
		let spoken = '';
		const whisperStarted = performance.now();
		this.mark('final_whisper_start', `bytes=${audioBlob.size}`);
		try {
			const file = this.audioBlobToFile(audioBlob, 'recording');
			const res = await transcribeAudio(
				localStorage.token,
				file,
				get(settings)?.audio?.stt?.language
			).catch((error) => {
				toast.error(`${error}`);
				return null;
			});
			spoken = (res?.text ?? '').trim() || this.pendingUserText();
			if (this.isLikelyHallucination(spoken)) {
				const pending = this.pendingUserText();
				spoken = this.isLikelyHallucination(pending) ? '' : pending;
			}
		} finally {
			this.transcribing = false;
		}
		this.mark(
			'final_whisper_done',
			`dur=${(performance.now() - whisperStarted).toFixed(0)}ms  text="${spoken.slice(0, 80)}"`
		);
		this.liveTranscript = spoken;
		if (spoken) {
			this.transcript = spoken;
			this.finalizeUser(spoken);
			this.mark('submit_prompt_start');
			await this.opts.submitPrompt(spoken, { _raw: true });
			this.mark('submit_prompt_done');
		} else {
			this.mark('final_whisper_empty');
			this.dropPendingUser();
		}
	};

	private stopRecordingCallback = async (_continue = true) => {
		const _audioChunks = this.audioChunks.slice(0);
		this.audioChunks = [];
		this.mediaRecorder = false;

		if (_continue) {
			this.startRecording();
		}

		this.speaking = false;
		this.hasStartedSpeaking = false;

		if (this.confirmed) {
			this.loading = true;
			this.emoji = null;

			if (this.cameraStream) {
				const imageUrl = this.takeScreenshot();
				if (imageUrl) {
					this.files = [{ type: 'image', url: imageUrl }];
				}
			}

			const audioBlob = new Blob(_audioChunks, { type: this.recorderMime });
			await this.transcribeHandler(audioBlob);
			this.confirmed = false;
			this.loading = false;
		}
	};

	private startRecording = async () => {
		if (!this.audioStream) {
			this.audioStream = await navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
			});
		}

		const mime = this.pickRecorderMime();
		this.mediaRecorder = mime
			? new MediaRecorder(this.audioStream, { mimeType: mime })
			: new MediaRecorder(this.audioStream);
		this.recorderMime = this.mediaRecorder.mimeType || mime || 'audio/webm';

		this.mediaRecorder.onstart = () => {
			this.audioChunks = [];
			this.micReady = true;
			this.mark('mic_recording');
		};

		this.mediaRecorder.ondataavailable = (event) => {
			if (!event.data || event.data.size === 0) return;
			if (!this.hasStartedSpeaking) {
				if (this.audioChunks.length === 0) {
					this.audioChunks.push(event.data);
				} else {
					this.audioChunks = [this.audioChunks[0], event.data];
				}
				return;
			}
			this.audioChunks.push(event.data);
		};

		this.mediaRecorder.onstop = () => {
			this.stopRecordingCallback();
		};

		if (this.mediaRecorder.state !== 'recording') {
			this.mediaRecorder.start(RECORDER_TIMESLICE_MS);
		}

		this.analyseAudio(this.audioStream);
	};

	stopAudioStream = async () => {
		try {
			if (this.mediaRecorder) {
				(this.mediaRecorder as MediaRecorder).stop();
			}
		} catch (e) {
			console.log('Error stopping audio stream:', e);
		}
		if (!this.audioStream) return;
		this.audioStream.getAudioTracks().forEach((t) => t.stop());
		this.audioStream = null;
	};

	// ── Audio Analysis (RMS) ───────────────────────────────────────────

	private calculateRMS = (data: Uint8Array) => {
		let sum = 0;
		for (let i = 0; i < data.length; i++) {
			const v = (data[i] - 128) / 128;
			sum += v * v;
		}
		return Math.sqrt(sum / data.length);
	};

	private analyseAudio = (stream: MediaStream) => {
		let audioContext: AudioContext;
		if (this.opts.audioContext && !this.usedPassedContext) {
			audioContext = this.opts.audioContext;
			this.usedPassedContext = true;
		} else {
			audioContext = new AudioContext();
		}
		if (audioContext.state === 'suspended') void audioContext.resume();
		const source = audioContext.createMediaStreamSource(stream);
		const analyser = audioContext.createAnalyser();
		analyser.minDecibels = MIN_DECIBELS;
		source.connect(analyser);

		const domainData = new Uint8Array(analyser.frequencyBinCount);
		const timeDomainData = new Uint8Array(analyser.fftSize);
		let lastSoundTime = Date.now();
		this.hasStartedSpeaking = false;

		const processFrame = () => {
			if (!this.mediaRecorder) return;

			const deaf = this.isDeafToMic();
			if (deaf) {
				analyser.maxDecibels = 0;
				analyser.minDecibels = -1;
			} else {
				analyser.minDecibels = MIN_DECIBELS;
				analyser.maxDecibels = -30;
			}

			analyser.getByteTimeDomainData(timeDomainData);
			analyser.getByteFrequencyData(domainData);

			const rms = this.calculateRMS(timeDomainData);
			this.visualRms = this.muted ? 0 : rms;
			this.rmsLevel = deaf ? 0 : rms;

			const hasSound = !deaf && domainData.some((v) => v > 0);
			if (hasSound) {
				if (!this.hasStartedSpeaking) {
					this.hasStartedSpeaking = true;
					this.speaking = true;
					this.transcript = '';
					this.liveTranscript = '';
					this.utteranceOrigin = performance.now();
					this.firstTokenLogged = false;
					this.mark('speech_detected');
					this.stopAllAudio();
				}
				lastSoundTime = Date.now();
			}

			if (this.hasStartedSpeaking) {
				if (Date.now() - lastSoundTime > 2000) {
					this.confirmed = true;
					this.mark('silence_commit');
					if (this.mediaRecorder) {
						(this.mediaRecorder as MediaRecorder).stop();
						return;
					}
				}
			}

			window.requestAnimationFrame(processFrame);
		};

		window.requestAnimationFrame(processFrame);
	};

	// ── TTS ────────────────────────────────────────────────────────────

	private getVoiceId = () => {
		if (this.model?.info?.meta?.tts?.voice) return this.model.info.meta.tts.voice;
		const s = get(settings);
		if (s?.audio?.tts?.defaultVoice === get(config)?.audio?.tts?.voice) {
			return s?.audio?.tts?.voice ?? get(config)?.audio?.tts?.voice;
		}
		return get(config)?.audio?.tts?.voice;
	};

	private speakSpeechSynthesisHandler = (content: string) =>
		new Promise<void>((resolve) => {
			const loop = setInterval(async () => {
				const voices = await speechSynthesis.getVoices();
				if (voices.length === 0) return;
				clearInterval(loop);
				const voiceId = this.getVoiceId();
				const voice = voices.find((v) => v.voiceURI === voiceId);
				this.currentUtterance = new SpeechSynthesisUtterance(content);
				this.currentUtterance.rate = get(settings)?.audio?.tts?.playbackRate ?? 1;
				if (voice) this.currentUtterance.voice = voice;
				speechSynthesis.speak(this.currentUtterance);
				this.currentUtterance.onend = async () => {
					await new Promise((r) => setTimeout(r, 200));
					resolve();
				};
			}, 100);
		});

	private playAudio = (audio: any) =>
		new Promise<void>((resolve) => {
			const el = document.getElementById('audioElement') as HTMLAudioElement | null;
			if (!el) return resolve();
			this.mark('tts_play_start');
			el.src = audio.src;
			el.muted = true;
			el.playbackRate = get(settings)?.audio?.tts?.playbackRate ?? 1;
			el.play()
				.then(() => {
					el.muted = false;
				})
				.catch(console.error);
			el.onended = async () => {
				this.mark('tts_play_done');
				await new Promise((r) => setTimeout(r, 100));
				resolve();
			};
		});

	stopAllAudio = async () => {
		this.assistantSpeaking = false;
		this.interrupted = true;
		if (this.chatStreaming) {
			await this.opts.stopResponse();
		}
		if (this.currentUtterance) {
			speechSynthesis.cancel();
			this.currentUtterance = null;
		}
		const el = document.getElementById('audioElement');
		if (el) {
			(el as HTMLAudioElement).muted = true;
			(el as HTMLAudioElement).pause();
			(el as HTMLAudioElement).currentTime = 0;
		}
	};

	private fetchAudio = async (content: string) => {
		if (this.audioCache.has(content)) return this.audioCache.get(content);
		const pending = this.audioInflight.get(content);
		if (pending) return pending;
		const job = (async () => {
			await this.synthesizeAudio(content);
			if (!this.audioCache.has(content)) await this.synthesizeAudio(content);
			return this.audioCache.get(content);
		})().finally(() => this.audioInflight.delete(content));
		this.audioInflight.set(content, job);
		return job;
	};

	private synthesizeAudio = async (content: string) => {
		if (this.audioCache.has(content)) return;
		const ttsStarted = performance.now();
		this.mark('tts_synth_start', `chars=${content.length}`);
		try {
			const s = get(settings);
			if (s?.showEmojiInCall ?? false) {
				const em = await generateEmoji(
					localStorage.token,
					this.opts.modelId,
					content,
					this.opts.chatId
				);
				if (em) this.emojiCache.set(content, em);
			}

			if (s?.audio?.tts?.engine === 'browser-kokoro') {
				const url = await get(TTSWorker)
					?.generate({ text: content, voice: this.getVoiceId() })
					.catch((e: any) => {
						console.error(e);
						toast.error(`${e}`);
					});
				if (url) {
					this.audioCache.set(content, new Audio(url));
				}
			} else if (get(config)?.audio?.tts?.engine !== '') {
				const res = await synthesizeOpenAISpeech(
					localStorage.token,
					this.getVoiceId(),
					content
				).catch((e) => {
					console.error(e);
					return null;
				});
				if (res) {
					const blob = await res.blob();
					this.audioCache.set(content, new Audio(URL.createObjectURL(blob)));
				}
			} else {
				this.audioCache.set(content, true);
			}
		} catch (e) {
			console.error('Error synthesizing speech:', e);
		}
		this.mark('tts_synth_done', `dur=${(performance.now() - ttsStarted).toFixed(0)}ms`);
	};

	private monitorAndPlayAudio = async (id: string, signal: AbortSignal) => {
		while (!signal.aborted) {
			const queue = this.messages[id];
			if (queue && queue.length > 0) {
				const content = queue.shift()!;
				await this.fetchAudio(content);
				const cached = this.audioCache.get(content);
				const s = get(settings);
				if ((s?.showEmojiInCall ?? false) && this.emojiCache.has(content)) {
					this.emoji = this.emojiCache.get(content)!;
				} else {
					this.emoji = null;
				}
				try {
					if (cached && cached !== true) {
						await this.playAudio(cached);
					} else if (!get(config)?.audio?.tts?.engine && s?.audio?.tts?.engine !== 'browser-kokoro') {
						await this.speakSpeechSynthesisHandler(content);
					}
				} catch (e) {
					console.error('Error playing audio:', e);
				}
				await new Promise((r) => setTimeout(r, 150));
			} else if (this.finishedMessages[id]) {
				this.assistantSpeaking = false;
				break;
			} else {
				await new Promise((r) => setTimeout(r, 200));
			}
		}
		this.assistantSpeaking = false;
		this.mark('tts_queue_idle');
	};

	// ── Chat Event Handlers ────────────────────────────────────────────

	private chatStartHandler = async (e: Event) => {
		const { id } = (e as CustomEvent).detail;
		this.chatStreaming = true;
		if (this.currentMessageId !== id) {
			this.currentMessageId = id;
			this.assistantText = '';
			this.messageLog = [...this.messageLog, { role: 'assistant', content: '' }];
			this.audioAbortController.abort();
			this.audioAbortController = new AbortController();
			this.assistantSpeaking = true;
			this.mark('llm_start', `id=${id.slice(0, 8)}`);
			this.monitorAndPlayAudio(id, this.audioAbortController.signal);
		}
	};

	private chatEventHandler = async (e: Event) => {
		const { id, content } = (e as CustomEvent).detail;
		if (this.currentMessageId === id) {
			if (this.messages[id] === undefined) {
				this.messages[id] = [content];
			} else {
				this.messages[id].push(content);
			}
			this.fetchAudio(content);
		}
	};

	private applyAssistantText(text: string) {
		if (!text) return;
		this.assistantText = text;
		const last = this.messageLog.at(-1);
		if (last?.role === 'assistant') {
			this.messageLog = this.messageLog.map((m, i) =>
				i === this.messageLog.length - 1 && m.role === 'assistant' ? { ...m, content: text } : m
			);
			return;
		}
		this.messageLog = [...this.messageLog, { role: 'assistant', content: text }];
	}

	private chatContentHandler = (e: Event) => {
		const { id, fullContent } = (e as CustomEvent).detail as {
			id: string;
			fullContent?: string;
		};
		if (!fullContent) return;
		if (this.currentMessageId && this.currentMessageId !== id) return;
		if (!this.firstTokenLogged) {
			this.firstTokenLogged = true;
			this.mark('llm_first_token', `chars=${fullContent.length}`);
		}
		this.applyAssistantText(fullContent);
	};

	private chatFinishHandler = async (e: Event) => {
		const { id, content } = (e as CustomEvent).detail as { id: string; content?: string };
		this.finishedMessages[id] = true;
		this.chatStreaming = false;
		if (content) this.applyAssistantText(content);
		this.mark('llm_done', `chars=${(content ?? '').length}`);
		this.currentMessageId = null;
	};

	private attachChatListeners() {
		this.opts.eventTarget.addEventListener('chat:start', this.chatStartHandler as EventListener);
		this.opts.eventTarget.addEventListener('chat', this.chatEventHandler as EventListener);
		this.opts.eventTarget.addEventListener('chat:content', this.chatContentHandler as EventListener);
		this.opts.eventTarget.addEventListener('chat:finish', this.chatFinishHandler as EventListener);
	}

	private detachChatListeners() {
		this.opts.eventTarget.removeEventListener('chat:start', this.chatStartHandler as EventListener);
		this.opts.eventTarget.removeEventListener('chat', this.chatEventHandler as EventListener);
		this.opts.eventTarget.removeEventListener('chat:content', this.chatContentHandler as EventListener);
		this.opts.eventTarget.removeEventListener('chat:finish', this.chatFinishHandler as EventListener);
	}

	private lastUser(): VoiceMessage | undefined {
		const last = this.messageLog.at(-1);
		return last?.role === 'user' ? last : undefined;
	}

	private pendingUserText(): string {
		return this.lastUser()?.content?.trim() || this.liveTranscript.trim();
	}

	private isDeafToMic() {
		if (this.muted || this.loading) return true;
		if (this.assistantSpeaking || this.chatStreaming) {
			return !(get(settings)?.voiceInterruption ?? false);
		}
		return false;
	}

	private isLikelyHallucination(text: string) {
		const compact = text.replace(/\s+/g, ' ').trim();
		if (!compact) return true;
		const tokens = compact.split(' ');
		const norm = tokens
			.map((t) => t.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase())
			.filter(Boolean);
		if (norm.length >= 8) {
			const unique = new Set(norm);
			if (unique.size <= 4) return true;
		}
		const chars = compact.replace(/\s/g, '');
		const digits = chars.replace(/\D/g, '').length;
		return chars.length >= 12 && digits / chars.length > 0.4;
	}

	private finalizeUser(text: string) {
		if (this.lastUser()) {
			this.messageLog = this.messageLog.map((m, i) =>
				i === this.messageLog.length - 1 && m.role === 'user'
					? { role: 'user', content: text }
					: m
			);
			return;
		}
		this.messageLog = [...this.messageLog, { role: 'user', content: text }];
	}

	private dropPendingUser() {
		if (!this.lastUser()?.pending) return;
		this.messageLog = this.messageLog.slice(0, -1);
	}

	private pickRecorderMime(): string {
		const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
		return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
	}

	private audioBlobToFile(blob: Blob, stem: string): File {
		const type = blob.type || this.recorderMime || 'audio/webm';
		const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : type.includes('wav') ? 'wav' : 'webm';
		return blobToFile(blob, `${stem}.${ext}`);
	}

	// ── Wake Lock ──────────────────────────────────────────────────────

	private acquireWakeLock = async () => {
		if (!('wakeLock' in navigator)) return;
		try {
			this.wakeLock = await navigator.wakeLock.request('screen');
			this.wakeLock?.addEventListener?.('release', () => console.log('Wake Lock released'));
		} catch (err) {
			console.log(err);
		}
	};

	private handleVisibilityChange = async () => {
		if (this.wakeLock !== null && document.visibilityState === 'visible') {
			await this.acquireWakeLock();
		}
	};

	private releaseWakeLock = async () => {
		try {
			await this.wakeLock?.release?.();
		} catch {}
		this.wakeLock = null;
	};

	// ── Keyboard ───────────────────────────────────────────────────────

	private handleKeydown = (e: KeyboardEvent) => {
		if (e.key === 'm' || e.key === 'M') {
			const t = e.target as HTMLElement;
			if (t.tagName !== 'INPUT' && t.tagName !== 'TEXTAREA' && !t.isContentEditable) {
				e.preventDefault();
				this.toggleMute();
			}
		}
	};

	// ── Helpers for UI ─────────────────────────────────────────────────

	get modelImageUrl(): string {
		return `${WEBUI_API_BASE_URL}/models/model/profile/image?id=${this.opts.modelId}&lang=en&voice=true`;
	}

	get statusText(): string {
		if (!this.micReady) return 'Starting microphone…';
		if (this.muted) return 'Muted';
		if (this.transcribing) return 'Transcribing';
		if (this.loading || this.chatStreaming) return 'Thinking';
		if (this.assistantSpeaking) return 'Tap to skip';
		if (this.speaking) return 'Listening';
		return 'You may start speaking';
	}
}