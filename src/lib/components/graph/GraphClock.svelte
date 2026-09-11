<script lang="ts">
  import { onMount } from 'svelte';
  import { fade } from 'svelte/transition';
  import { corridorClockRef } from './corridor-clock-ref';
  import {
    bucketIndexFromMs,
    fractionalIndexToCameraZ,
    viewInstantFromCameraZ,
    viewInstantFromWallZ,
    zForTime,
  } from './time-travel';

  let {
    ontoggle,
    open = false,
  }: {
    ontoggle?: () => void;
    open?: boolean;
  } = $props();

  const STICK_THROW = 56;
  const TAP_SLOP = 14;
  const DAY_PX = 10;
  const MONTH_PX = 16;

  let stickActive = $state(false);
  let stickX = $state(0);
  let stickY = $state(0);
  let stickAxis = $state<'day' | 'month'>('day');
  let hud = $state({ prev: '', now: '', next: '', dow: '', mon: '' });
  let originX = 0;
  let originY = 0;
  let travel = 0;
  let holding = false;
  let startDate: Date | null = null;
  let chosenDate: Date | null = null;
  let cursorKey = '';
  let lastTapAt = 0;
  let tapTimer: ReturnType<typeof setTimeout> | null = null;
  let dateTravel: { fromIdx: number; toIdx: number; t0: number; dur: number } | null = null;

  function dateFromNearestWall(z: number): Date | null {
    const wall = corridorClockRef.wallTimeline;
    if (!wall || wall.length === 0) return null;
    let best = wall[0];
    let bestDist = Math.abs(wall[0].z - z);
    for (const s of wall) {
      const dist = Math.abs(s.z - z);
      if (dist < bestDist) {
        best = s;
        bestDist = dist;
      }
    }
    const window = 160;
    const near = wall.filter((s) => Math.abs(s.z - z) <= window);
    const ts = (near.length > 0 ? near : [best]).map((s) => s.t).sort((a, b) => a - b);
    return new Date(ts[Math.floor(ts.length / 2)]);
  }

  function viewDate(): Date {
    if (dateTravel) {
      const u = Math.min(1, (performance.now() - dateTravel.t0) / dateTravel.dur);
      const eased = u * u * (3 - 2 * u);
      const days = contentDays();
      const i = Math.round(dateTravel.fromIdx + (dateTravel.toIdx - dateTravel.fromIdx) * eased);
      const clamped = Math.max(0, Math.min(days.length - 1, i));
      const d = days[clamped];
      if (u >= 1) dateTravel = null;
      if (d) return d;
    }
    const nowMs = Date.now();
    const z = corridorClockRef.scene?.basePosZ ?? Number.POSITIVE_INFINITY;
    if (corridorClockRef.focusMs != null) {
      const flying = corridorClockRef.scene?.isFlying === true;
      const near =
        corridorClockRef.focusZ != null && Math.abs(z - corridorClockRef.focusZ) < 220;
      if (flying || near) return new Date(corridorClockRef.focusMs);
      corridorClockRef.focusMs = null;
      corridorClockRef.focusZ = null;
    }
    const nearest = Number.isFinite(z) ? dateFromNearestWall(z) : null;
    if (nearest) return nearest;
    const index = corridorClockRef.timeIndex;
    const wall = corridorClockRef.wallTimeline;
    const instant =
      wall && wall.length > 0
        ? (viewInstantFromWallZ(z, wall, nowMs, null) ??
          viewInstantFromCameraZ(z, index?.indexToTime ?? [], index?.indexToLocation ?? [], nowMs, null))
        : viewInstantFromCameraZ(
            z,
            index?.indexToTime ?? [],
            index?.indexToLocation ?? [],
            nowMs,
            null
          );
    return new Date(instant.ms);
  }

  function clampDate(d: Date): Date {
    const wall = corridorClockRef.wallTimeline;
    const index = corridorClockRef.timeIndex;
    let minT = -Infinity;
    let maxT = Date.now();
    if (wall && wall.length > 0) {
      minT = wall[0].t;
      maxT = wall[wall.length - 1].t;
    } else if (index && index.indexToTime.length > 0) {
      minT = index.indexToTime[0];
      maxT = index.indexToTime[index.indexToTime.length - 1];
    }
    return new Date(Math.max(minT, Math.min(maxT, d.getTime())));
  }

  function dateKey(d: Date): string {
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }

  function monthKey(d: Date): string {
    return `${d.getFullYear()}-${d.getMonth()}`;
  }

  function contentTimes(): number[] {
    const wall = corridorClockRef.wallTimeline;
    const index = corridorClockRef.timeIndex;
    if (wall && wall.length > 0) return wall.map((s) => s.t);
    if (index && index.indexToTime.length > 0) return [...index.indexToTime];
    return [];
  }

  function contentDays(): Date[] {
    const buckets = new Map<string, number[]>();
    for (const t of contentTimes()) {
      const d = new Date(t);
      const key = dateKey(d);
      const arr = buckets.get(key);
      if (arr) arr.push(t);
      else buckets.set(key, [t]);
    }
    return [...buckets.values()]
      .map((ts) => {
        ts.sort((a, b) => a - b);
        return new Date(ts[Math.floor(ts.length / 2)]);
      })
      .sort((a, b) => a.getTime() - b.getTime());
  }

  function contentMonths(): Date[] {
    const buckets = new Map<string, number[]>();
    for (const t of contentTimes()) {
      const d = new Date(t);
      const key = monthKey(d);
      const arr = buckets.get(key);
      if (arr) arr.push(t);
      else buckets.set(key, [t]);
    }
    return [...buckets.values()]
      .map((ts) => {
        ts.sort((a, b) => a - b);
        return new Date(ts[Math.floor(ts.length / 2)]);
      })
      .sort((a, b) => a.getTime() - b.getTime());
  }

  function nearestIndex(list: Date[], target: Date): number {
    if (list.length === 0) return 0;
    const t = target.getTime();
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < list.length; i++) {
      const dist = Math.abs(list[i].getTime() - t);
      if (dist < bestDist) {
        best = i;
        bestDist = dist;
      }
    }
    return best;
  }

  function paintHud(d: Date): void {
    const p = partsOf(d);
    if (stickAxis === 'month') {
      const months = contentMonths();
      const i = nearestIndex(months, d);
      const prev = months[i - 1];
      const next = months[i + 1];
      hud = {
        prev: prev ? prev.toLocaleDateString(undefined, { month: 'short' }).toUpperCase() : '',
        now: d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }).toUpperCase(),
        next: next ? next.toLocaleDateString(undefined, { month: 'short' }).toUpperCase() : '',
        dow: '',
        mon: ''
      };
      return;
    }
    const days = contentDays();
    const i = nearestIndex(days, d);
    const prev = days[i - 1];
    const next = days[i + 1];
    hud = {
      prev: prev ? String(prev.getDate()) : '',
      now: p.day,
      next: next ? String(next.getDate()) : '',
      dow: p.dow,
      mon: `${p.mon} ${p.year}`
    };
  }

  function chooseDate(d: Date): void {
    const next = clampDate(d);
    const key = dateKey(next);
    chosenDate = next;
    if (key === cursorKey) return;
    cursorKey = key;
    corridorClockRef.focusMs = next.getTime();
    paintHud(next);
  }

  function zForChosen(d: Date): number | null {
    const wall = corridorClockRef.wallTimeline;
    const y = d.getFullYear();
    const m = d.getMonth();
    const day = d.getDate();
    if (wall && wall.length > 0) {
      const hits = wall.filter((s) => {
        const x = new Date(s.t);
        if (stickAxis === 'month') return x.getFullYear() === y && x.getMonth() === m;
        return x.getFullYear() === y && x.getMonth() === m && x.getDate() === day;
      });
      if (hits.length > 0) {
        hits.sort((a, b) => a.t - b.t);
        return hits[Math.floor(hits.length / 2)].z;
      }
      return zForTime(d.getTime(), wall);
    }
    const index = corridorClockRef.timeIndex;
    if (!index || index.indexToBucket.length === 0) return null;
    const bucket = bucketIndexFromMs(d.getTime(), index.indexToBucket, Date.now());
    return fractionalIndexToCameraZ(bucket);
  }

  function flyToDate(d: Date): void {
    const scene = corridorClockRef.scene;
    const z = zForChosen(d);
    if (!scene || z == null) return;
    const days = contentDays();
    const here = dateFromNearestWall(scene.basePosZ) ?? d;
    const fromIdx = days.length > 0 ? nearestIndex(days, here) : 0;
    const toIdx = days.length > 0 ? nearestIndex(days, d) : 0;
    dateTravel = { fromIdx, toIdx, t0: performance.now(), dur: 700 };
    corridorClockRef.focusMs = d.getTime();
    corridorClockRef.focusZ = z;
    scene.flyTo(z, 700);
  }

  function onStickDown(e: PointerEvent): void {
    e.preventDefault();
    e.stopPropagation();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {}
    originX = e.clientX;
    originY = e.clientY;
    travel = 0;
    holding = true;
    stickActive = false;
    stickX = 0;
    stickY = 0;
    stickAxis = 'day';
    startDate = viewDate();
    {
      const days = contentDays();
      if (days.length > 0) startDate = days[nearestIndex(days, startDate)];
    }
    chosenDate = startDate;
    cursorKey = dateKey(startDate);
    paintHud(startDate);
    corridorClockRef.focusMs = startDate.getTime();
  }

  function onStickMove(e: PointerEvent): void {
    if (!holding || !startDate) return;
    const dx = e.clientX - originX;
    const dy = e.clientY - originY;
    travel = Math.hypot(dx, dy);
    if (travel < TAP_SLOP) return;
    if (!stickActive) {
      stickActive = true;
      stickAxis = Math.abs(dx) > Math.abs(dy) * 1.15 ? 'month' : 'day';
      if (startDate) paintHud(startDate);
      if (open) ontoggle?.();
    }
    stickX = Math.max(-1, Math.min(1, dx / STICK_THROW));
    stickY = Math.max(-1, Math.min(1, dy / STICK_THROW));
    if (stickAxis === 'month') {
      const months = contentMonths();
      if (months.length === 0) return;
      const i = nearestIndex(months, startDate);
      const j = Math.max(0, Math.min(months.length - 1, i + Math.round(dx / MONTH_PX)));
      chooseDate(months[j]);
    } else {
      const days = contentDays();
      if (days.length === 0) return;
      const i = nearestIndex(days, startDate);
      const j = Math.max(0, Math.min(days.length - 1, i + Math.round(dy / DAY_PX)));
      chooseDate(days[j]);
    }
  }

  function onStickUp(e: PointerEvent): void {
    if (!holding) return;
    holding = false;
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    const wasStick = stickActive;
    const target = chosenDate ? new Date(chosenDate.getTime()) : null;
    stickActive = false;
    stickX = 0;
    stickY = 0;
    startDate = null;
    chosenDate = null;
    if (wasStick && target) {
      flyToDate(target);
      return;
    }
    if (wasStick || travel >= TAP_SLOP) return;
    const now = performance.now();
    if (now - lastTapAt < 340) {
      if (tapTimer) clearTimeout(tapTimer);
      tapTimer = null;
      lastTapAt = 0;
      const days = contentDays();
      flyToDate(days.length > 0 ? days[days.length - 1] : new Date());
      return;
    }
    lastTapAt = now;
    tapTimer = setTimeout(() => {
      tapTimer = null;
      ontoggle?.();
    }, 340);
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
      const at = viewDate();
      const live = Math.abs(at.getTime() - nowMs) < 5 * 60 * 1000;
      const next = partsOf(at);
      const traveling = dateTravel != null;
      dock.classList.toggle('is-live', live);
      dock.classList.toggle('is-rewinding', !live);
      dock.classList.toggle('is-traveling', traveling);

      if (next.key !== lastKey) {
        const fill = (el: HTMLElement, p: typeof next) => {
          const dow = el.querySelector('.cal-dow');
          const day = el.querySelector('.cal-day');
          const mon = el.querySelector('.cal-mon');
          if (dow) dow.textContent = p.dow;
          if (day) day.textContent = p.day;
          if (mon) mon.textContent = `${p.mon}  ·  ${p.year}`;
        };
        if (lastKey && !reduceMotion && !flipping && !traveling) {
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
          flipping = false;
          dock.classList.remove('is-flipping');
        }
        lastKey = next.key;
      }

      if (nowMs - lastAriaAt > 1000) {
        lastAriaAt = nowMs;
        dock.setAttribute(
          'aria-label',
          `${live ? 'Live' : 'Past'}. ${next.dow} ${next.mon} ${next.day} ${next.year}. Time joystick.`
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

{#if stickActive}
  <div class="stick-hud" class:is-month={stickAxis === 'month'} aria-live="polite">
    {#if stickAxis === 'month'}
      <div class="ribbon ribbon-x">
        <span class="ghost">{hud.prev}</span>
        {#key cursorKey}
          <span class="focus-month" in:fade={{ duration: 120 }}>{hud.now}</span>
        {/key}
        <span class="ghost">{hud.next}</span>
      </div>
    {:else}
      <div class="ribbon ribbon-y">
        <span class="ghost">{hud.prev}</span>
        {#key cursorKey}
          <div class="focus" in:fade={{ duration: 120 }}>
            <span class="dow">{hud.dow}</span>
            <span class="day">{hud.now}</span>
            <span class="mon">{hud.mon}</span>
          </div>
        {/key}
        <span class="ghost">{hud.next}</span>
      </div>
    {/if}
  </div>
{/if}
<div
  class="flip-cal-wrap"
  class:is-stick={stickActive}
  style="--stick-x: {stickX}; --stick-y: {stickY}"
>
  <button
    type="button"
    class="flip-cal-dock is-live"
    class:open
    class:is-stick={stickActive}
    data-sidebar-no-gesture
    data-testid="timeline-bar"
    aria-label="Time joystick. Slide up and down for days, left and right for months. Tap for date list."
    aria-expanded={open}
    onpointerdown={onStickDown}
    onpointermove={onStickMove}
    onpointerup={onStickUp}
    onpointercancel={onStickUp}
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
  </button>
</div>

<style>
  .flip-cal-wrap {
    position: absolute;
    right: calc(16px + 44px + 12px + env(safe-area-inset-right, 0px));
    bottom: calc(0.95rem + env(safe-area-inset-bottom, 0px));
    left: auto;
    z-index: 40;
    display: flex;
    flex-direction: column;
    align-items: center;
    pointer-events: none;
    transition: opacity 1s cubic-bezier(0.22, 1, 0.36, 1);
  }
  .flip-cal-dock {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: grab;
    pointer-events: auto;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
  }
  .flip-cal-dock.is-stick {
    cursor: grabbing;
  }
  .stick-hud {
    position: fixed;
    left: 50%;
    top: 40%;
    transform: translate(-50%, -50%);
    z-index: 55;
    pointer-events: none;
    text-align: center;
  }
  .ribbon {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 1.1rem;
  }
  .ribbon-y {
    flex-direction: column;
    gap: 0.15rem;
  }
  .ribbon-x {
    gap: 1.25rem;
  }
  .ghost {
    font-family: var(--font-display, 'Fraunces', Georgia, serif);
    font-size: 28px;
    font-weight: 600;
    line-height: 1;
    color: oklch(82% 0.14 210 / 28%);
    letter-spacing: 0.02em;
  }
  .focus {
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .focus .dow {
    font-family: var(--font-mono, 'JetBrains Mono', ui-monospace, monospace);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.22em;
    color: oklch(82% 0.14 210 / 80%);
  }
  .focus .day {
    font-family: var(--font-display, 'Fraunces', Georgia, serif);
    font-size: 84px;
    font-weight: 600;
    line-height: 0.92;
    color: oklch(96% 0.02 210);
    text-shadow: 0 0 40px oklch(82% 0.14 210 / 35%);
  }
  .focus .mon {
    margin-top: 2px;
    font-family: var(--font-mono, 'JetBrains Mono', ui-monospace, monospace);
    font-size: 12px;
    letter-spacing: 0.16em;
    color: oklch(78% 0.03 210 / 70%);
  }
  .focus-month {
    font-family: var(--font-display, 'Fraunces', Georgia, serif);
    font-size: 34px;
    font-weight: 600;
    color: oklch(96% 0.02 210);
    text-shadow: 0 0 40px oklch(82% 0.14 210 / 35%);
    letter-spacing: 0.04em;
  }
  @keyframes paper-flip-fwd {
    0% { transform: rotateX(0deg) rotateY(0deg); }
    16% { transform: rotateX(-18deg) rotateY(-26deg) translate3d(-4%, 2%, 14px); }
    48% { transform: rotateX(-98deg) rotateY(-18deg) translate3d(-2%, 4%, 18px); }
    100% { transform: rotateX(-180deg) rotateY(0deg); }
  }
  @keyframes paper-flip-back {
    0% { transform: rotateX(0deg) rotateY(0deg); }
    16% { transform: rotateX(-18deg) rotateY(26deg) translate3d(4%, 2%, 14px); }
    48% { transform: rotateX(-98deg) rotateY(18deg) translate3d(2%, 4%, 18px); }
    100% { transform: rotateX(-180deg) rotateY(0deg); }
  }
  .flip-cal-dock:focus-visible {
    outline: 2px solid oklch(82% 0.14 210 / 70%);
    outline-offset: 4px;
    border-radius: 10px;
  }

  .cal-book {
    position: relative;
    width: 118px;
    height: 136px;
    perspective: 700px;
    transform:
      perspective(640px)
      rotateX(calc(8deg + var(--stick-y, 0) * -14deg))
      rotateY(calc(var(--stick-x, 0) * 14deg))
      translate3d(calc(var(--stick-x, 0) * 14px), calc(var(--stick-y, 0) * 16px), 0);
    transform-origin: 50% 100%;
    transition: transform 0.32s cubic-bezier(0.22, 1, 0.36, 1);
    will-change: transform;
    filter: drop-shadow(0 20px 16px rgba(0, 0, 0, 0.55));
  }
  .flip-cal-dock.is-stick .cal-book {
    transition: none;
  }
  .cal-sheet {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    padding: 16px 12px 14px;
    border-radius: 2px;
    color: #2a1c12;
    background:
      linear-gradient(145deg, #f3e2b0 0%, #d4b45c 16%, #8d6b2c 48%, #c4a056 78%, #5c4518 100%);
    box-shadow:
      inset 0 1px 0 rgba(255, 248, 220, 0.45),
      inset 0 -1px 0 rgba(40, 24, 12, 0.45),
      0 14px 28px rgba(0, 0, 0, 0.48);
  }
  .cal-sheet::before {
    content: '';
    position: absolute;
    inset: 8px;
    border-radius: 1px;
    background:
      linear-gradient(180deg, rgba(255, 248, 230, 0.35), transparent 28%),
      #f4ead8;
    box-shadow: inset 0 0 0 1px #c4a056;
    pointer-events: none;
  }
  .cal-under {
    position: absolute;
    inset: 0;
  }
  .cal-leaf {
    position: absolute;
    inset: 0;
    transform-origin: 100% 0%;
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
    background: linear-gradient(145deg, #c4a056, #8d6b2c);
  }
  .cal-face-back::before {
    background: #e8dcc4;
  }

  .cal-dow,
  .cal-day,
  .cal-mon {
    position: relative;
    z-index: 1;
  }
  .cal-dow {
    font-family: var(--font-display, 'Fraunces', Georgia, serif);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.22em;
    color: #8d6b2c;
  }
  .cal-day {
    font-family: var(--font-display, 'Fraunces', Georgia, serif);
    font-size: 46px;
    font-weight: 600;
    line-height: 1;
    color: #2a1c12;
  }
  .cal-mon {
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px solid rgba(42, 28, 18, 0.18);
    font-family: var(--font-mono, 'JetBrains Mono', ui-monospace, monospace);
    font-size: 9px;
    font-weight: 500;
    letter-spacing: 0.16em;
    color: #8d6b2c;
  }
  .flip-cal-dock.is-flipping .cal-leaf {
    animation: paper-flip-fwd 0.42s cubic-bezier(0.22, 0.08, 0.25, 1) forwards;
  }

  @media (max-width: 767px) {
    .flip-cal-wrap {
      left: 50%;
      right: auto;
      transform: translateX(-50%);
      bottom: calc(3.15rem + env(safe-area-inset-bottom, 0px));
    }
    .flip-cal-dock::before {
      content: '';
      position: absolute;
      left: 12%;
      right: 12%;
      bottom: -10px;
      height: 14px;
      border-radius: 50%;
      background: oklch(0% 0 0 / 45%);
      filter: blur(8px);
      pointer-events: none;
      z-index: -1;
    }
  }

  @media (max-width: 640px) {
    .cal-book {
      width: 102px;
      height: 116px;
    }
    .cal-day {
      font-size: 38px;
    }
  }
</style>
