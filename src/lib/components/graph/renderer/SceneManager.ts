/**
 * `SceneManager` — owns the Three.js scene graph, renderer, camera, RAF loop,
 * and input handling for the infinite canvas.
 *
 * This is the only renderer module that touches the DOM and `requestAnimationFrame`.
 * It wires a shared 1×1 `PlaneGeometry`, a `ChunkManager`, a
 * `PerspectiveCamera`, a `WebGLRenderer`, and a minimal direct-control
 * velocity model (drag pan / wheel zoom / WASD+arrows move) with inertia,
 * matching the reference repo's scene loop. Pause-on-hidden-tab and WebGL
 * context-loss handling are included for Phase 1 robustness.
 */
import * as THREE from 'three';
import {
  CHUNK_FADE_MARGIN,
  CHUNK_SIZE,
  DRIFT_LERP,
  DRIFT_LERP_ZOOMING,
  FOG_DENSITY,
  INITIAL_CAMERA_Z,
  TIME_BUCKET_SPACING,
  KEYBOARD_SPEED,
  MAX_CAMERA_Z,
  MAX_VELOCITY,
    MIN_CAMERA_Z,
    RENDER_DISTANCE,
  SCROLL_DECAY,
  SCROLL_MOMENTUM_DECAY,
  SCROLL_MOMENTUM_MAX,
  SCROLL_MOMENTUM_RAMP,
  SCROLL_MOMENTUM_WINDOW_MS,
    VELOCITY_DECAY,
  VELOCITY_LERP,
  ZOOMING_VEL_THRESHOLD,
  ZOOM_FACTOR,
  ZOOM_FACTOR_DIVISOR,
  VANISH_DURATION_MS,
} from './constants';



import { ChunkManager } from './ChunkManager';
import type { NodePlane } from './NodePlane';
import type { CanvasNode } from './types';
import { parseNodeDate } from './Layout';
import { textureCache } from '../services/TextureCache';

/** Camera field of view in degrees. */
const CAMERA_FOV = 60;
/** Near clipping plane. */
const CAMERA_NEAR = 0.1;
/** Minimum far clipping plane — used when no layout is applied yet. */
const CAMERA_FAR_MIN = 2000;
/** Near-black holographic canvas background (navy, matches FogExp2). */
const BACKGROUND_COLOR = 0x05070c;
/** Holographic cyan — matches `styles.css` `--color-cyber-cyan`. */
const GLOBE_COLOR = 0x00d4ff;
/** Sphere radius in world units. Small scenery globe in the field, not a HUD. */
const GLOBE_RADIUS = 24;
/** World Y — low-center in the field (not the mic orb). */
const GLOBE_Y = -40;
/** Parked world Z at the field origin; does not follow the camera. */
const GLOBE_Z = 0;
/** Radians per second idle spin around Y. */
const GLOBE_SPIN = 0.1;
/**
 * Floor-ring inner/outer radii (world units). Thin annuli in the XZ plane
 * under the globe; MeshBasicMaterial so FogExp2 still applies.
 */
const FLOOR_RINGS: ReadonlyArray<readonly [number, number, number]> = [
  [27, 29, 0.5],
  [36, 38, 0.32],
  [48, 50, 0.18],
];
/**
 * Top-level renderer façade. Construct with a container element, call
 * `setNodes` with a `CanvasNode[]` layout, then `start()`.
 */
export class SceneManager {
  private readonly _container: HTMLElement;
  private readonly _renderer: THREE.WebGLRenderer;
  private readonly _camera: THREE.PerspectiveCamera;
  private readonly _scene: THREE.Scene;
  private readonly _sharedGeometry: THREE.PlaneGeometry;
  private readonly _chunkManager: ChunkManager;
  /** Decorative wireframe globe + floor rings (scenery; not the mic orb). */
  private readonly _globeRoot: THREE.Group;
  private readonly _globe: THREE.LineSegments;
  private readonly _resizeObserver: ResizeObserver;
  private readonly _velocity = new THREE.Vector3();
  private readonly _targetVel = new THREE.Vector3();
  private _scrollAccum = 0;
  private _scrollMomentum = 1;
  private _lastScrollTime = 0;
  private readonly _basePos = new THREE.Vector3();
  private readonly _drift = new THREE.Vector2();
  private readonly _mouse = new THREE.Vector2();
  private readonly _keys = new Set<string>();
  private readonly _raycaster = new THREE.Raycaster();
  private readonly _pointerNdc = new THREE.Vector2();

  /** Last single-pointer drag state (mouse or first touch). */
  private readonly _pointer = {
    down: false,
    lastX: 0,
    lastY: 0,
    downStartX: 0,
    downStartY: 0,
    dragged: false,
    isTouch: false,
  };
  /** True while a pinch-to-zoom gesture is active (fed from svelte-gestures). */
  private _pinchActive = false;

  private static readonly IS_TOUCH_DEVICE =
    ('ontouchstart' in window) || (navigator.maxTouchPoints > 0) ||
    (window.matchMedia?.('(pointer: coarse)').matches ?? false);

  private _lastTapTime = 0;
  private _lastTapX = 0;
  private _lastTapY = 0;
  private _pendingClickTimer: ReturnType<typeof setTimeout> | null = null;
  private _pendingClickX = 0;
  private _pendingClickY = 0;

  private _rafId = 0;
  private _running = false;
  private _visible = true;
  private _disposed = false;
  private _userMoved = false;
  private _layoutCentered = false;
  private _lastHoverTime = 0;
  private _hoveredNodeId: string | null = null;
  private _cursorMode: 'idle' | 'grabbing' | 'pointer' = 'idle';
  private _hall: THREE.Group | null = null;
  private _skyTime: { value: number } | null = null;

  // Dynamic camera Z bounds derived from the layout's depth (time) range.
  // Newest photos sit at maxCellZ*CHUNK_SIZE; the camera starts just above
  // that and can zoom down toward 0 (oldest). Updated by setNodes.
  private _maxCameraZ = MAX_CAMERA_Z;
  private _minCameraZ = MIN_CAMERA_Z;
  /**
   * Optional tighter Z clamp for the pinch gesture only. When set (by
   * CanvasView to the current time bucket's depth span), pinch zoom stays
   * inside the month the user is viewing instead of scrubbing across months.
   * null = no pinch-specific clamp (pinch uses the global min/max).
   */
  private _pinchMinZ: number | null = null;
  private _pinchMaxZ: number | null = null;
  /**
   * Pinch-to-zoom sensitivity exponent. newZ = startZ * (startDist/dist)^s.
   * 1.0 = a 1:1 finger-distance ratio (current/default behaviour); <1.0
   * dampens the zoom so a large pinch moves the camera less (slower time
   * travel); >1.0 amplifies it (faster). Set from configStore so the user
   * can tune how quickly pinching scrubs through time buckets.
   */
  private _pinchSensitivity = 1.0;
  private _lastChunkX = Infinity;
  private _lastChunkY = Infinity;
  private _lastChunkZ = Infinity;

