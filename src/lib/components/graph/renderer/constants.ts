/**
 * Constants for the infinite-canvas renderer.
 *
 * Ported from the reference repo `edoardolunardi/infinite-canvas`
 * (commit 528d811) `src/infinite-canvas/constants.ts`, adapted to plain
 * TypeScript with `CHUNK_SIZE` tuned to 160 world units so a 4:3 photo
 * plane (e.g. 120×90) fits inside a chunk cube with margin.
 */

/** World units per chunk cube edge. 160 fits a 4:3 photo plane with margin. */
export const CHUNK_SIZE = 160;

/** Half-extent (in chunks) of the always-mounted ring around the camera. */
export const RENDER_DISTANCE = 4;

export const HALL_RENDER_DISTANCE_Z = 18;

export const HALL_DEPTH_FADE_START = 1400;
export const HALL_DEPTH_FADE_END = 2800;

/** Extra ring of chunks beyond `RENDER_DISTANCE` that fades out smoothly. */
export const CHUNK_FADE_MARGIN = 1;

/** Maximum camera velocity magnitude (world units / frame at 60fps reference). */
export const MAX_VELOCITY = 1.45;

/**
 * Absolute depth (world units) at which the far depth-fade ramp begins.
 * Scaled up alongside INITIAL_CAMERA_Z (600) so the newest bucket — whose
 * nodes sit at absDepth ∈ (INITIAL_CAMERA_Z - CHUNK_SIZE, INITIAL_CAMERA_Z]
 * = (440, 600] — stays fully opaque on first load while the view starts
 * zoomed further out.
 */
export const DEPTH_FADE_START = 650;

/** Absolute depth (world units) at which planes are fully hidden by depth fade. */
export const DEPTH_FADE_END = 900;

/**
 * Exponential fog density for `THREE.FogExp2`.
 * Shader: fogFactor = 1 - exp(-(density * distance)²).
 *
 * Tuned so fog complements NodePlane depth-fade instead of double-hiding:
 * - INITIAL_CAMERA_Z=600 (newest bucket): fogFactor ≈ 0.10 — still readable
 * - DEPTH_FADE_START=650: fogFactor ≈ 0.12 — fade ramp has not started
 * - DEPTH_FADE_END=900: fogFactor ≈ 0.22 while opacity is already 0
 * Distant older buckets recede into the navy background.
 */
export const FOG_DENSITY = 0.00055;

/** Mouse-parallax drift amplitude base; multiplied by zoom factor each frame. */
export const DRIFT_AMOUNT = 8.0;

/** Lerp factor smoothing drift toward the mouse-driven target. */
export const DRIFT_LERP = 0.12;

/** Lerp factor smoothing drift while zooming (snappier to avoid lag). */
export const DRIFT_LERP_ZOOMING = 0.2;

/** Velocity magnitude (|velocity.z|) above which the camera is considered zooming. */
export const ZOOMING_VEL_THRESHOLD = 0.05;

/** Minimum of zoomFactor = clamp(basePos.z / ZOOM_FACTOR_DIVISOR, min, max). */
export const ZOOM_FACTOR_MIN = 0.3;

/** Maximum of zoomFactor = clamp(basePos.z / ZOOM_FACTOR_DIVISOR, min, max). */
export const ZOOM_FACTOR_MAX = 2.0;

/** Divisor for basePos.z → zoomFactor. */
export const ZOOM_FACTOR_DIVISOR = 50;

/** Oposity below which a plane is considered invisible (mesh.visible = false). */
export const INVIS_THRESHOLD = 0.01;

/**
 * Opacity multiplier for nodes that miss the active canvas search.
 * Matches keep their depth/grid fade; empty query leaves this unused.
 */
export const SEARCH_DIM = 0.18;

/**
 * Source-offline vanish duration (ms). Ease-out cubic on mesh opacity.
 * Band is 400–700ms; 550 sits in the middle and stays frame-rate stable
 * unlike the per-frame `OPACITY_LERP` used for camera/chunk fade-in.
 */
export const VANISH_DURATION_MS = 550;

/**
 * Mouse-drag pan factor: each pixel of pointer delta adds this much to
 * camera-right / camera-up velocity, then scaled by viewing distance so
 * panning stays proportional on-screen. Not scaled by camera Z (time).
 */
export const MOUSE_PAN_FACTOR = 0.05;

/**
 * Single-touch pan factor: each pixel of touch delta adds this much to
 * camera-right / camera-up velocity, then distance-scaled like MOUSE_PAN_FACTOR.
 */
export const TOUCH_PAN_FACTOR = 0.20;

/**
 * Wheel / pinch-zoom factor: each pixel of `deltaY` (or pinch distance
 * change) accumulates this much into `scrollAccum`, then z-scaled by
 * `basePos.z / ZOOM_FACTOR_DIVISOR`. Ported from the reference's `0.006`.
 */
export const ZOOM_FACTOR = 0.006;

/**
 * Per-frame decay applied to `scrollAccum` (wheel/pinch momentum).
 * 0.8 means 20 % of accumulated scroll is consumed each frame, creating
 * the smooth zoom-out coast in the reference implementation.
 */
export const SCROLL_DECAY = 0.8;

/**
 * How much the scroll-momentum multiplier grows per rapid wheel event.
 * Each wheel event within the momentum window multiplies the current
 * momentum by (1 + SCROLL_MOMENTUM_RAMP). 0.55 means the 2nd rapid
 * scroll tick is 1.55×, the 3rd is ~2.4×, etc.
 */
