import type { TimeIndex } from './renderer/Layout';
import type { SceneManager } from './renderer/SceneManager';
import type { WallTimeSample } from './time-travel';

export const corridorClockRef: {
	scene: SceneManager | null;
	timeIndex: TimeIndex | null;
	focusMs: number | null;
	focusZ: number | null;
	wallTimeline: WallTimeSample[] | null;
} = {
	scene: null,
	timeIndex: null,
	focusMs: null,
	focusZ: null,
	wallTimeline: null
};
