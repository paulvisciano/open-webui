import type { Meta, StoryObj } from '@storybook/svelte';
import VoiceWaveform from './VoiceWaveform.svelte';

const meta = {
	title: 'Graph/VoiceWaveform',
	component: VoiceWaveform,
	parameters: { layout: 'centered' },
	args: { rms: 0.08, mode: 'idle' }
} satisfies Meta<typeof VoiceWaveform>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Idle: Story = {
	args: { rms: 0.08, mode: 'idle' }
};

export const User: Story = {
	args: { rms: 0.45, mode: 'user' }
};

export const Assistant: Story = {
	args: { rms: 0.2, mode: 'assistant' }
};