  // --- fly-to (animated camera travel) state ------------------------------
  // null when idle; otherwise lerps _basePos from _flyFrom to _flyTo over
  // _flyElapsed/_flyDuration ms. Animates all three axes so the camera can
  // pan (X/Y) and zoom (Z) simultaneously toward a specific node.
  private _flyTo: THREE.Vector3 | null = null;
  private readonly _flyFrom = new THREE.Vector3();
  private _flyElapsed = 0;
  private _lookYaw = 0;
  private _lookPitch = 0;
  private _yawFrom = 0;
  private _yawTo = 0;
  private _pitchFrom = 0;
  private _pitchTo = 0;
  private _vanishWaiters: Array<{
    sourceId: string;
    planes: NodePlane[];
    urls: string[];
    resolve: () => void;
    deadline: number;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private _flyDuration = 700;
  private _lastFrameMs = 0;

  /** Optional callback fired when the camera crosses a chunk boundary. */
  onChunkChange?: (cx: number, cy: number, cz: number) => void;

  onCameraZ?: (z: number) => void;
  private _lastReportedZ = Number.NaN;

  /** Fired when the user clicks a photo plane (or null on empty-space click). */
  onSelectNode?: (nodeId: string | null) => void;

  /** Fired as the pointer moves over a photo plane (or null when off-plane). */
  onHoverNode?: (nodeId: string | null) => void;

  /** Fired on a confirmed double-tap (touch) with the tap screen coordinates. */
  onDoubleTap?: (clientX: number, clientY: number) => void;

  /** Fired when a trackpad (two-finger) scroll is detected; carries accumulated pixel delta. */
  onTimelineScroll?: (delta: number) => void;

  private _playingVideoId: string | null = null;

  get playingVideoId(): string | null {
    return this._playingVideoId;
  }

  /**
   * Creates the renderer, camera, scene, shared geometry, and chunk manager,
   * appends the renderer's DOM element to `container`, and attaches input +
   * resize listeners. Does not start the RAF loop — call `start()`.
   *
   * @param container - DOM element to mount the canvas in.
   */
  constructor(container: HTMLElement) {
    this._container = container;
    const width = container.clientWidth || 1;
    const height = container.clientHeight || 1;

    this._renderer = new THREE.WebGLRenderer({ antialias: true });
    this._renderer.setPixelRatio(window.devicePixelRatio);
    this._renderer.setSize(width, height);
    container.appendChild(this._renderer.domElement);
    this._renderer.domElement.style.display = 'block';
    this._renderer.domElement.style.touchAction = 'none';

    this._camera = new THREE.PerspectiveCamera(
      CAMERA_FOV,
      width / height,
      CAMERA_NEAR,
      CAMERA_FAR_MIN,
    );
    this._camera.rotation.order = 'YXZ';
    this._camera.position.set(0, 0, INITIAL_CAMERA_Z);

    this._scene = new THREE.Scene();
    this._scene.background = new THREE.Color(BACKGROUND_COLOR);
    this._scene.fog = new THREE.FogExp2(BACKGROUND_COLOR, FOG_DENSITY);

    this._sharedGeometry = new THREE.PlaneGeometry(1, 1);
    this._chunkManager = new ChunkManager(this._scene, this._sharedGeometry);

    const globe = this.createGlobe();
    this._globeRoot = globe.root;
    this._globe = globe.globe;
    this._scene.add(this._globeRoot);

    this._resizeObserver = new ResizeObserver(() => this.onResize());
    this._resizeObserver.observe(container);

    this.bindEvents();
    this._renderer.domElement.style.cursor = 'grab';
  }

  /** The perspective camera. */
  get camera(): THREE.PerspectiveCamera {
    return this._camera;
  }

  get basePosX(): number { return this._basePos.x; }
  get basePosY(): number { return this._basePos.y; }
  get basePosZ(): number { return this._basePos.z; }
  get lookYaw(): number { return this._lookYaw; }
  get facingWall(): boolean { return Math.abs(Math.sin(this._lookYaw)) > 0.5; }
  get minCameraZ(): number { return this._minCameraZ; }
  get maxCameraZ(): number { return this._maxCameraZ; }
  get domElement(): HTMLCanvasElement { return this._renderer.domElement; }

  /** Number of chunks currently mounted (debug). */
  get mountedChunkCount(): number {
    return this._chunkManager.mountedChunkCount;
  }

  /**
   * Returns the IDs of all nodes in currently-mounted chunks (visible on
   * canvas). Intended for debugging / browser-harness polling.
   */
  getVisibleNodeIds(): string[] {
    const cm = this._chunkManager as unknown as {
      _mounted: Map<string, { planes: { node: { id: string } }[] }>;
    };
    const ids: string[] = [];
    for (const chunk of cm._mounted.values()) {
      for (const p of chunk.planes) ids.push(p.node.id);
    }
    return ids;
  }

  /** Current camera world position (for debugging). */
  get cameraPosition(): { x: number; y: number; z: number } {
    return {
      x: this._basePos.x,
      y: this._basePos.y,
      z: this._basePos.z,
    };
  }

  get isNavigating(): boolean {
    return this._velocity.lengthSq() > 0.05;
  }

  /**
   * Looks up the `CanvasNode` for `nodeId` among mounted chunks. Returns
   * `undefined` when the node's chunk is outside the render distance.
   */
  getCanvasNode(nodeId: string): CanvasNode | undefined {
    return this._chunkManager.findPlaneByNodeId(nodeId)?.node;
  }

  /**
   * Returns the world-space position of the plane mesh for `nodeId`, or
   * `null` when the node's chunk is not currently mounted. Safe to call
   * outside the RAF loop — `getWorldPosition` updates the world matrix on
   * demand, so the returned position is correct even between frames.
   */
  getPlaneWorldPosition(nodeId: string): THREE.Vector3 | null {
    const plane = this._chunkManager.findPlaneByNodeId(nodeId);
    if (!plane) return null;
    const worldPos = new THREE.Vector3();
    plane.mesh.getWorldPosition(worldPos);
    return worldPos;
  }

  /**
   * Projects a world-space position to canvas-relative screen coordinates.
   * Returns `null` when the point is behind the camera.
   */
  projectToScreen(worldPos: THREE.Vector3): { x: number; y: number } | null {
    const rect = this._renderer.domElement.getBoundingClientRect();
    const ndc = worldPos.clone().project(this._camera);
    if (ndc.z > 1) return null;
    return {
      x: ((ndc.x + 1) / 2) * rect.width,
      y: ((1 - ndc.y) / 2) * rect.height,
    };
  }

  /**
   * Projects the top-right corner of a photo plane to screen coordinates.
   * Returns `null` when the node isn't mounted or is behind the camera.
   */
  projectPlaneCorner(nodeId: string): { x: number; y: number } | null {
    const plane = this._chunkManager.findPlaneByNodeId(nodeId);
    if (!plane) return null;
    const node = plane.node;
    const worldPos = new THREE.Vector3();
    plane.mesh.getWorldPosition(worldPos);
    // Plane is 1×1 scaled by (width, height). Local +X is along the plane's
    // width; yaw rotates that into XZ so wall-tile badges stay on the tile.
    const ox = node.width / 2 - node.width * 0.05;
    const oy = -(node.height / 2 - node.height * 0.05);
    const yaw = node.yaw ?? 0;
    worldPos.x += ox * Math.cos(yaw);
    worldPos.y += oy;
    worldPos.z += -ox * Math.sin(yaw);
    return this.projectToScreen(worldPos);
  }

  getPlaneScreenRect(nodeId: string): { left: number; top: number; width: number; height: number } | null {
    const plane = this._chunkManager.findPlaneByNodeId(nodeId);
    if (!plane) return null;
    const mesh = plane.mesh;
    mesh.updateWorldMatrix(true, false);
    const canvasRect = this._renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector3();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let anyFront = false;
    for (const lx of [-0.5, 0.5]) {
      for (const ly of [-0.5, 0.5]) {
        v.set(lx, ly, 0).applyMatrix4(mesh.matrixWorld).project(this._camera);
        if (v.z <= 1) anyFront = true;
        const x = canvasRect.left + ((v.x + 1) / 2) * canvasRect.width;
        const y = canvasRect.top + ((1 - v.y) / 2) * canvasRect.height;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    if (!anyFront) return null;
    const width = maxX - minX;
    const height = maxY - minY;
    if (width < 4 || height < 4) return null;
    return { left: minX, top: minY, width, height };
  }

  /**
   * (Re)builds the layout from canvas nodes and forwards to `ChunkManager`.
   *
   * @param nodes - all canvas nodes.
   */
  setNodes(nodes: CanvasNode[]): void {
    this.updateDepthBounds(nodes);
    if (!this._userMoved && nodes.length > 0) {
      this.centerOnLayout(nodes);
    }
    this._chunkManager.setLayout(nodes);
    this.updateGalleryHall(nodes);
  }

  /**
   * Fade this source's NodePlanes to opacity 0 (mesh material, ~550ms ease-out),
   * then abort+dispose their textures (skipping URLs still used by an online
   * source) and sweep the planes out of their chunks.
   */
  vanishSource(sourceId: string): Promise<void> {
    if (this._disposed || !sourceId) return Promise.resolve();
    const { planes, urls } = this._chunkManager.beginVanish(sourceId);
    if (planes.length === 0 || planes.every((p) => p.isVanished || p.disposed)) {
      this.disposeSourceTextures(urls);
      this._chunkManager.finishVanish(sourceId);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const waiter = {
        sourceId,
        planes,
        urls,
        resolve,
        deadline: performance.now() + VANISH_DURATION_MS + 80,
        timer: setTimeout(() => this.tickVanish(), VANISH_DURATION_MS + 100),
      };
      this._vanishWaiters.push(waiter);
    });
  }

  private disposeSourceTextures(urls: string[]): void {
    const keep = this._chunkManager.collectLiveTextureUrls();
    textureCache.abortAndDisposeUrls(urls.filter((u) => u && !keep.has(u)));
  }

  private tickVanish(): void {
    if (!this._vanishWaiters.length) return;
    const now = performance.now();
    const still: typeof this._vanishWaiters = [];
    for (const w of this._vanishWaiters) {
      const done =
        now >= w.deadline || w.planes.every((p) => p.isVanished || p.disposed);
      if (!done) {
        still.push(w);
        continue;
      }
      clearTimeout(w.timer);
      this.disposeSourceTextures(w.urls);
      this._chunkManager.finishVanish(w.sourceId);
      w.resolve();
    }
    this._vanishWaiters = still;
  }

  setPinchSensitivity(s: number): void {
    this._pinchSensitivity = Math.max(0.1, Math.min(6.0, s));
  }

  setPinchZoomBounds(minZ: number | null, maxZ: number | null): void {
    this._pinchMinZ = minZ;
    this._pinchMaxZ = maxZ;
  }

  /**
   * Derive dynamic camera Z bounds + far clipping plane from the layout's
   * depth (time) range. Newest photos at maxCellZ get a starting camera Z
   * above them; the min is just above the oldest (z=0) plane so the user
   * can't fly past the oldest photos.
   */
   private updateDepthBounds(nodes: CanvasNode[]): void {
     if (nodes.length === 0) {
       this._maxCameraZ = MAX_CAMERA_Z;
       this._minCameraZ = MIN_CAMERA_Z;
       this._camera.far = CAMERA_FAR_MIN;
       this._camera.updateProjectionMatrix();
       return;
     }
     let maxCellZ = 0;
     let minCellZ = Infinity;
     for (const n of nodes) {
       if (n.cellZ > maxCellZ) maxCellZ = n.cellZ;
       if (n.cellZ < minCellZ) minCellZ = n.cellZ;
     }
     const newestZ = maxCellZ * CHUNK_SIZE + CHUNK_SIZE;
     this._maxCameraZ = newestZ + INITIAL_CAMERA_Z;
     // Keep the camera at least INITIAL_CAMERA_Z above the oldest bucket so
     // zooming in past the oldest photos can't fly the camera inside the
     // photo plane (which renders a blank scene).
     this._minCameraZ = Math.max(MIN_CAMERA_Z, minCellZ * CHUNK_SIZE + INITIAL_CAMERA_Z);
      const hallSpan = (maxCellZ - minCellZ + 4) * CHUNK_SIZE + INITIAL_CAMERA_Z;
      const far = Math.max(
        CAMERA_FAR_MIN,
        hallSpan,
        this._maxCameraZ + CHUNK_SIZE * (RENDER_DISTANCE + CHUNK_FADE_MARGIN + 1),
      );
     if (this._camera.far !== far) {
       this._camera.far = far;
       this._camera.updateProjectionMatrix();
     }
   }

  /** Corridor start: look down −Z at the newest time bucket. Wall fly is click-only. */
  private centerOnLayout(nodes: CanvasNode[]): void {
    this._lookYaw = 0;
    this._lookPitch = 0;
    this._yawFrom = 0;
    this._yawTo = 0;
    this._pitchFrom = 0;
    this._pitchTo = 0;
    if (nodes.length === 0) {
      this._camera.position.set(0, 0, INITIAL_CAMERA_Z);
      this._camera.rotation.set(0, 0, 0);
      this._basePos.set(0, 0, INITIAL_CAMERA_Z);
      return;
    }
    let maxBucket = 0;
    for (const n of nodes) {
      const b = Math.floor(n.cellZ / TIME_BUCKET_SPACING);
      if (b > maxBucket) maxBucket = b;
    }
    const targetZ = maxBucket * TIME_BUCKET_SPACING * CHUNK_SIZE + INITIAL_CAMERA_Z;
    this._camera.position.set(0, 0, targetZ);
    this._camera.rotation.set(0, 0, 0);
    this._basePos.set(0, 0, targetZ);
  }

  /**
   * Smoothly animate the camera's Z to `targetZ` (clamped to the current
   * depth bounds), centering X/Y at 0. Cancels any in-flight fly and clears
   * velocity so inertia from prior drag/wheel input doesn't fight the tween.
   * Use for the date-pill timeline navigation.
   */
  flyTo(targetZ: number): void {
    if (this._disposed) return;
    const clampedZ = Math.max(this._minCameraZ, Math.min(this._maxCameraZ, targetZ));
    const yaw = Math.abs(this._lookYaw) > 0.4 ? this._lookYaw : 0;
    const x = yaw !== 0 ? this._basePos.x : 0;
    this.beginFly(x, 0, clampedZ, 700, yaw);
  }

  flyToXYZ(x: number, y: number, z: number, durationMs = 700): void {
    if (this._disposed) return;
    const clampedZ = Math.max(this._minCameraZ, Math.min(this._maxCameraZ, z));
    this.beginFly(x, y, clampedZ, durationMs, this._lookYaw);
  }

  /**
   * Smoothly animate the camera to center on a specific node, panning X/Y
   * and zooming Z simultaneously. Computes the node's world position from its
   * chunk cell + local offset and targets a comfortable viewing distance.
   * Wall tiles rotate the camera to face the wall (~1.2s).
   */
  flyToNode(nodeId: string): void {
    if (this._disposed) return;
    const plane = this._chunkManager.findPlaneByNodeId(nodeId, this._basePos.z);
    const node = plane?.node ?? this._chunkManager.findLayoutNode(nodeId, this._basePos.z);
    if (!node) return;
    const worldX = node.cellX * CHUNK_SIZE + node.localX;
    const worldZ = node.cellZ * CHUNK_SIZE + node.localZ;
    const viewDist = this.viewDistForNode(node);
    const worldY = node.cellY * CHUNK_SIZE + node.localY;
    let targetX = worldX;
    let targetY = worldY;
    let targetZ = Math.max(this._minCameraZ, worldZ + INITIAL_CAMERA_Z * 0.5);
    let yawTo = 0;
    if (node.yaw != null && node.yaw !== 0) {
      targetX = worldX + Math.sign(node.yaw) * viewDist;
      targetY = worldY;
      targetZ = worldZ;
      yawTo = node.yaw;
    }
    this.beginFly(targetX, targetY, targetZ, 1600, yawTo, 0);
  }

  private viewDistForNode(node: CanvasNode): number {
    const vHalf = Math.tan((this._camera.fov * Math.PI) / 360);
    const aspect = Math.max(0.5, this._camera.aspect || 1);
    const w = Math.max(1, node.width);
    const h = Math.max(1, node.height);
    const distH = h / 2 / (vHalf * 0.82);
    const distW = w / 2 / (vHalf * aspect * 0.7);
    return Math.min(120, Math.max(28, Math.max(distH, distW)));
  }

  toggleInlineVideo(nodeId: string, url: string): void {
    if (this._disposed) return;
    const plane = this._chunkManager.findPlaneByNodeId(nodeId);
    if (!plane) return;
    if (this._playingVideoId === nodeId && plane.isPlayingInline) {
      plane.stopInline();
      this._playingVideoId = null;
      return;
    }
    this.stopInlineVideo();
    plane.playInline(url);
    this._playingVideoId = nodeId;
  }

  stopInlineVideo(): void {
    if (!this._playingVideoId) return;
    this._chunkManager.findPlaneByNodeId(this._playingVideoId)?.stopInline();
    this._playingVideoId = null;
  }

  /** Return to corridor view: look down −Z, x back to 0, keep current z. */
  resetLook(): void {
    if (this._disposed) return;
    this.stopInlineVideo();
    this.beginFly(0, 0, this._basePos.z, 1600, 0, 0);
  }

  dashAlongLook(): void {
    if (this._disposed) return;
    const dir = new THREE.Vector3();
    this._camera.getWorldDirection(dir);
    dir.y = 0;
    if (dir.lengthSq() < 1e-8) dir.set(0, 0, -1);
    dir.normalize();
    const dist = 560;
    const limit = this.hallInsideX();
    const x = Math.max(-limit, Math.min(limit, this._basePos.x + dir.x * dist));
    const z = Math.max(this._minCameraZ, Math.min(this._maxCameraZ, this._basePos.z + dir.z * dist));
    this.beginFly(x, this._basePos.y, z, 360, this._lookYaw, this._lookPitch);
  }

  private beginFly(x: number, y: number, z: number, durationMs: number, yawTo: number, pitchTo = 0): void {
    this._userMoved = true;
    this._flyFrom.copy(this._basePos);
    this._flyTo = new THREE.Vector3(x, y, z);
    this._yawFrom = this._lookYaw;
    this._yawTo = yawTo;
    this._pitchFrom = this._lookPitch;
    this._pitchTo = pitchTo;
    this._flyElapsed = 0;
    this._flyDuration = durationMs;
    this._velocity.set(0, 0, 0);
    this._targetVel.set(0, 0, 0);
    this._scrollAccum = 0;
    this._scrollMomentum = 1;
  }

  /** Cancels any active fly-to, leaving the camera wherever it currently sits. */
  cancelFly(): void {
    this._flyTo = null;
  }

  /** Advances the fly-to tween by `deltaMs`. Returns true while flying. */
  private tickFly(deltaMs: number): boolean {
    if (this._flyTo === null) return false;
    this._flyElapsed += deltaMs;
    const t = Math.min(1, this._flyElapsed / this._flyDuration);
    const eased = t * t * t * (t * (t * 6 - 15) + 10);
    this._basePos.x = this._flyFrom.x + (this._flyTo.x - this._flyFrom.x) * eased;
    this._basePos.y = this._flyFrom.y + (this._flyTo.y - this._flyFrom.y) * eased;
    this._basePos.z = this._flyFrom.z + (this._flyTo.z - this._flyFrom.z) * eased;
    this._lookYaw = this._yawFrom + (this._yawTo - this._yawFrom) * eased;
    this._lookPitch = this._pitchFrom + (this._pitchTo - this._pitchFrom) * eased;
    this.clampInsideHall();
    if (t >= 1) {
      this._flyTo = null;
      this._lookYaw = this._yawTo;
      this._lookPitch = this._pitchTo;
    }
    return true;
  }

  /** Begins the RAF loop. Safe to call once; idempotent if already running. */
  start(): void {
    if (this._running || this._disposed) return;
    this._running = true;
    this._rafId = requestAnimationFrame(this.onFrame);
  }

  /** Cancels the RAF loop. Idempotent. */
  stop(): void {
    this._running = false;
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = 0;
    }
  }

  /** Stops the loop, disposes chunks, renderer, geometry, and removes DOM. */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.stop();
    if (this._pendingClickTimer) {
      clearTimeout(this._pendingClickTimer);
      this._pendingClickTimer = null;
    }
    for (const w of this._vanishWaiters) {
      clearTimeout(w.timer);
      this.disposeSourceTextures(w.urls);
      w.resolve();
    }
    this._vanishWaiters = [];
    this._resizeObserver.disconnect();
    this.unbindEvents();
    this._chunkManager.dispose();
    this.disposeGalleryHall();
    this.disposeGlobe();
    this._sharedGeometry.dispose();
    this._renderer.dispose();
    if (this._renderer.domElement.parentNode === this._container) {
      this._container.removeChild(this._renderer.domElement);
    }
  }

