<script lang="ts">
  import { onMount } from 'svelte';
  import { corridorClockRef } from './corridor-clock-ref';
  import {
    formatLocationLabel,
    timezoneFallbackLabel,
    viewInstantFromCameraZ,
    viewInstantFromWallZ,
  } from './time-travel';

  let {
    ontoggle,
  }: {
    ontoggle?: () => void;
  } = $props();

  let liveLocation = $state<string | null>(null);

  async function reverseGeocode(lat: number, lon: number): Promise<string | null> {
    try {
      const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = (await res.json()) as {
        city?: string;
        locality?: string;
        principalSubdivisionCode?: string;
        principalSubdivision?: string;
      };
      const city = data.city || data.locality;
      const regionCode = data.principalSubdivisionCode?.replace(/^[A-Z]+-/, '') || data.principalSubdivision;
      if (city && regionCode) return `${city}, ${regionCode}`;
      return city || regionCode || null;
    } catch {
      return null;
    }
  }

  function requestLocation(): void {
    liveLocation = timezoneFallbackLabel() || null;
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const label = await reverseGeocode(pos.coords.latitude, pos.coords.longitude);
        if (label) liveLocation = label;
      },
      () => {
        if (!liveLocation) liveLocation = timezoneFallbackLabel() || null;
      },
      { enableHighAccuracy: false, maximumAge: 300000, timeout: 8000 }
    );
  }

  function partsOf(d: Date) {
    return {
      key: `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`,
      dow: d.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase(),
      day: String(d.getDate()),
      mon: d.toLocaleDateString(undefined, { month: 'short' }).toUpperCase(),
      year: String(d.getFullYear()),
    };
  }

  onMount(() => {
    requestLocation();
    let raf = 0;
    let lastKey = '';
    let lastAriaAt = 0;
    let flipping = false;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const tick = () => {
      const dock = document.querySelector<HTMLButtonElement>('.flip-cal-dock');
      const front = dock?.querySelector<HTMLElement>('.cal-face-front');
      const under = dock?.querySelector<HTMLElement>('.cal-under');
      if (!dock || !front || !under) return;

      const nowMs = Date.now();
      const index = corridorClockRef.timeIndex;
      const z = corridorClockRef.scene?.basePosZ ?? Number.POSITIVE_INFINITY;
      const wall = corridorClockRef.wallTimeline;
      const instant =
        wall && wall.length > 0
          ? (viewInstantFromWallZ(z, wall, nowMs, liveLocation) ??
            viewInstantFromCameraZ(z, index?.indexToTime ?? [], index?.indexToLocation ?? [], nowMs, liveLocation))
          : viewInstantFromCameraZ(
              z,
              index?.indexToTime ?? [],
              index?.indexToLocation ?? [],
              nowMs,
              liveLocation
            );
      const focusMs = corridorClockRef.focusMs;
      let targetMs = instant.ms;
      let live = instant.live;
      if (focusMs != null) {
        targetMs = focusMs;
        live = Math.abs(focusMs - nowMs) < 5 * 60 * 1000;
      }

      const next = partsOf(new Date(targetMs));
      const loc = formatLocationLabel(instant.location);
      dock.classList.toggle('is-live', live);
      dock.classList.toggle('is-rewinding', !live);
      const locEl = dock.querySelector('.cal-loc');
      if (locEl) locEl.textContent = loc;

      if (next.key !== lastKey) {
        const fill = (el: HTMLElement, p: typeof next) => {
          const dow = el.querySelector('.cal-dow');
          const day = el.querySelector('.cal-day');
          const mon = el.querySelector('.cal-mon');
          if (dow) dow.textContent = p.dow;
          if (day) day.textContent = p.day;
          if (mon) mon.textContent = `${p.mon} ${p.year}`;
        };
        if (lastKey && !reduceMotion && !flipping) {
          flipping = true;
          fill(under, next);
          dock.classList.remove('is-flipping');
          void dock.offsetWidth;
          dock.classList.add('is-flipping');
          window.setTimeout(() => {
            fill(front, next);
            dock.classList.remove('is-flipping');
            flipping = false;
          }, 560);
        } else {
          fill(front, next);
          fill(under, next);
        }
        lastKey = next.key;
      }

      if (nowMs - lastAriaAt > 1000) {
        lastAriaAt = nowMs;
        const where = loc ? `, ${loc}` : '';
        dock.setAttribute(
          'aria-label',
          `${live ? 'Live' : 'Past'}. ${next.dow} ${next.mon} ${next.day} ${next.year}${where}. Open date picker.`
        );
      }
    };

    const loop = () => {
      tick();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const interval = window.setInterval(tick, 200);
    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(interval);
    };
  });
