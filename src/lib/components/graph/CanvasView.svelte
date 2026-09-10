<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { untrack } from 'svelte';
  import type { KGNode } from './constants';
  import { graphStore } from './stores/graph.svelte';
  import { searchHighlight } from './renderer/search-highlight-flag';
  import { graphSyncClient } from './services/sync-client.svelte';
  import { textureCache } from './services/TextureCache';
  import { SceneManager } from './renderer/SceneManager';
  import { TIME_BUCKET_SPACING, CHUNK_SIZE, INITIAL_CAMERA_Z } from './renderer/constants';
  import { buildCanvasLayout, buildTimeIndex, wallTimeSamplesFromCanvas } from './renderer/Layout';
  import type { TimeIndex } from './renderer/Layout';
  import { usePan, type PanCustomEvent, useComposedGesture, pinchComposition, type PinchCustomEvent, type GestureCallback, useSwipe, type SwipeCustomEvent } from 'svelte-gestures';
  import NodeOverlay from './NodeOverlay.svelte';
  import ConversationCloud from './ConversationCloud.svelte';
  import ProcessingOverlay from './ProcessingOverlay.svelte';
  import ProcessingDock from './ProcessingDock.svelte';
  import GraphClock from './GraphClock.svelte';
  import { corridorClockRef } from './corridor-clock-ref';
  import {
    bucketIndexFromMs,
    collapseWallSamples,
    formatHudDate,
    fractionalIndexToCameraZ,
    nodeTimeMs,
    viewInstantFromCameraZ,
    viewInstantFromWallZ,
    zForTime,
  } from './time-travel';
  import type { CanvasNode } from './renderer/types';
  import { dateFromProperties, loadPhotoExif, peekExif, plaqueFromExif, type PlaqueInfo } from './exif';
  import { getAssetFileUrl } from '$lib/apis/graph';

  /** Default pinch-zoom sensitivity. The KG config store exposed this via a
   *  settings drawer; OWUI has no such UI yet so we use a fixed constant. */
  const DEFAULT_PINCH_SENSITIVITY = 2.6;

  let loadError = $state<string | null>(null);
  let loaded = $state(false);

  let {
    onqueryAbout = (_node: KGNode) => {},
    onselectconversation = (_id: string) => {},
    dateLabel = $bindable<string | null>(null),
    timelineOpen = $bindable(false),
  }: {
    onqueryAbout?: (node: KGNode) => void;
    onselectconversation?: (id: string) => void;
    dateLabel?: string | null;
    timelineOpen?: boolean;
  } = $props();

  let containerEl: HTMLDivElement | undefined = $state();
  let sceneManager: SceneManager | undefined = $state();
  let mounted = false;
  let fontsLoaded = $state(false);
  let firstLayoutApplied = false;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let lastAppliedAt = 0;

  let selectedNodeId = $state<string | null>(null);
  let selectedCanvasNode = $state<CanvasNode | null>(null);
  let overlayOrigin = $state<{ left: number; top: number; width: number; height: number } | null>(null);
  /** First library-asset click flies to the wall; second opens NodeOverlay. */
  let galleryFocus = $state(false);
  let selectedKgNode = $derived<KGNode | null>(
    selectedNodeId ? graphStore.nodes.find((n) => n.id === selectedNodeId) ?? null : null,
  );

  let hoveredNodeId = $state<string | null>(null);
  let tooltipX = $state(0);
  let tooltipY = $state(0);
  let playingVideoId = $state<string | null>(null);
  let videoHud = $state<{
    id: string;
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  let videoHudPinned = $state(false);
  let hoveredKind = $derived(hoveredNodeId ? sceneManager?.getCanvasNode(hoveredNodeId)?.kind ?? null : null);
  let hoverTooltip = $derived(
    hoveredKind === 'conversation' ? 'Click to view convo'
      : hoveredKind === 'audio' ? 'Click to play audio'
      : hoveredKind === 'document' || hoveredKind === 'pdf' ? 'Click to view document'
      : hoveredKind && hoveredKind !== 'photo' && hoveredKind !== 'video' ? 'Click to view details'
      : ''
  );
  let hoverPlaque = $state<PlaqueInfo | null>(null);
  let photoPlaqueRect = $state<{ left: number; top: number; width: number; height: number } | null>(null);
  let lightbox = $state<{
    url: string;
    kind: 'photo' | 'video';
    alt: string;
    origin: { left: number; top: number; width: number; height: number } | null;
    leaving: boolean;
  } | null>(null);
  let lightboxMediaEl: HTMLElement | undefined = $state();
  let lightboxLeaveTimer: ReturnType<typeof setTimeout> | null = null;

  let plaquePos = $derived.by(() => {
    const rect = photoPlaqueRect;
    if (!rect) return null;
    const gap = 16;
    const w = 240;
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
    const right = rect.left + rect.width;
    const spaceRight = vw - right;
    const spaceLeft = rect.left;
    let left = spaceRight >= Math.max(spaceLeft, 96) ? right + gap : rect.left - w - gap;
    left = Math.max(12, Math.min(left, vw - w - 12));
    if (left < right && left + w > rect.left) {
      left = spaceRight >= spaceLeft ? Math.min(right + gap, vw - w - 12) : Math.max(12, rect.left - w - gap);
    }
    let top = rect.top + Math.max(24, rect.height * 0.55);
    top = Math.max(12, Math.min(top, vh - 168));
    return { left, top };
  });

  $effect(() => {
    const id = hoveredNodeId;
    const kind = hoveredKind;
    if (!id || (kind !== 'photo' && kind !== 'video')) {
      hoverPlaque = null;
      photoPlaqueRect = null;
      return;
    }
    const kg = graphStore.nodes.find((n) => n.id === id);
    const fallback = dateFromProperties(kg?.properties);
    const apply = (rows: ReturnType<typeof peekExif>) => {
      hoverPlaque = plaqueFromExif(rows ?? [], fallback);
    };
    const cached = peekExif(id);
    if (cached) {
      apply(cached);
    } else {
      hoverPlaque = plaqueFromExif([], fallback);
      loadPhotoExif(id, kg?.properties).then((rows) => {
        if (hoveredNodeId === id) apply(rows);
      });
    }
  });

  $effect(() => {
    const box = lightbox;
    const el = lightboxMediaEl;
    if (!box || box.leaving || !el) return;
    const reduced = typeof window !== 'undefined'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || !box.origin) return;
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => morphLightbox(false));
    });
    return () => cancelAnimationFrame(raf);
  });

  let timeIndex = $state<TimeIndex | null>(null);

  let currentBucketIdx = $state(-1);
  let doubleTapPhase = $state(0);
  let doubleTapReturnZ = $state(0);
  let doubleTapOriginIdx = -1;
  let timelineCloseTimer: ReturnType<typeof setTimeout> | null = null;
  let timelineScrubbing = $state(false);

  let timelineEntries = $derived.by(() => {
    if (!timeIndex || timeIndex.indexToLabel.length === 0) return [];
    // timeIndex is oldest→newest; keep natural order so scrolling up
    // (negative deltaY) moves back in time, scrolling down goes forward.
    const labels = timeIndex.indexToLabel;
    return labels.map((label, idx) => ({ idx, label }));
  });

  function clearSelection(): void {
    selectedNodeId = null;
    selectedCanvasNode = null;
    overlayOrigin = null;
  }

  function syncVideoHud(id: string | null): void {
    const sm = sceneManager;
    if (!id || !sm) {
      if (!videoHudPinned && !playingVideoId) videoHud = null;
      return;
    }
    const rect = sm.getPlaneScreenRect(id);
    if (!rect || rect.width < 32 || rect.height < 32) {
      if (!playingVideoId && !videoHudPinned) videoHud = null;
      return;
    }
    if (!playingVideoId && id !== playingVideoId && rect.width < 160 && !videoHudPinned) {
      videoHud = null;
      return;
    }
    videoHud = { id, ...rect };
  }

  function setClockFocus(id: string | null): void {
    if (!id) {
      corridorClockRef.focusMs = null;
      return;
    }
    const kg = graphStore.nodes.find((n) => n.id === id);
    corridorClockRef.focusMs = nodeTimeMs(kg?.properties ?? null);
  }

  function focusVideoOnWall(id: string): void {
    const sm = sceneManager;
    if (!sm) return;
    sm.flyToNode(id);
    galleryFocus = true;
    lastUserNavAt = Date.now();
    setClockFocus(id);
    syncVideoHud(id);
    const started = Date.now();
    const tick = () => {
      syncVideoHud(id);
      if (Date.now() - started < 1700) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function toggleWallPlayback(id: string): void {
    const sm = sceneManager;
    if (!sm) return;
    sm.toggleInlineVideo(id, getAssetFileUrl(id));
    playingVideoId = sm.playingVideoId;
    syncVideoHud(id);
  }

  function morphLightbox(towardOrigin: boolean): void {
    const el = lightboxMediaEl;
    const origin = lightbox?.origin;
    if (!el || !origin || origin.width < 8 || origin.height < 8) return;
    const final = el.getBoundingClientRect();
    if (final.width < 8 || final.height < 8) return;
    const dx = origin.left - final.left;
    const dy = origin.top - final.top;
    const sx = origin.width / final.width;
    const sy = origin.height / final.height;
    el.style.transformOrigin = 'top left';
    if (towardOrigin) {
      el.style.transition = 'transform 0.48s cubic-bezier(0.4, 0, 0.2, 1), border-radius 0.48s ease';
      el.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
      el.style.borderRadius = '14px';
    } else {
      el.style.transition = 'none';
      el.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
      el.style.borderRadius = '14px';
      void el.offsetWidth;
      el.style.transition = 'transform 0.72s cubic-bezier(0.16, 1.12, 0.32, 1), border-radius 0.72s ease';
      el.style.transform = 'none';
      el.style.borderRadius = '10px';
    }
  }

  function openLightbox(id: string): void {
    const sm = sceneManager;
    const cn = sm?.getCanvasNode(id);
    const kg = graphStore.nodes.find((n) => n.id === id);
    const isVideo = cn?.kind === 'video' || kg?.properties?.kind === 'video';
    if (isVideo) {
      sm?.stopInlineVideo();
      playingVideoId = null;
      videoHud = null;
    }
    if (lightboxLeaveTimer) {
      clearTimeout(lightboxLeaveTimer);
      lightboxLeaveTimer = null;
    }
    lightbox = {
      url: getAssetFileUrl(id),
      kind: isVideo ? 'video' : 'photo',
      alt: dateFromProperties(kg?.properties) || (isVideo ? 'Video' : 'Photo'),
      origin: sm?.getPlaneScreenRect(id) ?? photoPlaqueRect,
      leaving: false,
    };
  }

  function closeLightbox(): void {
    if (!lightbox || lightbox.leaving) return;
    lightbox = { ...lightbox, leaving: true };
    morphLightbox(true);
    lightboxLeaveTimer = setTimeout(() => {
      lightboxLeaveTimer = null;
      lightbox = null;
    }, 500);
  }

  function maximizeVideo(id: string): void {
    openLightbox(id);
  }

  function navigateToNode(nodeId: string): void {
    const cn = sceneManager?.getCanvasNode(nodeId);
    selectedNodeId = nodeId;
    selectedCanvasNode = cn ?? null;
  }

  const THROTTLE_MS = 200;

  let lastUserNavAt = 0;

  function wireSceneManager(sm: SceneManager): void {
    graphStore.setVanishHandler(async (id) => {
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      await sm.vanishSource(id);
    });
    sm.setPinchSensitivity(DEFAULT_PINCH_SENSITIVITY);
    sm.onSelectNode = (nodeId) => {
      if (nodeId) {
        const cn = sm.getCanvasNode(nodeId);
        const kg = graphStore.nodes.find((n) => n.id === nodeId);
        const isConversation = cn?.kind === 'conversation'
          || kg?.properties?.entity_type === 'Conversation';
        if (isConversation) {
          sm.flyToNode(nodeId);
          galleryFocus = true;
          lastUserNavAt = Date.now();
          onselectconversation(nodeId);
          return;
        }
        const isVideo = cn?.kind === 'video' || kg?.properties?.kind === 'video';
        if (isVideo) {
          focusVideoOnWall(nodeId);
          return;
        }
        if (!galleryFocus) {
          sm.flyToNode(nodeId);
          galleryFocus = true;
          setClockFocus(nodeId);
          return;
        }
        const nodeYaw = cn?.yaw ?? 0;
        let yawDelta = Math.abs(nodeYaw - sm.lookYaw);
        if (yawDelta > Math.PI) yawDelta = Math.abs(yawDelta - 2 * Math.PI);
        if (yawDelta > 0.4) {
          sm.flyToNode(nodeId);
          galleryFocus = true;
          setClockFocus(nodeId);
          return;
        }
        const isPhoto = cn?.kind === 'photo' || kg?.properties?.kind === 'photo';
        if (isPhoto || isVideo) {
          openLightbox(nodeId);
          return;
        }
        overlayOrigin = sm.getPlaneScreenRect(nodeId);
        selectedNodeId = nodeId;
        selectedCanvasNode = cn ?? null;
      } else {
        galleryFocus = false;
        playingVideoId = null;
        videoHud = null;
        setClockFocus(null);
        sm.resetLook();
        clearSelection();
      }
    };
    sm.onHoverNode = (nodeId) => {
      hoveredNodeId = nodeId;
      const kind = nodeId ? sm.getCanvasNode(nodeId)?.kind : null;
      if (nodeId && kind === 'video') {
        syncVideoHud(nodeId);
        photoPlaqueRect = null;
      } else if (playingVideoId) {
        syncVideoHud(playingVideoId);
        photoPlaqueRect = null;
      } else if (!videoHudPinned) {
        videoHud = null;
        if (nodeId && kind === 'photo') {
          const rect = sm.getPlaneScreenRect(nodeId);
          photoPlaqueRect = rect && rect.width >= 140 ? rect : null;
        } else {
          photoPlaqueRect = null;
        }
      }
    };
    sm.onChunkChange = (_cx, _cy, cz) => {
      updateDateLabel(cz * CHUNK_SIZE);
    };
    sm.onCameraZ = (z) => {
      if (!selectedNodeId) corridorClockRef.focusMs = null;
      updateDateLabel(z);
    };
    sm.onDoubleTap = (x, y) => {
      handleDoubleTap(x, y);
    };
    sm.onTimelineScroll = (direction) => {
      handleTimelineScroll(direction);
    };
  }

  let lastPinchScale = $state(1);
  let lastPinchCenterY = $state(0);
  let twoFingerGesture: 'undecided' | 'pinch' | 'swipe' = $state('undecided');
  let lastPanX = $state(0);
  let lastPanY = $state(0);

  // Composed gesture: pinch (fingers converge/diverge) → zoom,
  // two-finger swipe (fingers move in parallel) → timeline scroll.
  // Single-finger pan is handled by SceneManager's pointer events.
  const canvasGesture: GestureCallback = (register) => {
    const pinchFns = register(pinchComposition, { touchAction: 'none' });
    let prevCenterY: number | null = null;

    return (activeEvents, event) => {
      if (activeEvents.length < 2) {
        if (twoFingerGesture === 'pinch') {
          sceneManager?.handlePinchEnd();
        }
        prevCenterY = null;
        twoFingerGesture = 'undecided';
        lastPinchScale = 1;
        return;
      }

      pinchFns.onMove?.(activeEvents, event);

      const p0 = activeEvents[0];
      const p1 = activeEvents[1];
      const centerY = (p0.clientY + p1.clientY) / 2;

      if (prevCenterY === null) {
        prevCenterY = centerY;
        return;
      }

      const dy = centerY - prevCenterY;
      prevCenterY = centerY;

      if (twoFingerGesture === 'swipe' && sceneManager) {
        sceneManager.onTimelineScroll?.(dy);
      }
    };
  };

  function handlePinch(event: PinchCustomEvent): void {
    if (!sceneManager) return;
    if (twoFingerGesture === 'swipe') return;
    twoFingerGesture = 'pinch';
    const scale = event.detail.scale;
    if (lastPinchScale === 1) {
      sceneManager.handlePinchStart();
    }
    const delta = -(scale - lastPinchScale) * 200;
    lastPinchScale = scale;
    sceneManager.handlePinchMove(delta);
  }

  const SWIPE_TIMELINE_DELTA = 40;

  function handleSwipe(event: SwipeCustomEvent): void {
    if (event.detail.pointerType !== 'touch') return;
    const dir = event.detail.direction;
    if (dir === 'top') {
      handleTimelineScroll(-SWIPE_TIMELINE_DELTA);
    } else if (dir === 'bottom') {
      handleTimelineScroll(SWIPE_TIMELINE_DELTA);
    }
  }

  function handleDoubleTap(_x: number, _y: number): void {
    sceneManager?.dashAlongLook();
  }

  function updateDateLabel(worldZ: number): void {
    if (timelineScrubbing) return;
    if (!timeIndex || timeIndex.indexToLabel.length === 0) {
      currentBucketIdx = -1;
      dateLabel = null;
      updatePinchBounds(-1);
      return;
    }
    const nowMs = Date.now();
    const labels = timeIndex.indexToLabel;
    const wall = corridorClockRef.wallTimeline;
    const instant =
      wall && wall.length > 0
        ? (viewInstantFromWallZ(worldZ, wall, nowMs, null) ??
          viewInstantFromCameraZ(worldZ, timeIndex.indexToTime, timeIndex.indexToLocation, nowMs, null))
        : viewInstantFromCameraZ(worldZ, timeIndex.indexToTime, timeIndex.indexToLocation, nowMs, null);
    const bucketIdx = Math.max(
      0,
      Math.min(labels.length - 1, bucketIndexFromMs(instant.ms, timeIndex.indexToBucket, nowMs))
    );
    currentBucketIdx = bucketIdx;
    const liveLabel = labels[labels.length - 1] ?? 'Today';
    dateLabel = formatHudDate(instant.ms, instant.live, liveLabel);
    updatePinchBounds(bucketIdx);
  }

  function updatePinchBounds(bucketIdx: number): void {
    if (!sceneManager || bucketIdx < 0) {
      sceneManager?.setPinchZoomBounds(null, null);
      return;
    }
    const bucketStartZ = bucketIdx * TIME_BUCKET_SPACING * CHUNK_SIZE + INITIAL_CAMERA_Z;
    sceneManager.setPinchZoomBounds(
      Math.max(sceneManager.minCameraZ, bucketStartZ + CHUNK_SIZE * 0.25),
      bucketStartZ + TIME_BUCKET_SPACING * CHUNK_SIZE,
    );
  }

  function flyToBucket(bucketIdx: number, closeOnFly = true): void {
    if (!sceneManager || !timeIndex) return;
    const n = timeIndex.indexToLabel.length;
    if (bucketIdx < 0 || bucketIdx >= n) return;
    const wall = corridorClockRef.wallTimeline;
    const t = timeIndex.indexToTime[bucketIdx];
    const wallZ = wall && wall.length > 0 ? zForTime(t, wall) : null;
    const targetZ = wallZ ?? fractionalIndexToCameraZ(bucketIdx);
    sceneManager.flyTo(targetZ);
    galleryFocus = false;
    if (closeOnFly) timelineOpen = false;
    doubleTapPhase = 0;
  }

  function toggleTimeline(): void {
    timelineOpen = !timelineOpen;
  }

  function closeTimeline(): void {
    timelineOpen = false;
    pendingScrollDelta = 0;
    timelineScrubbing = false;
    // Cancel any pending navigation — dismiss means cancel, not navigate
    if (timelineCloseTimer) { clearTimeout(timelineCloseTimer); timelineCloseTimer = null; }
  }

  // ── Continuous picker-wheel scroll state ──
  const ITEM_HEIGHT = 44;
  const SCROLL_SENSITIVITY = 0.15;
  const SCROLL_DEAD_ZONE = 80;          // min cumulative delta before timeline opens

  let wheelOffset = $state(0);         // continuous pixel offset of the drum
  let wheelInitialized = false;        // true once the wheel position has been set
  let pendingScrollDelta = 0;           // accumulates small deltas until dead zone is crossed

  function clampWheelOffset(offset: number): number {
    if (!timeIndex || timeIndex.indexToLabel.length === 0) return 0;
    const maxOffset = (timeIndex.indexToLabel.length - 1) * ITEM_HEIGHT;
    return Math.max(0, Math.min(maxOffset, offset));
  }

  function updateBucketFromWheel(): void {
    if (!timeIndex || timeIndex.indexToLabel.length === 0) return;
    const visualIdx = Math.round(wheelOffset / ITEM_HEIGHT);
    const n = timeIndex.indexToLabel.length;
    const clampedVisual = Math.max(0, Math.min(n - 1, visualIdx));
    // Don't commit the bucket/date while scrubbing — only update pinch bounds.
    // The confirmed values are set when the settle timer fires or on dismiss.
    updatePinchBounds(clampedVisual);
  }

  function moveTimelineWheel(pixelDelta: number): void {
    if (!timeIndex || timeIndex.indexToLabel.length === 0) return;
    timelineOpen = true;
    timelineScrubbing = true;

    if (!wheelInitialized) {
      const n = timeIndex.indexToLabel.length;
      const visualIdx = currentBucketIdx < 0 ? n - 1 : currentBucketIdx;
      wheelOffset = visualIdx * ITEM_HEIGHT;
      wheelInitialized = true;
    }

    // Apply pixel delta 1:1 — no sensitivity dampening (touch deltas are already small)
    wheelOffset = clampWheelOffset(wheelOffset + pixelDelta);
    updateBucketFromWheel();

    // Reset close timer — when it fires, we snap and navigate
    if (timelineCloseTimer) clearTimeout(timelineCloseTimer);
    timelineCloseTimer = setTimeout(() => {
      timelineScrubbing = false;
      timelineCloseTimer = null;
      const snapTarget = Math.round(wheelOffset / ITEM_HEIGHT) * ITEM_HEIGHT;
      wheelOffset = snapTarget;
      const n = timeIndex.indexToLabel.length;
      const bucketIdx = Math.max(0, Math.min(n - 1, Math.round(wheelOffset / ITEM_HEIGHT)));
      currentBucketIdx = bucketIdx;
      dateLabel = timeIndex.indexToLabel[bucketIdx];
      flyToBucket(bucketIdx);
    }, 1200);
  }

  function handleTimelineScroll(delta: number): void {
    if (!timeIndex || timeIndex.indexToLabel.length === 0) return;

    // Dead zone: accumulate small deltas until the user has scrolled enough
    // to clearly intend a timeline navigation. This prevents accidental
    // date switches from minor trackpad brushes.
    if (!timelineOpen) {
      pendingScrollDelta += delta;
      if (Math.abs(pendingScrollDelta) < SCROLL_DEAD_ZONE) return;
      // Exceeded dead zone — consume the accumulated delta
      delta = pendingScrollDelta;
      pendingScrollDelta = 0;
    } else {
      pendingScrollDelta = 0;
    }

    timelineOpen = true;
    timelineScrubbing = true;

    // Initialize wheel to current position on first open
    if (!wheelInitialized) {
      const n = timeIndex.indexToLabel.length;
      const visualIdx = currentBucketIdx < 0 ? n - 1 : currentBucketIdx;
      wheelOffset = visualIdx * ITEM_HEIGHT;
      wheelInitialized = true;
    }

    // Apply sensitivity dampening for scroll-wheel (touch uses moveTimelineWheel).
    // Positive deltaY (scroll down) increases offset → newer; scroll up → older.
    const dampened = delta * SCROLL_SENSITIVITY;
    wheelOffset = clampWheelOffset(wheelOffset + dampened);

    // Update bucket index in real time (visual only, rounds to nearest)
    updateBucketFromWheel();

    // Reset close timer — when it fires, we snap and navigate
    if (timelineCloseTimer) clearTimeout(timelineCloseTimer);
    timelineCloseTimer = setTimeout(() => {
      timelineScrubbing = false;
      timelineCloseTimer = null;
      // Snap to nearest item, then navigate
      const snapTarget = Math.round(wheelOffset / ITEM_HEIGHT) * ITEM_HEIGHT;
      wheelOffset = snapTarget;
      // Commit the selection
      const n = timeIndex.indexToLabel.length;
      const bucketIdx = Math.max(0, Math.min(n - 1, Math.round(wheelOffset / ITEM_HEIGHT)));
      currentBucketIdx = bucketIdx;
      dateLabel = timeIndex.indexToLabel[bucketIdx];
      flyToBucket(bucketIdx);
    }, 1200);
  }

  function handleTimelinePan(event: PanCustomEvent): void {
    if (!timeIndex || timeIndex.indexToLabel.length === 0) return;
    if (event.detail.pointerType !== 'touch') return;
    // Skip the first pan event after reset — lastPanY=0 would produce a
    // huge absolute delta that causes a jarring jump.
    if (lastPanY === 0) {
      lastPanY = event.detail.y;
      return;
    }
    const dy = event.detail.y - lastPanY;
    lastPanY = event.detail.y;
    // Touch pan deltas are in screen pixels — apply directly without
    // the dampening factor used for scroll-wheel (which has much larger deltas).
    moveTimelineWheel(-dy);
  }

  function handleTimelinePanStart(): void {
    timelineOpen = true;
    timelineScrubbing = true;
    lastPanX = 0;
    lastPanY = 0;
    if (!wheelInitialized) {
      if (!timeIndex || timeIndex.indexToLabel.length === 0) return;
      const n = timeIndex.indexToLabel.length;
      const visualIdx = currentBucketIdx < 0 ? n - 1 : currentBucketIdx;
      wheelOffset = visualIdx * ITEM_HEIGHT;
      wheelInitialized = true;
    }
  }

  function handleTimelinePanEnd(): void {
    lastPanX = 0;
    lastPanY = 0;
    if (timelineCloseTimer) clearTimeout(timelineCloseTimer);
    timelineCloseTimer = setTimeout(() => {
      timelineScrubbing = false;
      timelineCloseTimer = null;
      const snapTarget = Math.round(wheelOffset / ITEM_HEIGHT) * ITEM_HEIGHT;
      wheelOffset = snapTarget;
      if (!timeIndex || timeIndex.indexToLabel.length === 0) return;
      const n = timeIndex.indexToLabel.length;
      const bucketIdx = Math.max(0, Math.min(n - 1, Math.round(wheelOffset / ITEM_HEIGHT)));
      currentBucketIdx = bucketIdx;
      dateLabel = timeIndex.indexToLabel[bucketIdx];
      flyToBucket(bucketIdx);
    }, 1200);
  }

  function rebuildLayout(): void {
    if (!sceneManager) return;
    const nodes = buildCanvasLayout(
      graphStore.nodes,
      graphStore.edges,
      graphStore.photoImages,
      graphStore.personImages,
      undefined,
      graphStore.sourceOnline ?? {},
    );
    timeIndex = buildTimeIndex(graphStore.nodes, graphStore.edges);
    corridorClockRef.wallTimeline = collapseWallSamples(wallTimeSamplesFromCanvas(nodes));
    sceneManager.setNodes(nodes);
    lastAppliedAt = Date.now();
    if (timeIndex.indexToLabel.length > 0) {
      updateDateLabel(sceneManager.basePosZ);
    }
  }

  function scheduleRebuild(): void {
    if (!mounted || !sceneManager) return;
    if (graphStore.isVanishing) return;
    if (pendingTimer) return;
    const elapsed = Date.now() - lastAppliedAt;
    const delay = Math.max(0, THROTTLE_MS - elapsed);
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      rebuildLayout();
    }, delay);
  }

  function onContainerPointerMove(e: PointerEvent): void {
    if (!containerEl) return;
    const rect = containerEl.getBoundingClientRect();
    tooltipX = e.clientX - rect.left;
    tooltipY = e.clientY - rect.top;
    if (hoveredNodeId && hoveredKind === 'photo' && sceneManager && !lightbox) {
      const plane = sceneManager.getPlaneScreenRect(hoveredNodeId);
      photoPlaqueRect = plane && plane.width >= 140 ? plane : null;
    }
  }

  /** Initial graph fetch — loads nodes/edges via the OWUI graph API and
   *  subscribes to real-time updates over the shared Socket.IO connection.
   *  Also seeds `graphStore` with conversation nodes so the canvas shows
   *  conversations even when LightRAG has no photos. */
  async function loadGraph(): Promise<void> {
    loadError = null;
    try {
      const token = localStorage.token;
      // Subscribe to real-time graph updates (Socket.IO). Optional — if the
      // socket isn't connected yet, the sync client will rebind when it is.
      try {
        graphSyncClient.connect(graphStore);
      } catch {
        // Sync backend optional — continue without real-time updates.
      }
      await graphStore.loadGraph(token);
      await graphStore.loadConversations(token);
      await graphStore.loadCanvas(token);
    } catch (e) {
      loadError = e instanceof Error ? e.message : 'Failed to load graph';
    } finally {
      loaded = true;
    }
  }

  /** Expose the SceneManager on window for E2E / browser-harness testing. */
  function exposeSceneManager(sm: SceneManager): void {
    if (typeof window !== 'undefined') {
      (window as any).__sceneManager = sm;
      (window as any).__graphTextureCount = () => textureCache.size();
    }
  }

  onMount(() => {
    mounted = true;
    containerEl?.addEventListener('pointermove', onContainerPointerMove);
    const loadFonts = typeof document !== 'undefined' && document.fonts
      ? Promise.all([
          document.fonts.load('600 32px Fraunces'),
          document.fonts.load('400 16px Inter'),
          document.fonts.load('500 13px "JetBrains Mono"'),
        ]).catch(() => undefined)
      : Promise.resolve();
    loadFonts.then(() => {
      if (!mounted) return;
      fontsLoaded = true;
      if (containerEl && graphStore.nodes.length > 0 && !sceneManager) {
        sceneManager = new SceneManager(containerEl);
        wireSceneManager(sceneManager);
        exposeSceneManager(sceneManager);
        rebuildLayout();
        sceneManager.start();
        firstLayoutApplied = true;
      } else if (!sceneManager) {
        loadGraph();
      }
    });
  });

  onDestroy(() => {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    if (activeFlyTimer) {
      clearTimeout(activeFlyTimer);
      activeFlyTimer = null;
    }
    if (timelineCloseTimer) {
      clearTimeout(timelineCloseTimer);
      timelineCloseTimer = null;
    }
    if (lightboxLeaveTimer) {
      clearTimeout(lightboxLeaveTimer);
      lightboxLeaveTimer = null;
    }
    containerEl?.removeEventListener('pointermove', onContainerPointerMove);
    graphStore.setVanishHandler(null);
    searchHighlight.matchIds = null;
    sceneManager?.stop();
    sceneManager?.dispose();
    sceneManager = undefined;
    corridorClockRef.scene = null;
    corridorClockRef.timeIndex = null;
    corridorClockRef.focusMs = null;
    corridorClockRef.wallTimeline = null;
    if (typeof window !== 'undefined') {
      delete (window as any).__sceneManager;
      delete (window as any).__graphTextureCount;
    }
    // Cancel any in-flight texture image fetches so their browser connection
    // slots are released immediately — otherwise pending face-crop / photo
    // fetches can block other tabs' API requests for tens of seconds.
    textureCache.abortInFlight();
    // Detach from the shared Socket.IO connection so we don't leak handlers.
    graphSyncClient.disconnect();
    mounted = false;
  });

  // React to graphStore changes: mount the renderer once data arrives, then
  // throttle-rebuild on subsequent streaming updates. Skips the very first
  // emission (handled by onMount above) to avoid a double setNodes.
  $effect(() => {
    void graphStore.nodes;
    void graphStore.edges;
    void graphStore.photoImages;
    void graphStore.sourceOnline;

    if (!mounted || !fontsLoaded) return;
    if (!firstLayoutApplied) {
      if (containerEl && !sceneManager && graphStore.nodes.length > 0) {
        sceneManager = new SceneManager(containerEl);
        wireSceneManager(sceneManager);
        exposeSceneManager(sceneManager);
        rebuildLayout();
        sceneManager.start();
        firstLayoutApplied = true;
      }
      return;
    }
    scheduleRebuild();
  });

  $effect(() => {
    void graphStore.searchQuery;
    const ids = graphStore.searchMatchIds;
    searchHighlight.matchIds = ids ? new Set(ids) : null;
  });

  $effect(() => {
    const id = graphStore.focusRequest;
    if (!mounted || !sceneManager || !id) return;
    const sm = sceneManager;
    const kg = graphStore.nodes.find((n) => n.id === id);
    const isConversation = kg?.properties?.entity_type === 'Conversation'
      || (kg?.labels ?? []).some((l) => l === 'Conversation');
    queueMicrotask(() => {
      if (graphStore.focusRequest === id) graphStore.focusRequest = null;
    });
    if (isConversation) {
      sm.flyToNode(id);
      onselectconversation(id);
      return;
    }
    let attempts = 0;
    const tryFly = () => {
      if (sm.getCanvasNode(id)) {
        sm.flyToNode(id);
        return;
      }
      if (attempts++ < 20) setTimeout(tryFly, 100);
    };
    tryFly();
  });

  // Fly the camera to the active conversation node whenever the active id
  // changes. The layout rebuild is throttled, so the node may not be mounted
  // in the chunk manager on the first frame — retry on the next frame until
  // the plane is found or a short timeout elapses.
  let activeFlyTimer: ReturnType<typeof setTimeout> | null = null;
  let firstActiveSeen = false;
  $effect(() => {
    const activeId = graphStore.activeConversationId;
    if (!mounted || !sceneManager || !activeId) return;
    if (!firstActiveSeen) {
      firstActiveSeen = true;
      return;
    }
    if (activeFlyTimer) {
      clearTimeout(activeFlyTimer);
      activeFlyTimer = null;
    }
    const sm = sceneManager;
    let attempts = 0;
    const tryFly = () => {
      activeFlyTimer = null;
      if (sm.getCanvasNode(activeId)) {
        sm.flyToNode(activeId);
        return;
      }
      if (attempts++ < 20) {
        activeFlyTimer = setTimeout(tryFly, 100);
      }
    };
    activeFlyTimer = setTimeout(tryFly, 220);
  });

  // Reset wheel offset when timeline closes; initialize when it opens
  let prevTimelineOpen = false;
  $effect(() => {
    if (timelineOpen) {
      // Immediately position the wheel at the current bucket so it shows
      // the correct date on open, not the oldest entry.
      if (timeIndex && timeIndex.indexToLabel.length > 0 && !wheelInitialized) {
        const n = timeIndex.indexToLabel.length;
        const visualIdx = currentBucketIdx < 0 ? n - 1 : currentBucketIdx;
        wheelOffset = visualIdx * ITEM_HEIGHT;
        wheelInitialized = true;
      }
    } else {
      wheelOffset = 0;
      wheelInitialized = false;
      pendingScrollDelta = 0;
    }
    prevTimelineOpen = timelineOpen;
  });

  let isEmpty = $derived(graphStore.nodes.length === 0);

  $effect(() => {
    corridorClockRef.scene = sceneManager ?? null;
    corridorClockRef.timeIndex = timeIndex;
  });
 </script>
 
  <svelte:window onkeydown={(e) => { if (e.key === 'Escape' && lightbox) closeLightbox(); }} />
  <div bind:this={containerEl} class="canvas-container" data-testid="graph-canvas"
    {...useComposedGesture(canvasGesture, { onpinch: handlePinch })}
    {...useSwipe(handleSwipe, () => ({ timeframe: 400, minSwipeDistance: 40, touchAction: 'none' }))}
  ></div>

  <GraphClock ontoggle={toggleTimeline} />
 