  private disposeGalleryHall(): void {
    if (!this._hall) return;
    this._skyTime = null;
    this._scene.remove(this._hall);
    this._hall.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      mesh.geometry?.dispose();
      const mats = mesh.material
        ? Array.isArray(mesh.material)
          ? mesh.material
          : [mesh.material]
        : [];
      for (const m of mats) {
        const shaderMap = (m as THREE.ShaderMaterial).uniforms?.map?.value as THREE.Texture | undefined;
        if (shaderMap) shaderMap.dispose();
        else (m as THREE.MeshBasicMaterial).map?.dispose();
        m.dispose();
      }
    });
    this._hall = null;
  }

  private _makeCarpetTexture(repeatV: number): THREE.CanvasTexture {
    const w = 512;
    const h = 256;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const edge = ctx.createLinearGradient(0, 0, w, 0);
      edge.addColorStop(0, '#2a1214');
      edge.addColorStop(0.07, '#4a141c');
      edge.addColorStop(0.16, '#7a1c28');
      edge.addColorStop(0.5, '#962830');
      edge.addColorStop(0.84, '#7a1c28');
      edge.addColorStop(0.93, '#4a141c');
      edge.addColorStop(1, '#2a1214');
      ctx.fillStyle = edge;
      ctx.fillRect(0, 0, w, h);
      for (let x = 0; x < w; x++) {
        const t = x / w;
        const inPile = t > 0.09 && t < 0.91;
        const a = inPile ? 0.06 + (Math.sin(x * 0.85) * 0.5 + 0.5) * 0.09 : 0.14;
        ctx.fillStyle = `rgba(18,0,4,${a})`;
        ctx.fillRect(x, 0, 1, h);
      }
      for (let y = 0; y < h; y += 3) {
        ctx.fillStyle = 'rgba(255,72,82,0.04)';
        ctx.fillRect(Math.floor(w * 0.12), y, Math.floor(w * 0.76), 1);
      }
      const sheen = ctx.createLinearGradient(0, 0, w, 0);
      sheen.addColorStop(0.36, 'rgba(255,255,255,0)');
      sheen.addColorStop(0.5, 'rgba(255,196,186,0.08)');
      sheen.addColorStop(0.64, 'rgba(255,255,255,0)');
      ctx.fillStyle = sheen;
      ctx.fillRect(0, 0, w, h);
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1, repeatV);
    tex.anisotropy = 8;
    return tex;
  }

  private _makeStarField(
    wallX: number,
    len: number,
    ceilY: number,
    z0: number,
    skyTime: { value: number },
  ): THREE.Points {
    const count = Math.min(5500, Math.max(2200, Math.floor(len * 2.4)));
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const phases = new Float32Array(count);
    const speeds = new Float32Array(count);
    const rnd = (i: number) => {
      const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
      return x - Math.floor(x);
    };
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (rnd(i) * 2 - 1) * wallX * 0.98;
      positions[i * 3 + 1] = ceilY - 0.4 - rnd(i + 5) * 2.2;
      positions[i * 3 + 2] = z0 + rnd(i + 11) * len;
      const roll = rnd(i + 23);
      let r = 0.84;
      let g = 0.9;
      let b = 1;
      if (roll < 0.08) {
        r = 1;
        g = 0.84;
        b = 0.58;
      } else if (roll < 0.22) {
        r = 0.7;
        g = 0.84;
        b = 1;
      }
      const bright = 0.5 + rnd(i + 41) * 0.5;
      colors[i * 3] = r * bright;
      colors[i * 3 + 1] = g * bright;
      colors[i * 3 + 2] = b * bright;
      const mag = rnd(i + 59);
      sizes[i] = mag > 0.97 ? 9 : mag > 0.9 ? 5.4 : mag > 0.68 ? 3.1 : 1.65;
      phases[i] = rnd(i + 71);
      speeds[i] = 0.45 + rnd(i + 83) * 1.4;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
    geo.setAttribute('aSpeed', new THREE.BufferAttribute(speeds, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: skyTime,
        uPixelRatio: { value: Math.min(2, window.devicePixelRatio || 1) },
        uZ0: { value: z0 },
        uLen: { value: len },
      },
      vertexShader: `
        attribute float aSize;
        attribute float aPhase;
        attribute float aSpeed;
        uniform float uTime;
        uniform float uPixelRatio;
        uniform float uZ0;
        uniform float uLen;
        varying vec3 vColor;
        varying float vTw;
        varying float vSpike;
        varying float vFade;
        void main() {
          vColor = color;
          float tw = 0.64 + 0.36 * (0.5 + 0.5 * sin(uTime * (0.5 + aPhase * 1.55) + aPhase * 6.2831));
          vTw = tw;
          vSpike = step(7.5, aSize);
          vec3 pos = position;
          pos.z = uZ0 + mod(position.z - uZ0 + uTime * aSpeed, uLen);
          pos.x += sin(uTime * 0.03 + aPhase * 6.2831) * 1.1;
          vec4 mv = modelViewMatrix * vec4(pos, 1.0);
          gl_Position = projectionMatrix * mv;
          float dist = max(1.0, -mv.z);
          float ndc = length(gl_Position.xy / max(gl_Position.w, 0.0001));
          float vanish = 1.0 - smoothstep(0.04, 0.18, ndc);
          float far = smoothstep(280.0, 620.0, dist);
          vFade = 1.0 - vanish * far;
          vFade *= 1.0 - smoothstep(480.0, 820.0, dist);
          if (vFade < 0.03) {
            gl_PointSize = 0.0;
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            return;
          }
          gl_PointSize = min(aSize * tw * uPixelRatio * (220.0 / dist) * vFade, 14.0);
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        varying float vTw;
        varying float vSpike;
        varying float vFade;
        void main() {
          vec2 p = gl_PointCoord - 0.5;
          float d = length(p);
          float core = exp(-d * d * 38.0);
          float halo = exp(-d * d * 11.0) * 0.22;
          float ax = exp(-abs(p.x) * 30.0) * exp(-abs(p.y) * 2.6);
          float ay = exp(-abs(p.y) * 30.0) * exp(-abs(p.x) * 2.6);
          float spike = (ax + ay) * 0.5 * vSpike;
          float alpha = (core + halo + spike) * vTw * vFade * vFade;
          if (alpha < 0.012) discard;
          gl_FragColor = vec4(vColor * (0.72 + 0.5 * vTw), alpha);
        }
      `,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const points = new THREE.Points(geo, mat);
    points.name = 'galleryStars';
    points.frustumCulled = false;
    return points;
  }

  private updateGalleryHall(nodes: CanvasNode[]): void {
    this.disposeGalleryHall();
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const n of nodes) {
      if (!n.yaw) continue;
      const wz = n.cellZ * CHUNK_SIZE + n.localZ;
      if (wz < minZ) minZ = wz;
      if (wz > maxZ) maxZ = wz;
    }
    if (!Number.isFinite(minZ) || !Number.isFinite(maxZ)) return;

    const pad = CHUNK_SIZE * 3;
    const z0 = minZ - pad;
    const z1 = maxZ + pad;
    const len = Math.max(CHUNK_SIZE * 4, z1 - z0);
    const mid = (z0 + z1) / 2;
    const hallH = CHUNK_SIZE * 1.55;
    const wallX = CHUNK_SIZE * 1.5 + 6;

    const wallMat = new THREE.MeshBasicMaterial({
      color: 0x17140f,
      side: THREE.DoubleSide,
      fog: true,
    });
    const wallGeo = new THREE.PlaneGeometry(len, hallH);
    const left = new THREE.Mesh(wallGeo, wallMat);
    left.position.set(-wallX, 8, mid);
    left.rotation.y = Math.PI / 2;
    const right = new THREE.Mesh(wallGeo.clone(), wallMat.clone());
    right.position.set(wallX, 8, mid);
    right.rotation.y = -Math.PI / 2;

    const floorY = -hallH / 2 + 8;
    const ceilY = hallH / 2 + 8;
    const carpetTex = this._makeCarpetTexture(Math.max(4, len / 140));
    const floorMat = new THREE.MeshBasicMaterial({
      map: carpetTex,
      side: THREE.DoubleSide,
      fog: true,
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(wallX * 2, len), floorMat);
    floor.name = 'galleryFloor';
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, floorY, mid);

    const ceiling = new THREE.Mesh(
      new THREE.PlaneGeometry(wallX * 2, len),
      new THREE.MeshBasicMaterial({
        color: 0x08090c,
        side: THREE.DoubleSide,
        fog: true,
      }),
    );
    ceiling.name = 'galleryCeiling';
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.set(0, ceilY, mid);

    const skyTime = { value: 0 };
    this._skyTime = skyTime;
    const stars = this._makeStarField(wallX, len, ceilY, z0, skyTime);

    this._hall = new THREE.Group();
    this._hall.name = 'galleryHall';
    this._hall.add(left, right, floor, ceiling, stars);

    const days = new Map<string, { z: number; count: number; date: Date }>();
    for (const n of nodes) {
      if (n.kind !== 'photo' && n.kind !== 'video') continue;
      const p = n.properties ?? {};
      const hasExif = p.date_taken_friendly ?? p.datetime_original ?? p.date_taken ?? p.taken_at;
      if (hasExif == null || hasExif === '') continue;
      const d = parseNodeDate({ id: n.id, labels: n.labels, properties: n.properties });
      if (!d) continue;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const wz = n.cellZ * CHUNK_SIZE + n.localZ;
      const prev = days.get(key);
      if (prev) {
        prev.z += wz;
        prev.count += 1;
      } else {
        days.set(key, { z: wz, count: 1, date: d });
      }
    }
    const ticks = [...days.values()]
      .map((agg) => ({ z: agg.z / agg.count, date: agg.date }))
      .sort((a, b) => a.z - b.z);
    const minGap = 200;
    let lastZ = -Infinity;
    for (const tick of ticks) {
      if (tick.z - lastZ < minGap) continue;
      lastZ = tick.z;
      this._hall.add(this._makeFloorDateMarker(tick.date, tick.z, floorY, wallX));
    }

    this._scene.add(this._hall);
  }

  private _floorDateText(d: Date): string {
    const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    return `${months[d.getMonth()]} ${d.getDate()}  ·  ${d.getFullYear()}`;
  }

  private _makeFloorDateMarker(d: Date, z: number, floorY: number, _wallX: number): THREE.Group {
    const text = this._floorDateText(d);
    const canvas = document.createElement('canvas');
    canvas.width = 768;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    const group = new THREE.Group();
    if (ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = 'rgba(196,168,112,0.55)';
      ctx.font = '500 44px "Fraunces", Georgia, serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if ('letterSpacing' in ctx) {
        (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '0.16em';
      }
      ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      fog: true,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(42, 7), mat);
    mesh.position.set(0, floorY + 6, z);
    group.add(mesh);
    return group;
  }

  private createGlobe(): { root: THREE.Group; globe: THREE.LineSegments } {
    const root = new THREE.Group();
    root.position.set(0, GLOBE_Y, GLOBE_Z);
    root.name = 'globeRoot';

    const sphere = new THREE.SphereGeometry(GLOBE_RADIUS, 20, 12);
    const wire = new THREE.WireframeGeometry(sphere);
    sphere.dispose();
    const globeMat = new THREE.LineBasicMaterial({
      color: GLOBE_COLOR,
      transparent: true,
      opacity: 0.72,
      fog: true,
    });
    const globe = new THREE.LineSegments(wire, globeMat);
    globe.name = 'globe';
    globe.rotation.x = 0.35;
    const glowMat = new THREE.LineBasicMaterial({
      color: GLOBE_COLOR,
      transparent: true,
      opacity: 0.22,
      fog: true,
    });
    const glow = new THREE.LineSegments(wire.clone(), glowMat);
    glow.name = 'globeGlow';
    glow.scale.setScalar(1.045);
    root.add(glow);
    root.add(globe);

    const ringY = -(GLOBE_RADIUS + 6);
    for (const [inner, outer, opacity] of FLOOR_RINGS) {
      const geo = new THREE.RingGeometry(inner, outer, 64, 1);
      const mat = new THREE.MeshBasicMaterial({
        color: GLOBE_COLOR,
        transparent: true,
        opacity,
        side: THREE.DoubleSide,
        depthWrite: false,
        fog: true,
      });
      const ring = new THREE.Mesh(geo, mat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = ringY;
      ring.name = 'globeFloorRing';
      root.add(ring);
    }

    return { root, globe };
  }

  private disposeGlobe(): void {
    this._scene.remove(this._globeRoot);
    this._globeRoot.traverse((obj) => {
      const mesh = obj as THREE.Mesh | THREE.LineSegments;
      mesh.geometry?.dispose();
      const mat = mesh.material;
      if (Array.isArray(mat)) {
        for (const m of mat) m.dispose();
      } else {
        mat?.dispose();
      }
    });
  }

  /** Resizes renderer + camera aspect to the current container size. */
  private onResize(): void {
    if (this._disposed) return;
    const width = this._container.clientWidth || 1;
    const height = this._container.clientHeight || 1;
    this._renderer.setSize(width, height);
    this._camera.aspect = width / height;
    this._camera.updateProjectionMatrix();
  }

  /** RAF callback — applies input, updates chunks, renders. */
  private readonly onFrame = (): void => {
    if (!this._running || this._disposed) return;
    this._rafId = requestAnimationFrame(this.onFrame);
    if (!this._visible) {
      this.tickVanish();
      return;
    }

    const now = performance.now();
    const deltaMs = this._lastFrameMs ? Math.min(64, now - this._lastFrameMs) : 16;
    this._lastFrameMs = now;

    if (this.tickFly(deltaMs)) {
      this._drift.set(0, 0);
    } else {
      this.applyKeyboard();
      this.applyVelocity();
      this.applyDrift();
    }

    // Compose final camera position from basePos + drift. Chunk/fade logic
    // uses basePos only so mouse parallax never triggers remounts or pop-in.
    this._camera.position.set(
      this._basePos.x + this._drift.x,
      this._basePos.y + this._drift.y,
      this._basePos.z,
    );
    this._camera.rotation.set(this._lookPitch, this._lookYaw, 0);

    if (this._skyTime) this._skyTime.value = now * 0.001;

    this._globe.rotation.y += GLOBE_SPIN * (deltaMs / 1000);
    const glow = this._globeRoot.getObjectByName('globeGlow');
    if (glow) glow.rotation.y = this._globe.rotation.y;

    const velMag = this._velocity.length();
    this._chunkManager.update(this._basePos, velMag);
    this.tickVanish();

    const cx = Math.floor(this._basePos.x / CHUNK_SIZE);
    const cy = Math.floor(this._basePos.y / CHUNK_SIZE);
    const cz = Math.floor(this._basePos.z / CHUNK_SIZE);
    if (cx !== this._lastChunkX || cy !== this._lastChunkY || cz !== this._lastChunkZ) {
      this._lastChunkX = cx;
      this._lastChunkY = cy;
      this._lastChunkZ = cz;
      this.onChunkChange?.(cx, cy, cz);
    }
    if (this.onCameraZ && Math.abs(this._basePos.z - this._lastReportedZ) >= 8) {
      this._lastReportedZ = this._basePos.z;
      this.onCameraZ(this._basePos.z);
    }

    this._renderer.render(this._scene, this._camera);
  };

  /**
   * Screen-proportional pan scale. Camera Z is the time axis, not zoom, so
   * we must not multiply drag by `basePos.z` (that makes pan explode on
   * recent months and fly the camera into a wall — which reads as zoom).
   */
  private panScale(): number {
    const yaw = this._lookYaw;
    const dist = Math.abs(yaw) > 0.4
      ? Math.max(40, Math.abs(Math.abs(this._basePos.x) - CHUNK_SIZE * 1.5))
      : INITIAL_CAMERA_Z;
    return Math.max(0.5, Math.min(16, dist / ZOOM_FACTOR_DIVISOR));
  }

  private applyLookDelta(dx: number, dy: number): void {
    this._lookYaw -= dx * 0.0026;
    if (this._lookYaw > Math.PI) this._lookYaw -= Math.PI * 2;
    if (this._lookYaw < -Math.PI) this._lookYaw += Math.PI * 2;
    this._lookPitch -= dy * 0.002;
    if (this._lookPitch > 0.7) this._lookPitch = 0.7;
    if (this._lookPitch < -0.7) this._lookPitch = -0.7;
    this._userMoved = true;
  }

  private applyZoomDelta(delta: number): void {
    const scale = this.panScale();
    const mag = delta * ZOOM_FACTOR * 8 * scale * this._pinchSensitivity;
    const alongView = Math.cos(this._lookYaw) < 0 ? -mag : mag;
    this._basePos.z += alongView;
    if (this._basePos.z < this._minCameraZ) this._basePos.z = this._minCameraZ;
    if (this._basePos.z > this._maxCameraZ) this._basePos.z = this._maxCameraZ;
    this._userMoved = true;
  }

  private applyFovZoom(delta: number): void {
    const next = this._camera.fov + delta * 0.035 * this._pinchSensitivity;
    this._camera.fov = Math.max(28, Math.min(72, next));
    this._camera.updateProjectionMatrix();
    this._userMoved = true;
  }

  private hallInsideX(): number {
    return CHUNK_SIZE * 1.5 + 6 - 18;
  }

  private clampInsideHall(): void {
    const limit = this.hallInsideX();
    if (this._basePos.x > limit) {
      this._basePos.x += (limit - this._basePos.x) * 0.28;
      this._velocity.x *= 0.45;
      if (this._targetVel.x > 0) this._targetVel.x = 0;
    } else if (this._basePos.x < -limit) {
      this._basePos.x += (-limit - this._basePos.x) * 0.28;
      this._velocity.x *= 0.45;
      if (this._targetVel.x < 0) this._targetVel.x = 0;
    }
  }

  /** Applies held keyboard keys to the velocity vector. */
  private applyKeyboard(): void {
    const k = this._keys;
    let moved = false;
    const walk = KEYBOARD_SPEED * 2.4;
    const yaw = this._lookYaw;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    if (k.has('ArrowLeft') || k.has('a') || k.has('A')) {
      this._targetVel.x -= rx * walk;
      this._targetVel.z -= rz * walk;
      moved = true;
    }
    if (k.has('ArrowRight') || k.has('d') || k.has('D')) {
      this._targetVel.x += rx * walk;
      this._targetVel.z += rz * walk;
      moved = true;
    }
    if (k.has('ArrowUp') || k.has('w') || k.has('W')) {
      this._targetVel.x += fx * walk;
      this._targetVel.z += fz * walk;
      moved = true;
    }
    if (k.has('ArrowDown') || k.has('s') || k.has('S')) {
      this._targetVel.x -= fx * walk;
      this._targetVel.z -= fz * walk;
      moved = true;
    }
    if (moved) {
      this._userMoved = true;
      this.cancelFly();
    }
  }

  /** Integrates targetVel + scrollAccum into velocity, then velocity into basePos. */
  private applyVelocity(): void {
    this._targetVel.z += this._scrollAccum;
    this._scrollAccum *= SCROLL_DECAY;
    this._scrollMomentum = 1 + (this._scrollMomentum - 1) * SCROLL_MOMENTUM_DECAY;
    if (this._scrollMomentum < 1.01) this._scrollMomentum = 1;

    this._targetVel.clampLength(0, MAX_VELOCITY);

    this._velocity.x = this._velocity.x + (this._targetVel.x - this._velocity.x) * VELOCITY_LERP;
    this._velocity.y = this._velocity.y + (this._targetVel.y - this._velocity.y) * VELOCITY_LERP;
    this._velocity.z = this._velocity.z + (this._targetVel.z - this._velocity.z) * VELOCITY_LERP;

    this._basePos.x += this._velocity.x;
    this._basePos.y += this._velocity.y;
    this._basePos.z += this._velocity.z;

    this.clampInsideHall();
    if (this._basePos.y > 80) this._basePos.y = 80;
    if (this._basePos.y < -80) this._basePos.y = -80;

    if (this._basePos.z < this._minCameraZ) this._basePos.z = this._minCameraZ;
    if (this._basePos.z > this._maxCameraZ) this._basePos.z = this._maxCameraZ;
    if (this._pinchActive && this._pinchMinZ !== null && this._pinchMaxZ !== null) {
      if (this._basePos.z < this._pinchMinZ) this._basePos.z = this._pinchMinZ;
      if (this._basePos.z > this._pinchMaxZ) this._basePos.z = this._pinchMaxZ;
    }

    this._targetVel.multiplyScalar(VELOCITY_DECAY);
    if (this._targetVel.lengthSq() < 1e-6) this._targetVel.set(0, 0, 0);
  }

  /** Decays leftover camera drift toward origin. No mouse parallax. */
  private applyDrift(): void {
    if (this._pointer.down || this._pinchActive) {
      return;
    }
    if (Math.abs(this._lookYaw) > 0.2) {
      this._drift.set(0, 0);
      return;
    }
    const isZooming = Math.abs(this._velocity.z) > ZOOMING_VEL_THRESHOLD;
    const lerpFactor = isZooming ? DRIFT_LERP_ZOOMING : DRIFT_LERP;
    this._drift.x = this._drift.x + (0 - this._drift.x) * lerpFactor;
    this._drift.y = this._drift.y + (0 - this._drift.y) * lerpFactor;
  }

  // --- input handlers --------------------------------------------------

  private onKeyDown = (e: KeyboardEvent): void => {
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    this._keys.add(e.key);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    this._keys.delete(e.key);
  };

  private onPointerDown = (e: PointerEvent): void => {
    this.cancelFly();
    this._pointer.down = true;
    this._pointer.isTouch = e.pointerType === 'touch';
    this._pointer.lastX = e.clientX;
    this._pointer.lastY = e.clientY;
    this._pointer.downStartX = e.clientX;
    this._pointer.downStartY = e.clientY;
    this._pointer.dragged = false;
    try {
      this._renderer.domElement.setPointerCapture(e.pointerId);
    } catch {}
    this._userMoved = true;
    this.updateCursor();
  };

  private onPointerMove = (e: PointerEvent): void => {
    const rect = this._renderer.domElement.getBoundingClientRect();
    this._mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this._mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    if (e.pointerType === 'touch') {
      if (this._pointer.down && !this._pinchActive) {
        const dx = e.clientX - this._pointer.lastX;
        const dy = e.clientY - this._pointer.lastY;
        this._pointer.lastX = e.clientX;
        this._pointer.lastY = e.clientY;
        if (Math.hypot(e.clientX - this._pointer.downStartX, e.clientY - this._pointer.downStartY) > 5) {
          this._pointer.dragged = true;
        }
        this.applyLookDelta(dx, dy);
      }
      return;
    }

    if (this._pointer.down) {
      const dx = e.clientX - this._pointer.lastX;
      const dy = e.clientY - this._pointer.lastY;
      this._pointer.lastX = e.clientX;
      this._pointer.lastY = e.clientY;
      if (Math.hypot(e.clientX - this._pointer.downStartX, e.clientY - this._pointer.downStartY) > 5) {
        this._pointer.dragged = true;
      }
      this.applyLookDelta(dx, dy);
      this.updateCursor();
    } else {
      this.hoverRaycast(e);
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (this._renderer.domElement.hasPointerCapture?.(e.pointerId)) {
      try {
        this._renderer.domElement.releasePointerCapture(e.pointerId);
      } catch {}
    }
    if (e.pointerType === 'touch') {
      if (this._pointer.down && !this._pointer.dragged) {
        // Don't let GraphPage treat a conversation tap as a background dismiss.
        // The actual select is delayed for double-tap detection.
        if (this.isConversationHit(this.raycast(e))) e.stopPropagation();
        this.detectDoubleTap(e.clientX, e.clientY);
      }
      this._pointer.down = false;
      this.updateCursor();
      return;
    }
    if (this._pointer.down && !this._pointer.dragged) {
      const hit = this.clickRaycast(e);
      if (this.isConversationHit(hit)) e.stopPropagation();
    }
    this._pointer.down = false;
    this.updateCursor();
  };

  private detectDoubleTap(x: number, y: number): void {
    const now = performance.now();
    const TAP_GAP = 300;
    const TAP_RADIUS = 30;
    const isDoubleTap =
      now - this._lastTapTime < TAP_GAP &&
      Math.hypot(x - this._lastTapX, y - this._lastTapY) < TAP_RADIUS;
    this._lastTapTime = now;
    this._lastTapX = x;
    this._lastTapY = y;

    if (!isDoubleTap) {
      this._pendingClickX = x;
      this._pendingClickY = y;
      if (this._pendingClickTimer) clearTimeout(this._pendingClickTimer);
      this._pendingClickTimer = setTimeout(() => {
        this._pendingClickTimer = null;
        this.clickRaycastAt(this._pendingClickX, this._pendingClickY);
      }, TAP_GAP);
      return;
    }

    if (this._pendingClickTimer) {
      clearTimeout(this._pendingClickTimer);
      this._pendingClickTimer = null;
    }
    this._lastTapTime = 0;
    this.onDoubleTap?.(x, y);
  }

  /** Called by svelte-gestures when a pinch-to-zoom gesture starts. */
  handlePinchStart(): void {
    this._pinchActive = true;
    this._pointer.dragged = true;
    this._userMoved = true;
    this.cancelFly();
  }

  /** Called by svelte-gestures on each pinch scale change. */
  handlePinchMove(scaleDelta: number): void {
    if (!this._pinchActive) return;
    this.applyFovZoom(scaleDelta);
  }

  /** Called by svelte-gestures when the pinch gesture ends. */
  handlePinchEnd(): void {
    this._pinchActive = false;
  }

  /** Called by svelte-gestures on single-finger touch pan. */
  handleTouchPan(dx: number, dy: number): void {
    this.applyLookDelta(dx, dy);
  }

  /** Overlay cards sit above the canvas; forward their wheel/pinch here. */
  handleWheel(e: WheelEvent): void {
    this.onWheel(e);
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.cancelFly();
    if (e.ctrlKey) this.applyFovZoom(e.deltaY);
    else this.applyZoomDelta(e.deltaY);
    this._pointer.dragged = true;
    this._userMoved = true;
  };

  /**
   * Raycasts from pointer NDC into the mounted chunk meshes and fires
   * `onHoverNode` with the hit node id (or null). Throttled to ~30Hz.
   */
  private hoverRaycast(e: PointerEvent): void {
    const now = performance.now();
    if (now - this._lastHoverTime < 33) return;
    this._lastHoverTime = now;
    const hit = this.raycast(e);
    const id = hit ?? null;
    if (id !== this._hoveredNodeId) {
      if (this._hoveredNodeId !== null) {
        this._chunkManager.findPlaneByNodeId(this._hoveredNodeId)?.setHovered(false);
      }
      this._hoveredNodeId = id;
      if (id !== null) {
        this._chunkManager.findPlaneByNodeId(id)?.setHovered(true);
      }
      this.updateCursor();
    }
    this.onHoverNode?.(id);
  }

  /** Raycasts on click and fires `onSelectNode` with the hit id (or null). */
  private clickRaycast(e: PointerEvent): string | undefined {
    return this.clickRaycastAt(e.clientX, e.clientY);
  }

  private clickRaycastAt(clientX: number, clientY: number): string | undefined {
    const hit = this.raycastAt(clientX, clientY);
    this.onSelectNode?.(hit ?? null);
    return hit;
  }

  private isConversationHit(nodeId: string | undefined | null): boolean {
    return !!nodeId && this.getCanvasNode(nodeId)?.kind === 'conversation';
  }

  private raycastAt(clientX: number, clientY: number): string | undefined {
    const rect = this._renderer.domElement.getBoundingClientRect();
    this._pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this._pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this._raycaster.setFromCamera(this._pointerNdc, this._camera);
    const meshes = this._chunkManager.getPickableMeshes();
    if (meshes.length === 0) return undefined;
    const hits = this._raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return undefined;
    const nodeId = hits[0].object.userData.nodeId;
    return typeof nodeId === 'string' ? nodeId : undefined;
  }

  /**
   * Converts a pointer event to NDC and raycasts against the mounted chunk
   * meshes. Returns the hit node id, or `undefined` on no hit.
   */
  private raycast(e: PointerEvent): string | undefined {
    return this.raycastAt(e.clientX, e.clientY);
  }

  private onContextLoss = (): void => {
    console.warn('[SceneManager] WebGL context lost — stopping RAF loop.');
    this.stop();
  };

  private onDoubleClick = (e: MouseEvent): void => {
    this.onDoubleTap?.(e.clientX, e.clientY);
  };

  private onVisibilityChange = (): void => {
    this._visible = document.visibilityState === 'visible';
    if (this._visible && this._running && !this._rafId) {
      this._rafId = requestAnimationFrame(this.onFrame);
    }
  };

  /** Updates the canvas cursor based on interaction state. */
  private updateCursor(): void {
    let mode: 'idle' | 'grabbing' | 'pointer';
    if (this._pointer.down) {
      mode = 'grabbing';
    } else if (this._hoveredNodeId !== null) {
      mode = 'pointer';
    } else {
      mode = 'idle';
    }
    if (mode === this._cursorMode) return;
    this._cursorMode = mode;
    const el = this._renderer.domElement;
    if (mode === 'grabbing') el.style.cursor = 'grabbing';
    else if (mode === 'pointer') el.style.cursor = 'pointer';
    else el.style.cursor = 'grab';
  }

  private bindEvents(): void {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    const el = this._renderer.domElement;
    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener('pointermove', this.onPointerMove);
    el.addEventListener('pointerup', this.onPointerUp);
    el.addEventListener('pointercancel', this.onPointerUp);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('dblclick', this.onDoubleClick);
    el.addEventListener('webglcontextlost', this.onContextLoss);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  private unbindEvents(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    const el = this._renderer.domElement;
    el.removeEventListener('pointerdown', this.onPointerDown);
    el.removeEventListener('pointermove', this.onPointerMove);
    el.removeEventListener('pointerup', this.onPointerUp);
    el.removeEventListener('pointercancel', this.onPointerUp);
    el.removeEventListener('wheel', this.onWheel);
    el.removeEventListener('dblclick', this.onDoubleClick);
    el.removeEventListener('webglcontextlost', this.onContextLoss);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
  }
}