export const SCROLL_MOMENTUM_RAMP = 2.5;

/** Maximum scroll-momentum multiplier (prevents runaway acceleration). */
export const SCROLL_MOMENTUM_MAX = 50.0;

/**
 * Per-frame decay of the scroll-momentum multiplier toward 1.0 when not
 * scrolling. 0.65 means ~35 % decay per frame — momentum snaps back
 * hard after scrolling stops.
 */
export const SCROLL_MOMENTUM_DECAY = 0.65;

/**
 * Time window (ms) for detecting rapid successive wheel events. If two
 * wheel events arrive within this interval, the momentum multiplier ramps
 * up instead of resetting.
 */
export const SCROLL_MOMENTUM_WINDOW_MS = 200;

/** Per-frame camera translation when a movement key is held. */
export const KEYBOARD_SPEED = 0.12;

/** Lerp factor for smoothing camera position toward velocity target. */
export const VELOCITY_LERP = 0.08;

/** Per-frame decay applied to velocity when no input is active (inertia). */
export const VELOCITY_DECAY = 0.94;

/**
 * Initial camera Z (distance from the z=0 plane of the canvas).
 * 600 starts the view noticeably more zoomed-out than the reference 250.
 * DEPTH_FADE_START (650) is kept above the newest bucket's depth window
 * so those photos remain fully opaque and clearly visible on first load.
 */
export const INITIAL_CAMERA_Z = 600;

/**
 * Gap (in chunks) between consecutive time buckets along the depth axis.
 * Spacing buckets several chunks apart ensures each month/layer sits fully
 * outside the visible depth range of its neighbors, so the user must
 * deliberately zoom to travel between time periods instead of seeing every
 * bucket at once. 8 chunks (1280 world units) exceeds DEPTH_FADE_END (900),
 * so adjacent buckets fade fully out of view before the next comes into focus.
 */
export const TIME_BUCKET_SPACING = 8;

/** Minimum camera Z — prevents flying through the canvas. */
export const MIN_CAMERA_Z = 5;

/** Maximum camera Z — prevents zooming out to nothing. */
export const MAX_CAMERA_Z = 1000;

/** A precomputed cube of integer offsets with its Chebyshev distance. */
export interface ChunkOffset {
  /** X offset in chunks relative to the camera chunk. */
  readonly dx: number;
  /** Y offset in chunks relative to the camera chunk. */
  readonly dy: number;
  /** Z offset in chunks relative to the camera chunk. */
  readonly dz: number;
  /** Chebyshev distance (max(|dx|,|dy|,|dz|)) from the origin. */
  readonly dist: number;
}

/**
 * Precomputed list of `{ dx, dy, dz, dist }` offsets spanning the full cube
 * out to Chebyshev distance `RENDER_DISTANCE + CHUNK_FADE_MARGIN`. Sorted by
 * ascending distance so nearer chunks mount first. ~125 entries for the
 * default 3×3×3 + fade ring.
 */
export const CHUNK_OFFSETS: readonly ChunkOffset[] = (() => {
  const radius = RENDER_DISTANCE + CHUNK_FADE_MARGIN;
  const seen = new Set<string>();
  const offsets: ChunkOffset[] = [];
  const add = (dx: number, dy: number, dz: number) => {
    const key = `${dx},${dy},${dz}`;
    if (seen.has(key)) return;
    seen.add(key);
    offsets.push({
      dx,
      dy,
      dz,
      dist: Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)),
    });
  };
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dz = -radius; dz <= radius; dz++) {
        add(dx, dy, dz);
      }
    }
  }
  const zR = HALL_RENDER_DISTANCE_Z;
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dz = -zR; dz <= zR; dz++) {
        add(dx, dy, dz);
      }
    }
  }
  offsets.sort((a, b) => a.dist - b.dist);
  return offsets;
})();

/** Chebyshev chunk distance at/below which a photo node promotes to full-res. */
export const LOD_FULL_CHEBY = 1;
/** Absolute depth (world units) at/below which a photo node promotes to full-res. */
export const LOD_FULL_DEPTH = 240;
/** Extra Chebyshev distance beyond LOD_FULL_CHEBY where a node stays full-res before demoting (hysteresis band). */
export const LOD_HYSTERESIS = 1;
/** Absolute depth hysteresis band (world units) beyond LOD_FULL_DEPTH before demoting. */
export const LOD_FULL_DEPTH_HYSTERESIS = 60;
/** Maximum simultaneous full-res textures held in GPU memory (LRU eviction above this). */
export const LOD_FULL_MAX = 10;

/**
 * Returns the chunk-update throttle delay in milliseconds based on the
 * current camera velocity magnitude. Ported from the reference's
 * `getChunkUpdateThrottleMs`.
 *
 * - Fast zoom (>2 world units/frame) → 500ms (aggressive throttle).
 * - Zoom (>0.5) → 400ms.
 * - Idle (≤0.5) → 100ms.
 *
 * @param velocityMag - magnitude of the camera velocity vector.
 * @returns throttle delay in milliseconds.
 */
export function getChunkUpdateThrottleMs(velocityMag: number): number {
  if (velocityMag > 2) return 500;
  if (velocityMag > 0.5) return 400;
  return 100;
}