{#if isEmpty}
  <div class="empty-state">
    {#if loadError}
      <div class="empty-title">Failed to load graph</div>
      <div class="empty-sub">{loadError}</div>
      <button class="retry-btn" onclick={() => loadGraph()}>Retry</button>
    {:else if !loaded}
      <div class="empty-title">Loading graph…</div>
      <div class="empty-sub">Fetching nodes from the knowledge graph.</div>
    {:else}
      <div class="empty-icon" aria-hidden="true">
        <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
      </div>
      <div class="empty-title">No knowledge graph yet</div>
      <div class="empty-sub">Attach an image to the chat below to start building your knowledge graph. Extracted entities and relationships will appear here.</div>
    {/if}
  </div>
{/if}

{#if hoveredNodeId && !selectedNodeId && !lightbox && hoverTooltip}
  <div class="hover-tooltip show" style="left: {tooltipX + 14}px; top: {tooltipY + 14}px;" data-od-id="hover-tooltip">
      {hoverTooltip}
  </div>
{/if}

{#if hoverPlaque && plaquePos && !lightbox && !selectedNodeId && (hoverPlaque.title || hoverPlaque.location || hoverPlaque.camera || hoverPlaque.tech)}
  <aside
    class="museum-plaque"
    style="left: {plaquePos.left}px; top: {plaquePos.top}px"
  >
    {#if hoverPlaque.title}
      <div class="plaque-title">{hoverPlaque.title}</div>
    {/if}
    {#if hoverPlaque.location}
      <div class="plaque-loc">{hoverPlaque.location}</div>
    {/if}
    {#if hoverPlaque.camera}
      <div class="plaque-camera">{hoverPlaque.camera}</div>
    {/if}
    {#if hoverPlaque.tech}
      <div class="plaque-tech">{hoverPlaque.tech}</div>
    {/if}
  </aside>
{/if}

{#if lightbox}
  <div class="lightbox" class:is-leaving={lightbox.leaving} role="presentation" onclick={closeLightbox}>
    {#if lightbox.kind === 'video'}
      <video bind:this={lightboxMediaEl} class="lightbox-media" src={lightbox.url} controls autoplay onclick={(e) => e.stopPropagation()}></video>
    {:else}
      <img bind:this={lightboxMediaEl} class="lightbox-media" src={lightbox.url} alt={lightbox.alt} onclick={(e) => e.stopPropagation()} />
    {/if}
    <button type="button" class="lightbox-close" aria-label="Close" onclick={closeLightbox}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
    </button>
  </div>
{/if}

{#if videoHud && !selectedNodeId}
  <div
    class="video-wall-hud"
    class:is-playing={playingVideoId === videoHud.id}
    style="left: {videoHud.left}px; top: {videoHud.top}px; width: {videoHud.width}px; height: {videoHud.height}px"
    onpointerenter={() => (videoHudPinned = true)}
    onpointerleave={() => (videoHudPinned = false)}
  >
    <div class="video-wall-bar">
      <button
        type="button"
        class="video-wall-btn"
        aria-label={playingVideoId === videoHud.id ? 'Pause' : 'Play'}
        onclick={(e) => {
          e.stopPropagation();
          toggleWallPlayback(videoHud.id);
        }}
      >
        {#if playingVideoId === videoHud.id}
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>
        {:else}
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5L8 5.5Z"/></svg>
        {/if}
      </button>
      <button
        type="button"
        class="video-wall-btn"
        aria-label="Maximize"
        onclick={(e) => {
          e.stopPropagation();
          maximizeVideo(videoHud.id);
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 3H5a2 2 0 0 0-2 2v4M15 3h4a2 2 0 0 1 2 2v4M9 21H5a2 2 0 0 1-2-2v-4M15 21h4a2 2 0 0 0 2-2v-4"/></svg>
      </button>
    </div>
  </div>
{/if}

  {#if dateLabel}
  {#if timelineOpen}
    <button
      type="button"
      class="navigate-scrim"
      aria-label="Close date picker"
      onclick={closeTimeline}
    ></button>
    <div
      class="navigate-popover"
      onwheel={(e) => { e.preventDefault(); handleTimelineScroll(e.deltaY); }}
      onkeydown={(e) => (e.key === 'Escape' ? closeTimeline() : null)}
      {...usePan(handleTimelinePan, () => ({ touchAction: 'none', delay: 0 }), { onpandown: handleTimelinePanStart, onpanup: handleTimelinePanEnd })}
      data-od-id="navigate-overlay"
    >
      <div class="navigate-overlay-label">Navigate to</div>
      <div class="timeline-wheel" data-od-id="timeline-wheel">
        <div class="timeline-wheel-highlight" class:scrubbing={timelineScrubbing}></div>
        <div
          class="timeline-wheel-drum"
          class:scrubbing={timelineScrubbing}
          style="transform: translateY({-wheelOffset}px)"
        >
          {#each timelineEntries as entry, i (entry.idx)}
            {@const itemTop = i * ITEM_HEIGHT - wheelOffset}
            {@const distFromCenter = itemTop / ITEM_HEIGHT}
            {@const absDist = Math.abs(distFromCenter)}
            {@const rotateX = distFromCenter > 0 ? -10 * Math.min(absDist, 3) : distFromCenter < 0 ? 10 * Math.min(absDist, 3) : 0}
            {@const scale = absDist === 0 ? 1 : absDist <= 1 ? 0.88 + 0.12 * (1 - absDist) : absDist <= 2 ? 0.76 + 0.12 * (2 - absDist) : 0.65}
            {@const opacity = absDist === 0 ? 1 : absDist <= 1 ? 0.65 + 0.35 * (1 - absDist) : absDist <= 2 ? 0.35 + 0.30 * (2 - absDist) : 0.15}
            {@const isNearest = absDist < 0.5}
            <div
              class="timeline-wheel-item"
              class:active={isNearest}
              style="opacity: {opacity}; transform: perspective(400px) rotateX({rotateX}deg) scale({scale})"
              onclick={() => flyToBucket(entry.idx)}
              role="option"
              aria-selected={isNearest ? 'true' : undefined}
              data-od-id="timeline-tick"
            >
              {entry.label}
            </div>
          {/each}
        </div>
      </div>
    </div>
  {/if}

{/if}



<ConversationCloud {sceneManager} {onselectconversation} hidden={true} />
<NodeOverlay node={selectedCanvasNode} kgNode={selectedKgNode} originRect={overlayOrigin} onClose={clearSelection} onNavigate={navigateToNode} />

{#if sceneManager}
  <ProcessingOverlay {sceneManager} />
  <ProcessingDock {sceneManager} />
{/if}

<style>
  /* ── Tokens — match NodeOverlay's --overlay-* visual system ── */
  :root {
    --canvas-bg:          oklch(6% 0.02 260);
    --canvas-fg:          oklch(90% 0.005 250);
    --canvas-muted:       oklch(65% 0.02 255);
    --canvas-faint:       oklch(55% 0.02 255);
    --canvas-accent:           oklch(82% 0.14 210);
    --canvas-accent-dim:       oklch(82% 0.14 210 / 18%);
    --canvas-accent-purple:    oklch(72% 0.16 295);
    --canvas-accent-purple-dim: oklch(72% 0.16 295 / 18%);
    --canvas-success:     oklch(72% 0.15 150);
    --canvas-danger:      oklch(62% 0.20 18);
    --canvas-glass:       oklch(16% 0.015 255 / 45%);
    --canvas-glass-light: oklch(20% 0.015 255 / 30%);
    --canvas-hairline:    oklch(50% 0.03 255 / 8%);

    /* Brand typography — paulvisciano.com */
    --font-display: 'Fraunces', 'Iowan Old Style', Georgia, serif;
    --font-body:    'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    --font-mono:    'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace;
  }

  .canvas-container {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }

  /* ── Empty state — glassmorphism, floating spatial ── */
  .empty-state {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    pointer-events: none;
    color: var(--canvas-accent);
    font-family: var(--font-mono);
    animation: float-in 0.6s cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  .empty-title {
    font-family: var(--font-display);
    font-size: 1.25rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--canvas-fg);
    text-shadow: 0 0 24px oklch(82% 0.14 210 / 30%);
  }

  .empty-sub {
    font-size: 0.85rem;
    line-height: 1.65;
    color: var(--canvas-muted);
    max-width: 22rem;
    text-align: center;
    font-family: var(--font-body);
  }

  .empty-icon {
    width: 4rem;
    height: 4rem;
    border-radius: 50%;
    background: var(--canvas-glass);
    backdrop-filter: blur(24px) saturate(1.4);
    -webkit-backdrop-filter: blur(24px) saturate(1.4);
    box-shadow:
      0 0 0 1px oklch(50% 0.03 255 / 10%),
      0 20px 60px oklch(0% 0 0 / 40%);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--canvas-accent);
  }

  .retry-btn {
    margin-top: 6px;
    padding: 8px 18px;
    background: oklch(62% 0.20 18 / 10%);
    backdrop-filter: blur(20px) saturate(1.3);
    -webkit-backdrop-filter: blur(20px) saturate(1.3);
    border-radius: 100px;
    border: 1px solid oklch(62% 0.20 18 / 20%);
    color: oklch(62% 0.20 18 / 80%);
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    cursor: pointer;
    pointer-events: auto;
    transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .retry-btn:hover {
    color: oklch(62% 0.20 18);
    background: oklch(62% 0.20 18 / 18%);
    border-color: oklch(62% 0.20 18 / 50%);
    transform: translateY(-1px);
    box-shadow: 0 8px 24px oklch(62% 0.20 18 / 15%);
  }

  /* ── Hover tooltip — glass pill ── */
  .hover-tooltip {
    position: absolute;
    z-index: 20;
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 6px 12px;
    background: var(--canvas-glass);
    backdrop-filter: blur(20px) saturate(1.4);
    -webkit-backdrop-filter: blur(20px) saturate(1.4);
    border-radius: 12px;
    box-shadow: 0 0 0 1px oklch(50% 0.03 255 / 8%);
    color: var(--canvas-muted);
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.12s ease;
  }
  .hover-tooltip.show { opacity: 1; }

  .video-wall-hud {
    position: fixed;
    z-index: 22;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    padding: 12px;
    pointer-events: none;
    box-sizing: border-box;
  }
  .video-wall-bar {
    pointer-events: auto;
    display: flex;
    gap: 8px;
    padding: 6px 8px;
    border-radius: 999px;
    background: oklch(16% 0.015 255 / 58%);
    backdrop-filter: blur(16px) saturate(1.4);
    -webkit-backdrop-filter: blur(16px) saturate(1.4);
    box-shadow: 0 0 0 1px oklch(50% 0.03 255 / 12%);
  }
  .video-wall-btn {
    width: 36px;
    height: 36px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 0;
    border-radius: 999px;
    background: oklch(92% 0.01 85 / 12%);
    color: oklch(96% 0.01 85);
    cursor: pointer;
  }
  .video-wall-btn svg {
    width: 16px;
    height: 16px;
  }
  .video-wall-btn:hover {
    background: oklch(82% 0.14 210 / 28%);
  }
  .museum-plaque {
    position: absolute;
    z-index: 24;
    width: 240px;
    max-width: calc(100vw - 24px);
    padding: 12px 16px 14px;
    border-radius: 10px;
    background: oklch(12% 0.02 85 / 88%);
    border: 1px solid oklch(82% 0.08 85 / 22%);
    box-shadow:
      0 12px 32px oklch(0% 0 0 / 45%),
      0 0 0 1px oklch(50% 0.03 85 / 10%);
    backdrop-filter: blur(20px) saturate(1.3);
    -webkit-backdrop-filter: blur(20px) saturate(1.3);
    pointer-events: none;
    color: oklch(92% 0.02 85);
    animation: plaque-in 0.28s cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  @keyframes plaque-in {
    from { opacity: 0; transform: translateX(10px); }
    to { opacity: 1; transform: none; }
  }
  .plaque-title {
    font-family: var(--font-display);
    font-size: 15px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: oklch(96% 0.02 85);
  }
  .plaque-loc {
    margin-top: 2px;
    font-family: var(--font-body);
    font-size: 12px;
    color: oklch(78% 0.03 85 / 85%);
  }
  .plaque-camera {
    margin-top: 10px;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: oklch(82% 0.14 210);
  }
  .plaque-tech {
    margin-top: 3px;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.04em;
    color: oklch(72% 0.02 85 / 80%);
  }

  .lightbox {
    position: fixed;
    inset: 0;
    z-index: 80;
    display: flex;
    align-items: center;
    justify-content: center;
    background: oklch(4% 0.01 260 / 92%);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    transition: background 0.45s ease, opacity 0.45s ease;
  }
  .lightbox.is-leaving {
    background: oklch(4% 0.01 260 / 0%);
    pointer-events: none;
  }
  .lightbox-media {
    max-width: 94vw;
    max-height: 94vh;
    border-radius: 10px;
    box-shadow: 0 24px 80px oklch(0% 0 0 / 55%);
    will-change: transform;
  }
  .lightbox-close {
    position: absolute;
    top: calc(16px + env(safe-area-inset-top, 0px));
    right: calc(16px + env(safe-area-inset-right, 0px));
    width: 40px;
    height: 40px;
    padding: 0;
    border: 1px solid oklch(82% 0.14 210 / 28%);
    border-radius: 50%;
    background: oklch(10% 0.02 255 / 82%);
    color: oklch(92% 0.02 210);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }
  .lightbox-close svg {
    width: 16px;
    height: 16px;
  }
  .lightbox-close:hover {
    background: oklch(82% 0.14 210 / 18%);
  }

  .navigate-scrim {
    position: fixed;
    inset: 0;
    z-index: 48;
    border: 0;
    padding: 0;
    background: transparent;
    cursor: default;
  }

  .navigate-popover {
    position: fixed;
    right: calc(16px + env(safe-area-inset-right, 0px));
    bottom: calc(4.75rem + env(safe-area-inset-bottom, 0px));
    z-index: 50;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    width: 220px;
    padding: 10px 8px 12px;
    border-radius: 18px;
    background: oklch(10% 0.02 255 / 90%);
    backdrop-filter: blur(24px) saturate(1.5);
    -webkit-backdrop-filter: blur(24px) saturate(1.5);
    border: 1px solid oklch(82% 0.14 210 / 28%);
    box-shadow:
      0 12px 40px oklch(0% 0 0 / 50%),
      0 0 0 1px oklch(50% 0.03 255 / 10%);
    cursor: default;
    touch-action: none;
    animation: overlay-fade-in 0.18s ease-out;
  }

  .navigate-overlay-label {
    font-family: var(--font-mono, 'JetBrains Mono', ui-monospace, monospace);
    font-size: 10px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: oklch(82% 0.14 210 / 70%);
    pointer-events: none;
    margin: 0 0 6px;
    text-align: center;
  }

  @keyframes overlay-fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  /* ── Timeline pill (collapsed date label, always visible) ── */
  .timeline-pill {
    position: absolute;
    left: auto;
    right: calc(236px + env(safe-area-inset-right, 0px));
    z-index: 20;
    top: auto;
    bottom: calc(1.15rem + env(safe-area-inset-bottom, 0px));
    transform: none;
    z-index: 40;
    pointer-events: auto;
  }

  .timeline-header {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 40px;
    padding: 0 14px 0 16px;
    background: oklch(10% 0.02 255 / 82%);
    backdrop-filter: blur(24px) saturate(1.5);
    -webkit-backdrop-filter: blur(24px) saturate(1.5);
    border-radius: 100px;
    border: 1px solid oklch(82% 0.14 210 / 28%);
    box-shadow:
      0 8px 28px oklch(0% 0 0 / 45%),
      0 0 0 1px oklch(50% 0.03 255 / 10%);
    cursor: pointer;
    transition: background 0.2s, border-color 0.2s, box-shadow 0.2s;
  }
  .timeline-header:hover,
  .timeline-header.open {
    background: oklch(14% 0.025 255 / 88%);
    border-color: oklch(82% 0.14 210 / 50%);
  }
  .timeline-header:focus-visible {
    outline: none;
    border-color: oklch(82% 0.14 210 / 70%);
    box-shadow:
      0 8px 28px oklch(0% 0 0 / 45%),
      0 0 0 3px oklch(82% 0.14 210 / 25%);
  }

  .timeline-header-label {
    font-family: var(--font-mono);
    font-size: 13px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: oklch(92% 0.02 210);
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }

  .timeline-header-chevron {
    width: 14px;
    height: 14px;
    color: oklch(82% 0.14 210);
    flex-shrink: 0;
    transition: transform 0.2s ease;
  }
  .timeline-header.open .timeline-header-chevron {
    transform: rotate(180deg);
  }

  @media (max-width: 768px) {
    .timeline-pill {
      right: calc(16px + env(safe-area-inset-right, 0px));
      bottom: calc(88px + env(safe-area-inset-bottom, 0px));
    }
  }

  /* ── iOS-style carousel wheel ── */
  .timeline-wheel {
    position: relative;
    width: 100%;
    height: 196px;
    overflow: hidden;
    perspective: 400px;
  }

  .timeline-wheel-highlight {
    position: absolute;
    top: 50%;
    left: 0;
    right: 0;
    height: 44px;
    transform: translateY(-50%);
    background: transparent;
    border-top: 1px solid oklch(82% 0.14 210 / 30%);
    border-bottom: 1px solid oklch(82% 0.14 210 / 30%);
    pointer-events: none;
    z-index: 2;
    transition: border-color 0.3s;
  }
  .timeline-wheel-highlight.scrubbing {
    border-color: oklch(82% 0.14 210 / 40%);
  }

  .timeline-wheel-drum {
    position: absolute;
    left: 0;
    right: 0;
    top: 76px;
    transform-origin: center center;
    transition: transform 0.08s ease-out;
    will-change: transform;
  }
  .timeline-wheel-drum.scrubbing {
    transition: none;
  }

  .timeline-wheel-item {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 44px;
    border: none;
    background: transparent;
    cursor: pointer;
    user-select: none;
    -webkit-user-select: none;
    font-family: var(--font-mono);
    font-size: 13px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--canvas-faint);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
    transition: color 0.25s, font-weight 0.25s, opacity 0.25s, transform 0.3s cubic-bezier(0.22, 1, 0.36, 1);
    flex-shrink: 0;
    transform-origin: center center;
    position: relative;
    z-index: 1;
  }
  .timeline-wheel-drum.scrubbing .timeline-wheel-item {
    transition: color 0.06s, font-weight 0.06s, opacity 0.06s, transform 0.06s linear;
  }
  .timeline-wheel-item:hover {
    color: var(--canvas-fg);
  }
  .timeline-wheel-item.active {
    color: var(--canvas-accent);
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 15px;
  }

  .timeline-wheel-mask {
    display: none;
  }

  /* ── Shared animations ── */
  @keyframes float-in {
    from { opacity: 0; transform: translateY(20px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  @media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
      animation-duration: 0.01ms !important;
      transition-duration: 0.01ms !important;
    }
  }
</style>