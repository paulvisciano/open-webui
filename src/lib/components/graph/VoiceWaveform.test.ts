import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import VoiceWaveform from './VoiceWaveform.svelte';

describe('VoiceWaveform', () => {
	it.each(['idle', 'user', 'assistant'] as const)('renders %s mode without throwing', (mode) => {
		const { container } = render(VoiceWaveform, {
			props: { rms: mode === 'user' ? 0.4 : 0.08, mode }
		});
		expect(container.querySelector('canvas.voice-wave')).not.toBeNull();
	});
});
