/**
 * Canvas config store — ported from Knowledge Graph `config.svelte.ts`.
 *
 * The KG source stored a system prompt + LLM generation config used by the
 * KG chat panel. OWUI has its own chat/prompt system, so those fields are
 * out of scope here. Only the canvas-specific config remains:
 *  - `timeTravelSensitivity` — mouse-wheel zoom acceleration constant used
 *    by the renderer's time-travel interaction. KG exposed it via a
 *    SettingsDrawer; OWUI uses the default constant (no settings UI).
 *
 * Svelte 5 runes module (`.svelte.ts`) — uses `$state`.
 */

/** Default mouse-wheel zoom acceleration for the time-travel interaction.
 *  Higher = fewer wheel ticks per time-bucket jump. */
const DEFAULT_TIME_TRAVEL_SENSITIVITY = 0.002;

class CanvasConfigStore {
  /** Mouse-wheel zoom sensitivity for time travel (default constant, no UI). */
  timeTravelSensitivity = $state(DEFAULT_TIME_TRAVEL_SENSITIVITY);

  /** Reset to defaults. */
  reset(): void {
    this.timeTravelSensitivity = DEFAULT_TIME_TRAVEL_SENSITIVITY;
  }
}

export const canvasConfig = new CanvasConfigStore();