</script>

<button
  type="button"
  class="flip-cal-dock is-live"
  data-testid="graph-flip-cal"
  aria-label="Date calendar"
  onclick={() => ontoggle?.()}
>
  <span class="cal-book">
    <span class="cal-under cal-sheet">
      <span class="cal-dow">—</span>
      <span class="cal-day">—</span>
      <span class="cal-mon">—</span>
    </span>
    <span class="cal-leaf">
      <span class="cal-face cal-face-front cal-sheet">
        <span class="cal-dow">—</span>
        <span class="cal-day">—</span>
        <span class="cal-mon">—</span>
      </span>
      <span class="cal-face cal-face-back cal-sheet"></span>
    </span>
  </span>
  <span class="cal-loc"></span>
</button>

<style>
  .flip-cal-dock {
    position: absolute;
    right: calc(16px + env(safe-area-inset-right, 0px));
    bottom: calc(4.65rem + env(safe-area-inset-bottom, 0px));
    left: auto;
    transform: none;
    z-index: 40;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: pointer;
    pointer-events: auto;
  }
  .flip-cal-dock:focus-visible {
    outline: 2px solid oklch(82% 0.14 210 / 70%);
    outline-offset: 4px;
    border-radius: 10px;
  }

  .cal-book {
    position: relative;
    width: 76px;
    height: 84px;
    perspective: 700px;
  }
  .cal-sheet {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    padding: 8px 6px 7px;
    border-radius: 12px;
    background: oklch(10% 0.02 255 / 88%);
    border: 1px solid oklch(82% 0.14 210 / 28%);
    box-shadow:
      0 8px 22px oklch(0% 0 0 / 45%),
      0 0 0 1px oklch(50% 0.03 255 / 10%);
    backdrop-filter: blur(24px) saturate(1.5);
    -webkit-backdrop-filter: blur(24px) saturate(1.5);
  }
  .cal-under {
    position: absolute;
    inset: 0;
  }
  .cal-leaf {
    position: absolute;
    inset: 0;
    transform-origin: 50% 0%;
    transform-style: preserve-3d;
  }
  .cal-face {
    position: absolute;
    inset: 0;
    backface-visibility: hidden;
    -webkit-backface-visibility: hidden;
  }
  .cal-face-back {
    transform: rotateX(180deg);
    background: oklch(8% 0.02 255 / 94%);
  }

  .cal-dow {
    font-family: var(--font-mono, 'JetBrains Mono', ui-monospace, monospace);
    font-size: 8px;
    font-weight: 600;
    letter-spacing: 0.18em;
    color: oklch(82% 0.14 210);
  }
  .cal-day {
    font-family: var(--font-display, 'Fraunces', Georgia, serif);
    font-size: 32px;
    font-weight: 600;
    line-height: 1;
    color: oklch(94% 0.02 210);
  }
  .cal-mon {
    margin-top: 2px;
    font-family: var(--font-mono, 'JetBrains Mono', ui-monospace, monospace);
    font-size: 8px;
    font-weight: 500;
    letter-spacing: 0.12em;
    color: oklch(78% 0.03 210 / 80%);
  }
  .cal-loc {
    font-family: var(--font-body, 'Inter', system-ui, sans-serif);
    font-size: 10px;
    color: oklch(72% 0.03 210 / 75%);
    max-width: 9rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cal-loc:empty {
    display: none;
  }

  .flip-cal-dock.is-flipping .cal-leaf {
    animation: cal-page-flip 0.55s cubic-bezier(0.4, 0.05, 0.2, 1) forwards;
  }
  @keyframes cal-page-flip {
    0% { transform: rotateX(0deg); }
    100% { transform: rotateX(-180deg); }
  }

  @media (max-width: 640px) {
    .cal-book {
      width: 66px;
      height: 74px;
    }
    .cal-day {
      font-size: 28px;
    }
  }
</style>
