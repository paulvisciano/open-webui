/**
 * `NodePlane` — a single node rendered as a 3D plane on the infinite canvas.
 *
 * Wraps a `THREE.Mesh` sharing a global 1×1 `PlaneGeometry` (scaled per node),
 * a `MeshBasicMaterial` with per-frame opacity fade, and the texture-LOD
 * wiring for photo nodes (via the shared `textureCache`). Non-photo nodes get
 * a flat colored material for Phase 1; label text is Phase 2.
 */
import * as THREE from 'three';
import { textureCache } from '../services/TextureCache';
import {
  CHUNK_FADE_MARGIN,
  CHUNK_SIZE,
  DEPTH_FADE_END,
  DEPTH_FADE_START,
  HALL_DEPTH_FADE_END,
  HALL_DEPTH_FADE_START,
  HALL_RENDER_DISTANCE_Z,
  INVIS_THRESHOLD,
  SEARCH_DIM,
  LOD_FULL_CHEBY,
  LOD_FULL_DEPTH,
  LOD_FULL_DEPTH_HYSTERESIS,
  LOD_HYSTERESIS,
  RENDER_DISTANCE,
  VANISH_DURATION_MS,
} from './constants';
import { getProvider } from './NodeKindProvider';
import './providers'; // side-effect: registers all providers so getProvider works
import type { CanvasNode } from './types';
import { searchHighlight } from './search-highlight-flag';
import { isSearchMatch } from '../search-match';

/** Lerp factor for smoothing current opacity toward the per-frame target. */
const OPACITY_LERP = 0.18;

/**
 * Brand typography — paulvisciano.com.
 * Canvas `ctx.font` requires literal family strings (no CSS variables).
 */
const FONT_DISPLAY = '"Fraunces", "Iowan Old Style", Georgia, serif';
const FONT_BODY = '"Inter", -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
const FONT_MONO = '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace';

const CYAN_ACCENT = '#13dcf6';
const CYAN_CYBER = '#00d4ff';
const GLASS_BG = '#0b1220';
const GLASS_BORDER = 'rgba(0,212,255,0.55)';
const GLASS_RING = 'rgba(19,220,246,0.22)';
const GLASS_GLOW = 'rgba(0,212,255,0.28)';

/**
 * Renders one `CanvasNode` as a textured/colored plane on the canvas.
 *
 * The mesh is positioned at `chunkOrigin + (localX, localY, localZ)` and
 * scaled to `(node.width, node.height, 1)` against the shared 1×1 geometry.
 * Photo nodes load their thumbnail through `textureCache`; non-photo nodes
 * use a flat colored material.
 */
export class NodePlane {
  private _node: CanvasNode;
  private readonly _mesh: THREE.Mesh;
  private readonly _material: THREE.MeshBasicMaterial;
  /** Start at 0 so remount / first spawn lerps in via `OPACITY_LERP`. */
  private _currentOpacity = 0;
  private _disposed = false;
  private _vanishing = false;
  private _vanishStartMs = 0;
  private _vanishFrom = 0;
  private _currentLod: 'thumb' | 'full' = 'thumb';
  private _fullUrl?: string;
  private _thumbUrl?: string;
  private _fullEvictCb?: () => void;
  /** Whether LOD thumb→full promotion is enabled (from planeConfig). */
  private _lodEnabled = false;
  private _thumbRequested = false;
  /** Locally-baked text texture for text-source nodes (NOT routed through `textureCache`). */
  private _noteTexture?: THREE.CanvasTexture;
  private _hoverTexture?: THREE.CanvasTexture;
  private _hovered = false;
  private _inlineVideo: HTMLVideoElement | null = null;
  private _videoTexture: THREE.VideoTexture | null = null;
  private _stillMap: THREE.Texture | null = null;
  private _roundMask: THREE.CanvasTexture | null = null;

  /**
   * @param node - the canvas node to render.
   * @param sharedGeometry - the global 1×1 `PlaneGeometry` (shared, not owned).
   */
  constructor(node: CanvasNode, sharedGeometry: THREE.PlaneGeometry) {
    this._node = node;
    const provider = getProvider(this._node.kind);
    const planeConfig = provider?.planeConfig;
    this._material = new THREE.MeshBasicMaterial({
      color: planeConfig?.color ?? 0xb57bff,
      transparent: true,
      depthWrite: true,
      side: THREE.DoubleSide,
    });
    this._mesh = new THREE.Mesh(sharedGeometry, this._material);
    this._applyPose(node);
    this._material.opacity = 0;
    this._mesh.visible = false;
    this._material.depthWrite = false;

    this._lodEnabled = planeConfig?.lodEnabled ?? false;

    const textureSource = planeConfig?.textureSource ?? 'none';
    if (textureSource === 'url' && node.imageUrl) {
      this._thumbUrl = node.imageUrl;
      this._fullUrl = node.fullUrl;
    } else if (textureSource === 'text' && node.textContent) {
      this._bakeTextTextures();
    }
  }

  /** The plane mesh — added to a chunk `THREE.Group` by `Chunk`. */
  get mesh(): THREE.Mesh {
    return this._mesh;
  }

  /** The canvas node this plane renders. */
  get node(): CanvasNode {
    return this._node;
  }

  get disposed(): boolean {
    return this._disposed;
  }

  get vanishing(): boolean {
    return this._vanishing;
  }

  /** True once a vanish lerp has reached `INVIS_THRESHOLD` (or the plane was disposed). */
  get isVanished(): boolean {
    return this._vanishing && (this._disposed || this._currentOpacity < INVIS_THRESHOLD);
  }

  /** Thumb + full URLs this plane loaded through `textureCache` (empty for text/flat). */
  get textureUrls(): string[] {
    const urls: string[] = [];
    if (this._thumbUrl) urls.push(this._thumbUrl);
    if (this._fullUrl) urls.push(this._fullUrl);
    return urls;
  }

  /**
   * Start a source-offline fade. `updateFade` then drives mesh opacity to 0
   * over `VANISH_DURATION_MS` with ease-out cubic (not CSS).
   */
  beginVanish(): void {
    if (this._disposed || this._vanishing) return;
    this._vanishing = true;
    this._vanishStartMs = performance.now();
    this._vanishFrom = this._currentOpacity;
  }

  /**
   * Keep a reused plane in sync with a new layout node. Conversations
   * rebake their plaque when title/status changes so the wall updates
   * without disposing the mesh (which would fade in from 0).
   */
  syncFrom(node: CanvasNode): void {
    if (this._disposed) return;
    const prevKey = this._contentKey(this._node);
    this._node = node;
    this._applyPose(node);
    if (node.kind === 'conversation' && prevKey !== this._contentKey(node)) {
      this._bakeTextTextures();
    }
  }

  setHovered(hovered: boolean): void {
    if (this._hovered === hovered) return;
    this._hovered = hovered;
    if (this._hoverTexture && this._noteTexture) {
      this._material.map = hovered ? this._hoverTexture : this._noteTexture;
      this._material.needsUpdate = true;
    }
  }

  /**
   * Per-frame fade update. Computes the Chebyshev distance from the camera
   * chunk to this node's chunk, derives a target opacity (1 inside
   * `RENDER_DISTANCE`, a ramp out to the fade margin, 0 beyond), lerps the
   * current opacity toward it, and toggles `mesh.visible` /
   * `material.depthWrite` based on `INVIS_THRESHOLD` and the depth fade.
   *
   * @param cameraPos - current camera world position.
   * @param chunkOrigin - world-space origin of the owning chunk.
   */
  updateFade(cameraPos: THREE.Vector3, chunkOrigin: THREE.Vector3): void {
    if (this._disposed) return;
    if (this._videoTexture) this._videoTexture.needsUpdate = true;

    if (this._vanishing) {
      const t = Math.min(1, (performance.now() - this._vanishStartMs) / VANISH_DURATION_MS);
      const eased = 1 - (1 - t) ** 3;
      this._currentOpacity = this._vanishFrom * (1 - eased);
      if (this._currentOpacity < INVIS_THRESHOLD) {
        this._currentOpacity = 0;
        this._mesh.visible = false;
        this._material.depthWrite = false;
      } else {
        this._mesh.visible = true;
        this._material.depthWrite = false;
      }
      this._material.opacity = this._currentOpacity;
      this._material.needsUpdate = true;
      return;
    }

    const worldPos = this._mesh.position;
    const nodeWorldX = chunkOrigin.x + worldPos.x;
    const nodeWorldY = chunkOrigin.y + worldPos.y;
    const nodeWorldZ = chunkOrigin.z + worldPos.z;

    // Facing one wall puts the other behind the camera. DoubleSide planes plus
    // a far clip of thousands of units let those back-facing tiles ghost on
    // top of the wall you are looking at.
    if (Math.abs(cameraPos.x) > 40 && Math.abs(nodeWorldX) > 150
      && Math.sign(cameraPos.x) !== Math.sign(nodeWorldX)) {
      this._mesh.visible = false;
      this._material.depthWrite = false;
      return;
    }

    const camChunkX = Math.floor(cameraPos.x / CHUNK_SIZE);
    const camChunkY = Math.floor(cameraPos.y / CHUNK_SIZE);
    const camChunkZ = Math.floor(cameraPos.z / CHUNK_SIZE);

    const nodeChunkX = Math.floor(nodeWorldX / CHUNK_SIZE);
    const nodeChunkY = Math.floor(nodeWorldY / CHUNK_SIZE);
    const nodeChunkZ = Math.floor(nodeWorldZ / CHUNK_SIZE);

    const cheby = Math.max(
      Math.abs(nodeChunkX - camChunkX),
      Math.abs(nodeChunkY - camChunkY),
      Math.abs(nodeChunkZ - camChunkZ),
    );

    const onWall = this._node.yaw != null && this._node.yaw !== 0;
    const renderDist = onWall ? HALL_RENDER_DISTANCE_Z : RENDER_DISTANCE;
    const fadeStart = onWall ? HALL_DEPTH_FADE_START : DEPTH_FADE_START;
    const fadeEnd = onWall ? HALL_DEPTH_FADE_END : DEPTH_FADE_END;

    const gridFade =
      cheby <= renderDist
        ? 1
        : Math.max(0, 1 - (cheby - renderDist) / Math.max(CHUNK_FADE_MARGIN, 0.0001));

    const absDepth = Math.abs(cameraPos.z - nodeWorldZ);
    const depthFade =
      absDepth <= fadeStart
        ? 1
        : Math.max(0, 1 - (absDepth - fadeStart) / Math.max(fadeEnd - fadeStart, 0.0001));

    let targetOpacity = Math.min(gridFade, onWall ? depthFade : depthFade * depthFade);
    const matchIds = searchHighlight.matchIds;
    if (matchIds !== null && !isSearchMatch(matchIds, this._node.id)) {
      targetOpacity *= SEARCH_DIM;
    }

    this._currentOpacity += (targetOpacity - this._currentOpacity) * OPACITY_LERP;

    if (this._currentOpacity < INVIS_THRESHOLD) {
      this._mesh.visible = false;
      this._material.depthWrite = false;
    } else {
      this._mesh.visible = true;
      this._material.depthWrite = absDepth <= DEPTH_FADE_START;
    }
    this._material.opacity = this._currentOpacity;
    this._material.needsUpdate = true;

    if (this._mesh.visible && targetOpacity > 0.05) {
      this._requestThumbIfNeeded();
    }
  }

  private _requestThumbIfNeeded(): void {
    if (this._thumbRequested || this._disposed || !this._thumbUrl) return;
    this._thumbRequested = true;
    textureCache.load(this._thumbUrl, (t) => this.applyTexture(t));
  }

  /**
   * Applies a texture (from `textureCache`) to the material. The texture's
   * color space is assumed already set by the cache; we only wire it in.
   *
   * @param texture - the loaded texture.
   */
  applyTexture(texture: THREE.Texture): void {
    if (this._disposed) return;
    const imgSize = this._imageSize(texture);
    if (imgSize && (this._node.kind === 'photo' || this._node.kind === 'video')) {
      this._fitNaturalAspect(imgSize.w, imgSize.h);
    }
    if (this._node.kind === 'video' || this._node.kind === 'photo') {
      try {
        const baked = this._createMediaCaptionTexture(
          texture,
          this._currentLod !== 'full',
        );
        if (this._noteTexture && this._noteTexture !== baked) {
          this._noteTexture.dispose();
        }
        this._noteTexture = baked;
        this._material.map = baked;
        if (this._node.kind === 'video' || this._node.kind === 'photo') {
          this._material.transparent = true;
          this._material.alphaTest = 0;
          if (!this._inlineVideo) this._material.alphaMap = null;
        }
      } catch {
        this._material.map = texture;
        if (this._node.kind === 'video' || this._node.kind === 'photo') this._applyRoundMask();
      }
    } else {
      this._material.map = texture;
    }
    this._material.color.setHex(0xffffff);
    this._material.needsUpdate = true;
  }

  updateLod(cameraPos: THREE.Vector3, chunkOrigin: THREE.Vector3): void {
    if (this._disposed || this._vanishing || !this._mesh.visible) return;
    if (!this._lodEnabled || !this._thumbUrl) return;
    if (!this._fullUrl) return;

    const worldPos = this._mesh.position;
    const nodeWorldX = chunkOrigin.x + worldPos.x;
    const nodeWorldY = chunkOrigin.y + worldPos.y;
    const nodeWorldZ = chunkOrigin.z + worldPos.z;

    const camChunkX = Math.floor(cameraPos.x / CHUNK_SIZE);
    const camChunkY = Math.floor(cameraPos.y / CHUNK_SIZE);
    const camChunkZ = Math.floor(cameraPos.z / CHUNK_SIZE);

    const nodeChunkX = Math.floor(nodeWorldX / CHUNK_SIZE);
    const nodeChunkY = Math.floor(nodeWorldY / CHUNK_SIZE);
    const nodeChunkZ = Math.floor(nodeWorldZ / CHUNK_SIZE);

    const cheby = Math.max(
      Math.abs(nodeChunkX - camChunkX),
      Math.abs(nodeChunkY - camChunkY),
      Math.abs(nodeChunkZ - camChunkZ),
    );
    const absDepth = Math.hypot(
      cameraPos.x - nodeWorldX,
      cameraPos.y - nodeWorldY,
      cameraPos.z - nodeWorldZ,
    );

    const demoteThreshold = LOD_FULL_CHEBY + LOD_HYSTERESIS;
    const demoteDepth = LOD_FULL_DEPTH + LOD_FULL_DEPTH_HYSTERESIS;
    const shouldFull = cheby <= LOD_FULL_CHEBY && absDepth <= LOD_FULL_DEPTH;
    const shouldThumb = cheby > demoteThreshold || absDepth > demoteDepth;

    if (this._currentLod === 'thumb' && shouldFull) {
      this._promoteToFull();
    } else if (this._currentLod === 'full' && shouldThumb) {
      this._demoteToThumb();
    }
  }

  private _promoteToFull(): void {
    if (!this._fullUrl) return;
    this._currentLod = 'full';
    const onEvicted = () => {
      this._currentLod = 'thumb';
      this._fullEvictCb = undefined;
      const thumb = this._thumbUrl ? textureCache.get(this._thumbUrl) : undefined;
      if (thumb) this.applyTexture(thumb);
    };
    this._fullEvictCb = onEvicted;
    textureCache.requestFullRes(this._fullUrl, (t) => this.applyTexture(t), onEvicted);
  }

  private _demoteToThumb(): void {
    this._currentLod = 'thumb';
    if (this._fullUrl && this._fullEvictCb) {
      textureCache.releaseFullRes(this._fullUrl, this._fullEvictCb);
      this._fullEvictCb = undefined;
    }
    const thumb = this._thumbUrl ? textureCache.get(this._thumbUrl) : undefined;
    if (thumb) this.applyTexture(thumb);
  }

  get isPlayingInline(): boolean {
    return !!this._inlineVideo && !this._inlineVideo.paused;
  }

  keepMuted(): void {
    if (!this._inlineVideo) return;
    this._inlineVideo.muted = true;
    this._inlineVideo.defaultMuted = true;
    this._inlineVideo.volume = 0;
    this._inlineVideo.setAttribute('muted', '');
  }

  playInline(url: string, opts?: { muted?: boolean; rate?: number; loop?: boolean; onEnded?: () => void }): void {
    if (this._disposed) return;
    this.stopInline();
    this._stillMap = this._material.map;
    const muted = opts?.muted ?? false;
    const video = document.createElement('video');
    video.playsInline = true;
    video.loop = opts?.loop ?? true;
    video.crossOrigin = 'anonymous';
    video.muted = muted;
    video.defaultMuted = muted;
    if (muted) {
      video.volume = 0;
      video.setAttribute('muted', '');
    } else {
      video.volume = 1;
      video.removeAttribute('muted');
    }
    video.playbackRate = opts?.rate ?? 1;
    video.src = url;
    const applyVideoAspect = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        this._fitNaturalAspect(video.videoWidth, video.videoHeight);
        this._applyRoundMask();
      }
    };
    video.addEventListener('loadedmetadata', applyVideoAspect);
    if (opts?.onEnded) {
      video.addEventListener('ended', () => {
        if (this._inlineVideo === video) opts.onEnded?.();
      });
    }
    const tryPlay = () => {
      video.muted = muted || video.muted;
      if (muted) video.volume = 0;
      void video.play().catch(() => {
        video.muted = true;
        video.volume = 0;
        void video.play().catch(() => {});
      });
    };
    video.addEventListener('canplay', tryPlay, { once: true });
    tryPlay();
    const tex = new THREE.VideoTexture(video);
    tex.colorSpace = THREE.SRGBColorSpace;
    this._material.map = tex;
    this._applyRoundMask();
    this._material.needsUpdate = true;
    this._inlineVideo = video;
    this._videoTexture = tex;
  }

  stopInline(): void {
    if (this._inlineVideo) {
      this._inlineVideo.pause();
      this._inlineVideo.removeAttribute('src');
      this._inlineVideo.load();
      this._inlineVideo = null;
    }
    if (this._videoTexture) {
      this._videoTexture.dispose();
      this._videoTexture = null;
    }
    if (this._stillMap) {
      this._material.map = this._stillMap;
      this._stillMap = null;
      this._material.alphaMap = null;
      this._material.needsUpdate = true;
    }
  }

  /** Releases the material (the geometry is shared and not disposed here). */
  dispose(): void {
    if (this._disposed) return;
    this.stopInline();
    this._disposed = true;
    if (this._roundMask) {
      this._roundMask.dispose();
      this._roundMask = null;
    }
    if (this._fullUrl && this._fullEvictCb) {
      textureCache.releaseFullRes(this._fullUrl, this._fullEvictCb);
      this._fullEvictCb = undefined;
    }
    this._material.map = null;
    this._material.dispose();
    if (this._noteTexture) {
      this._noteTexture.dispose();
      this._noteTexture = undefined;
    }
    if (this._hoverTexture) {
      this._hoverTexture.dispose();
      this._hoverTexture = undefined;
    }
  }

  private _applyPose(node: CanvasNode): void {
    this._mesh.scale.set(node.width, node.height, 1);
    this._mesh.position.set(node.localX, node.localY, node.localZ);
    this._mesh.rotation.y = node.yaw ?? 0;
    const yaw = node.yaw ?? 0;
    const proud = node.kind === 'video' ? 8.2 : 2.4;
    if (yaw > 0.2) this._mesh.position.x += proud;
    else if (yaw < -0.2) this._mesh.position.x -= proud;
    this._mesh.userData.nodeId = node.id;
  }

  private _contentKey(node: CanvasNode): string {
    const p = node.properties ?? {};
    return [
      node.textContent ?? '',
      p.name ?? '',
      p.title ?? '',
      p.isActive === true ? '1' : '0',
      p.isStreaming === true ? '1' : '0',
    ].join('\0');
  }

  private _bakeTextTextures(): void {
    const isConv = this._node.kind === 'conversation';
    const isActive = isConv && this._node.properties?.isActive === true;
    const isStreaming = isConv && this._node.properties?.isStreaming === true;
    if (this._noteTexture) {
      this._noteTexture.dispose();
      this._noteTexture = undefined;
    }
    if (this._hoverTexture) {
      this._hoverTexture.dispose();
      this._hoverTexture = undefined;
    }
    const tex = isConv
      ? this._createConversationTexture(false, isActive, isStreaming)
      : this._createTextTexture(this._node.textContent ?? '');
    this._noteTexture = tex;
    this._material.map = tex;
    this._material.color.set(0xffffff);
    this._material.needsUpdate = true;
    if (isConv) {
      this._hoverTexture = this._createConversationTexture(true, isActive, isStreaming);
      if (this._hovered) this._material.map = this._hoverTexture;
    }
  }

  private _createConversationTexture(hovered: boolean, isActive = false, isStreaming = false): THREE.CanvasTexture {
    const aspect = this._node.width > 0 && this._node.height > 0
      ? this._node.width / this._node.height
      : 3 / 4;
    const long = 1024;
    const canvasW = aspect >= 1 ? long : Math.max(256, Math.round(long * aspect));
    const canvasH = aspect >= 1 ? Math.max(256, Math.round(long / aspect)) : long;
    const canvas = document.createElement('canvas');
    canvas.width = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return new THREE.CanvasTexture(canvas);
    }

    const p = this._node.properties ?? {};
    const title = String(
      (p.name as string) ?? (p.title as string) ?? this._node.textContent?.split('\n')[0] ?? this._node.id,
    ).trim();
    const excerptRaw = [p.excerpt, p.summary, p.description]
      .find((v): v is string => typeof v === 'string' && v.trim().length > 0)
      ?.trim() ?? '';
    const excerpt = excerptRaw && excerptRaw.toLowerCase() !== title.toLowerCase() ? excerptRaw : '';
    const createdAt = typeof p.createdAt === 'number'
      ? p.createdAt
      : typeof p.created_at === 'number'
        ? p.created_at
        : null;
    const dateLabel = createdAt !== null ? this._formatCardDate(createdAt) : '';
    const status = isStreaming ? 'THINKING' : isActive ? 'ACTIVE' : '';

    const pal = this._framePalette();
    const [hi, lo, mid] = pal.frame;
    const wood = Math.max(16, Math.round(Math.min(canvasW, canvasH) * 0.058));
    this._fillMolding(ctx, 0, 0, canvasW, canvasH, wood, hi, lo, mid);
    this._grainWoodRing(ctx, 0, 0, canvasW, canvasH, wood);

    const giltW = Math.max(3, Math.round(wood * 0.22));
    const gilt = hovered || isActive || isStreaming ? pal.giltHover : pal.gilt;
    ctx.fillStyle = gilt;
    ctx.fillRect(wood, wood, canvasW - wood * 2, canvasH - wood * 2);

    const inner = wood + giltW;
    const paperX = inner;
    const paperY = inner;
    const paperW = canvasW - inner * 2;
    const paperH = canvasH - inner * 2;
    ctx.fillStyle = pal.mat;
    ctx.fillRect(paperX, paperY, paperW, paperH);
    if (hovered || isActive || isStreaming) {
      ctx.fillStyle = 'rgba(255, 248, 230, 0.32)';
      ctx.fillRect(paperX, paperY, paperW, paperH);
    }
    this._grainPaper(ctx, paperX, paperY, paperW, paperH, this._hashSeed(this._node.id));

    ctx.strokeStyle = pal.fillet;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1;
    ctx.strokeRect(paperX + 0.5, paperY + 0.5, paperW - 1, paperH - 1);
    ctx.globalAlpha = 1;

    const rebate = ctx.createLinearGradient(paperX, paperY, paperX, paperY + Math.round(paperH * 0.08));
    rebate.addColorStop(0, 'rgba(28, 16, 8, 0.22)');
    rebate.addColorStop(1, 'rgba(28, 16, 8, 0)');
    ctx.fillStyle = rebate;
    ctx.fillRect(paperX, paperY, paperW, Math.round(paperH * 0.08));
    const rebateL = ctx.createLinearGradient(paperX, paperY, paperX + Math.round(paperW * 0.06), paperY);
    rebateL.addColorStop(0, 'rgba(28, 16, 8, 0.16)');
    rebateL.addColorStop(1, 'rgba(28, 16, 8, 0)');
    ctx.fillStyle = rebateL;
    ctx.fillRect(paperX, paperY, Math.round(paperW * 0.06), paperH);

    const padX = paperX + Math.round(paperW * 0.09);
    const maxTextWidth = paperW - Math.round(paperW * 0.18);
    const capH = Math.max(48, Math.round(paperH * 0.12));
    const capY = paperY + paperH - capH;
    const artwork = excerpt || title;
    const artworkTop = paperY + Math.round(paperH * 0.08);
    const artworkBot = capY - Math.round(paperH * 0.03);
    const artworkH = Math.max(48, artworkBot - artworkTop);
    const lineGap = 1.12;
    const words = artwork.split(/\s+/).filter(Boolean);
    const longest = words.reduce((a, b) => (a.length >= b.length ? a : b), 'Ag');

    let fontLo = Math.max(28, Math.round(paperW * 0.07));
    let fontHi = Math.min(Math.round(artworkH * 0.46), Math.round(paperW * 0.32));
    let titleFont = fontLo;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    for (let i = 0; i < 14; i++) {
      const fontMid = Math.round((fontLo + fontHi) / 2);
      if (fontMid <= fontLo) break;
      ctx.font = `500 ${fontMid}px ${FONT_DISPLAY}`;
      this._setLetterSpacing(ctx, `${Math.round(-0.03 * fontMid)}px`);
      const fitLines = Math.max(2, Math.min(6, Math.floor(artworkH / (fontMid * lineGap))));
      const overflow = ctx.measureText(longest).width > maxTextWidth;
      const fitCount = this._countWrapped(ctx, artwork, maxTextWidth, fitLines);
      const fitH = fitCount * fontMid * lineGap;
      if (!overflow && fitH <= artworkH && fitCount > 0) {
        titleFont = fontMid;
        fontLo = fontMid;
      } else {
        fontHi = fontMid;
      }
    }
    this._setLetterSpacing(ctx, '0px');

    ctx.font = `500 ${titleFont}px ${FONT_DISPLAY}`;
    this._setLetterSpacing(ctx, `${Math.round(-0.03 * titleFont)}px`);
    const titleLineH = Math.round(titleFont * lineGap);
    const maxLines = Math.max(2, Math.min(6, Math.floor(artworkH / titleLineH)));
    const lines = Math.max(1, this._countWrapped(ctx, artwork, maxTextWidth, maxLines));
    const blockH = lines * titleLineH;
    const titleY = artworkTop + Math.max(0, Math.round((artworkH - blockH) / 2));
    ctx.fillStyle = '#24180f';
    this._drawWrapped(ctx, artwork, padX, titleY, maxTextWidth, titleLineH, maxLines);
    this._setLetterSpacing(ctx, '0px');

    ctx.strokeStyle = pal.caption;
    ctx.globalAlpha = 0.4;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padX, capY);
    ctx.lineTo(paperX + paperW - (padX - paperX), capY);
    ctx.stroke();
    ctx.globalAlpha = 1;

    const metaFont = Math.max(15, Math.round(Math.min(paperW, paperH) * 0.034));
    const metaY = capY + Math.round((capH - metaFont) / 2);
    ctx.font = `500 ${metaFont}px ${FONT_MONO}`;
    ctx.fillStyle = pal.caption;
    this._setLetterSpacing(ctx, `${Math.round(0.14 * metaFont)}px`);
    const captionLeft = excerpt ? title : dateLabel;
    if (captionLeft) {
      ctx.textAlign = 'left';
      ctx.fillText(captionLeft.toUpperCase(), padX, metaY, maxTextWidth * 0.62);
    }
    const captionRight = [status, excerpt ? dateLabel : ''].filter(Boolean).join('  ·  ');
    if (captionRight) {
      ctx.textAlign = 'right';
      ctx.fillStyle = status ? pal.gilt : pal.caption;
      ctx.fillText(captionRight.toUpperCase(), paperX + paperW - (padX - paperX), metaY, maxTextWidth * 0.42);
    }
    this._setLetterSpacing(ctx, '0px');
    ctx.textAlign = 'left';

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  }

  private _fillGlassCard(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    radius: number,
    scale: number,
  ): void {
    ctx.fillStyle = GLASS_BG;
    this._roundRect(ctx, 0, 0, w, h, radius);
    ctx.fill();

    ctx.strokeStyle = GLASS_RING;
    ctx.lineWidth = 1;
    this._roundRect(ctx, 0.5, 0.5, w - 1, h - 1, radius - 0.5);
    ctx.stroke();

    ctx.save();
    ctx.shadowColor = GLASS_GLOW;
    ctx.shadowBlur = Math.round(16 * scale);
    ctx.strokeStyle = GLASS_BORDER;
    ctx.lineWidth = 1;
    this._roundRect(ctx, 1, 1, w - 2, h - 2, radius - 1);
    ctx.stroke();
    ctx.restore();

    const topGrad = ctx.createLinearGradient(0, 0, w, 0);
    topGrad.addColorStop(0, 'rgba(19,220,246,0)');
    topGrad.addColorStop(0.5, CYAN_ACCENT);
    topGrad.addColorStop(1, 'rgba(19,220,246,0)');
    ctx.fillStyle = topGrad;
    ctx.globalAlpha = 0.7;
    ctx.fillRect(0, 0, w, 3);
    ctx.globalAlpha = 1;
  }

  private _formatCardDate(raw: number): string {
    const d = new Date(raw > 1e12 ? raw : raw * 1000);
    if (isNaN(d.getTime())) return '';
    const day = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return `${day} · ${d.getFullYear()}`;
  }

  private _hashSeed(s: string): number {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  private _framePalette(): {
    frame: [string, string, string];
    mat: string;
    fillet: string;
    caption: string;
    gilt: string;
    giltHover: string;
  } {
    const palettes = [
      { frame: ['#7a4a2c', '#241008', '#4a2818'] as [string, string, string], mat: '#f3e6d0', fillet: '#1a0e08', caption: '#6e4c32', gilt: '#d4a84a', giltHover: '#e8c468' },
      { frame: ['#3a3a3a', '#080808', '#181818'] as [string, string, string], mat: '#f7f1e6', fillet: '#111', caption: '#6a6458', gilt: '#c4a056', giltHover: '#e0c878' },
      { frame: ['#d2ae6a', '#6a4818', '#9a7038'] as [string, string, string], mat: '#f8f0dc', fillet: '#3a2c14', caption: '#7a5a28', gilt: '#e0c070', giltHover: '#f0d890' },
      { frame: ['#e8dcc8', '#8a7a64', '#c4b49a'] as [string, string, string], mat: '#f4ece0', fillet: '#8a8278', caption: '#6a645c', gilt: '#9a8060', giltHover: '#c4b496' },
      { frame: ['#7a2c32', '#28080c', '#4a1418'] as [string, string, string], mat: '#f4e6d4', fillet: '#22080c', caption: '#6e3c38', gilt: '#c49a5a', giltHover: '#e0b878' },
    ];
    return palettes[this._hashSeed(this._node.id) % palettes.length];
  }

  private _drawWaveformBars(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    seed: number,
  ): void {
    const barW = 3;
    const gap = 3;
    const n = Math.max(8, Math.floor((w + gap) / (barW + gap)));
    let s = seed || 1;
    ctx.save();
    ctx.fillStyle = CYAN_CYBER;
    for (let i = 0; i < n; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const t = (s & 0xffff) / 0xffff;
      const bh = Math.max(4, h * (0.18 + 0.82 * t));
      ctx.globalAlpha = 0.85;
      const bx = x + i * (barW + gap);
      const by = y + (h - bh) / 2;
      ctx.beginPath();
      this._roundRect(ctx, bx, by, barW, bh, 1.5);
      ctx.fill();
    }
    ctx.restore();
  }

  private _drawDocLines(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    scale: number,
  ): void {
    const h = Math.max(3, Math.round(4 * scale));
    const gap = Math.round(8 * scale);
    const widths = [0.88, 0.72, 0.8];
    ctx.fillStyle = 'rgba(232,238,246,0.18)';
    for (let i = 0; i < widths.length; i++) {
      const lw = w * widths[i];
      const yy = y + i * (h + gap);
      ctx.beginPath();
      this._roundRect(ctx, x, yy, lw, h, h / 2);
      ctx.fill();
    }
  }

  private _hashNoise(n: number): number {
    n = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
    return ((n ^ (n >>> 13)) >>> 0) / 4294967296;
  }

  private _fillMolding(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    t: number,
    hi: string,
    lo: string,
    mid: string,
  ): void {
    const x2 = x + w;
    const y2 = y + h;
    ctx.fillStyle = mid;
    ctx.fillRect(x, y, w, h);
    const top = ctx.createLinearGradient(x, y, x, y + t);
    top.addColorStop(0, hi);
    top.addColorStop(0.45, mid);
    top.addColorStop(1, lo);
    ctx.fillStyle = top;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x2, y);
    ctx.lineTo(x2 - t, y + t);
    ctx.lineTo(x + t, y + t);
    ctx.closePath();
    ctx.fill();
    const left = ctx.createLinearGradient(x, y, x + t, y);
    left.addColorStop(0, hi);
    left.addColorStop(0.55, mid);
    left.addColorStop(1, lo);
    ctx.fillStyle = left;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + t, y + t);
    ctx.lineTo(x + t, y2 - t);
    ctx.lineTo(x, y2);
    ctx.closePath();
    ctx.fill();
    const right = ctx.createLinearGradient(x2, y, x2 - t, y);
    right.addColorStop(0, lo);
    right.addColorStop(0.4, mid);
    right.addColorStop(1, '#0c0704');
    ctx.fillStyle = right;
    ctx.beginPath();
    ctx.moveTo(x2, y);
    ctx.lineTo(x2, y2);
    ctx.lineTo(x2 - t, y2 - t);
    ctx.lineTo(x2 - t, y + t);
    ctx.closePath();
    ctx.fill();
    const bot = ctx.createLinearGradient(x, y2, x, y2 - t);
    bot.addColorStop(0, '#0a0604');
    bot.addColorStop(0.35, lo);
    bot.addColorStop(1, mid);
    ctx.fillStyle = bot;
    ctx.beginPath();
    ctx.moveTo(x, y2);
    ctx.lineTo(x2, y2);
    ctx.lineTo(x2 - t, y2 - t);
    ctx.lineTo(x + t, y2 - t);
    ctx.closePath();
    ctx.fill();
  }

  private _grainWoodRing(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    t: number,
  ): void {
    if (t < 2) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.rect(x + t, y + t, Math.max(0, w - t * 2), Math.max(0, h - t * 2));
    ctx.clip('evenodd');
    const step = Math.max(1.4, t * 0.22);
    ctx.lineWidth = 0.8;
    ctx.lineCap = 'butt';
    for (let i = 0; i < w; i += step) {
      const n = this._hashNoise((x + i) * 17 + y * 31);
      ctx.strokeStyle = n > 0.55 ? 'rgba(92,58,28,0.28)' : 'rgba(18,8,4,0.22)';
      ctx.globalAlpha = 0.35 + n * 0.45;
      const wobble = (n - 0.5) * t * 0.4;
      ctx.beginPath();
      ctx.moveTo(x + i, y + wobble);
      ctx.lineTo(x + i + (n - 0.5) * 1.4, y + h);
      ctx.stroke();
    }
    ctx.globalAlpha = 0.18;
    ctx.strokeStyle = 'rgba(210,160,90,0.22)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, t);
    ctx.strokeRect(x + 0.5, y + 0.5, t, h - 1);
    ctx.restore();
  }

  private _grainPaper(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    seed: number,
  ): void {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    const count = Math.min(1600, Math.max(400, Math.floor((w * h) / 320)));
    for (let i = 0; i < count; i++) {
      const n = this._hashNoise(seed + i * 17);
      const m = this._hashNoise(seed + i * 41 + 9);
      ctx.globalAlpha = 0.035 + n * 0.06;
      ctx.fillStyle = n > 0.55 ? '#3a2414' : '#fffaf0';
      ctx.fillRect(x + m * w, y + n * h, 1.15, 1.15);
    }
    ctx.restore();
  }

  private _imageSize(texture: THREE.Texture): { w: number; h: number } | null {
    const img = texture.image as {
      width?: number;
      height?: number;
      naturalWidth?: number;
      naturalHeight?: number;
      videoWidth?: number;
      videoHeight?: number;
    } | undefined;
    if (!img) return null;
    const w = img.naturalWidth ?? img.videoWidth ?? img.width ?? 0;
    const h = img.naturalHeight ?? img.videoHeight ?? img.height ?? 0;
    if (w <= 0 || h <= 0) return null;
    return { w, h };
  }

  private _fitNaturalAspect(iw: number, ih: number): void {
    const aspect = iw / ih;
    if (!Number.isFinite(aspect) || aspect <= 0) return;
    if (this._node.kind === 'video') {
      if (aspect >= 1) {
        const w = Math.max(this._node.width, this._node.height * aspect, 72);
        this._mesh.scale.set(w, w / aspect, 1);
      } else {
        const h = Math.max(this._node.height, 72);
        this._mesh.scale.set(h * aspect, h, 1);
      }
      return;
    }
    const span = Math.max(this._node.width, this._node.height, 72);
    if (aspect >= 1) {
      this._mesh.scale.set(span, span / aspect, 1);
    } else {
      this._mesh.scale.set(span * aspect, span, 1);
    }
  }

  private _mediaDateLabel(): string {
    const p = this._node.properties ?? {};
    const raw =
      p.date_taken_friendly ??
      p.datetime_original ??
      p.date_taken ??
      p.taken_at ??
      p.createdAt ??
      p.created_at;
    if (raw == null || raw === '') return '';
    let d: Date | null = null;
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      d = new Date(raw > 1e12 ? raw : raw * 1000);
    } else if (typeof raw === 'string') {
      const m = raw.match(/^(\d{4})[:\-](\d{2})[:\-](\d{2})/);
      d = m ? new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`) : new Date(raw);
    }
    if (!d || isNaN(d.getTime())) return '';
    const day = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return `${day} · ${d.getFullYear()}`;
  }

  private _applyRoundMask(): void {
    if (this._roundMask) {
      this._roundMask.dispose();
      this._roundMask = null;
    }
    const sx = Math.max(1, this._mesh.scale.x);
    const sy = Math.max(1, this._mesh.scale.y);
    const aspect = sx / sy;
    const long = 1024;
    const canvasW = aspect >= 1 ? long : Math.max(256, Math.round(long * aspect));
    const canvasH = aspect >= 1 ? Math.max(256, Math.round(long / aspect)) : long;
    const radiusFrac = this._node.kind === 'video' ? 0.012 : 0.045;
    const radius = Math.max(this._node.kind === 'video' ? 3 : 12, Math.round(Math.min(canvasW, canvasH) * radiusFrac));
    const canvas = document.createElement('canvas');
    canvas.width = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvasW, canvasH);
    ctx.fillStyle = '#ffffff';
    this._roundRect(ctx, 0.5, 0.5, canvasW - 1, canvasH - 1, radius);
    ctx.fill();
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this._roundMask = tex;
    this._material.alphaMap = tex;
    this._material.transparent = true;
    this._material.alphaTest = 0;
    this._material.needsUpdate = true;
  }

  private _createVideoScreenTexture(source: THREE.Texture, withDate = true): THREE.CanvasTexture {
    const imgSize = this._imageSize(source);
    const aspect = imgSize
      ? imgSize.w / imgSize.h
      : this._mesh.scale.x > 0 && this._mesh.scale.y > 0
        ? this._mesh.scale.x / this._mesh.scale.y
        : 16 / 9;
    const long = 1024;
    const canvasW = aspect >= 1 ? long : Math.max(192, Math.round(long * aspect));
    const canvasH = aspect >= 1 ? Math.max(192, Math.round(long / aspect)) : long;
    const canvas = document.createElement('canvas');
    canvas.width = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return new THREE.CanvasTexture(canvas);

    const isVideo = this._node.kind === 'video';
    const minDim = Math.min(canvasW, canvasH);
    const radius = Math.round(minDim * (isVideo ? 0.012 : 0.045));
    ctx.clearRect(0, 0, canvasW, canvasH);
    ctx.save();
    this._roundRect(ctx, 0, 0, canvasW, canvasH, radius);
    ctx.clip();

    const img = source.image as { width?: number; height?: number } | undefined;
    if (img && (img.width ?? 0) > 0 && (img.height ?? 0) > 0) {
      try {
        ctx.drawImage(img as CanvasImageSource, 0, 0, canvasW, canvasH);
      } catch {
        ctx.fillStyle = '#111';
        ctx.fillRect(0, 0, canvasW, canvasH);
      }
    } else {
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, canvasW, canvasH);
    }

    const dateLabel = withDate ? this._mediaDateLabel() : '';
    if (dateLabel) {
      const dateFont = Math.max(11, Math.round(minDim * 0.028));
      ctx.font = `500 ${dateFont}px ${FONT_MONO}`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = 'rgba(255,255,255,0.72)';
      ctx.fillText(dateLabel.toUpperCase(), canvasW - 14, canvasH - 14);
    }
    ctx.restore();

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    return texture;
  }

  private _createMediaCaptionTexture(
    source: THREE.Texture,
    withDate = true,
  ): THREE.CanvasTexture {
    return this._createVideoScreenTexture(source, withDate);
  }


  private _fillGlassCardStrokeOnly(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    radius: number,
    scale: number,
  ): void {
    ctx.save();
    ctx.shadowColor = GLASS_GLOW;
    ctx.shadowBlur = Math.round(16 * scale);
    ctx.strokeStyle = GLASS_BORDER;
    ctx.lineWidth = 1.5;
    this._roundRect(ctx, 1, 1, w - 2, h - 2, radius - 1);
    ctx.stroke();
    ctx.restore();
  }

  /** Rounded-rect path helper (does not fill/stroke). */
  private _roundRect(
    ctx: CanvasRenderingContext2D,
    x: number, y: number, w: number, h: number, r: number,
  ): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /** Letter-spacing helper — guarded for older browsers without `ctx.letterSpacing`. */
  private _setLetterSpacing(ctx: CanvasRenderingContext2D, value: string): void {
    if ('letterSpacing' in ctx) {
      (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = value;
    }
  }

  private _countWrapped(
    ctx: CanvasRenderingContext2D,
    text: string,
    maxWidth: number,
    maxLines: number,
  ): number {
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length === 0 || maxLines <= 0) return 0;
    let line = '';
    let lines = 1;
    for (let i = 0; i < words.length; i++) {
      const candidate = line ? `${line} ${words[i]}` : words[i];
      if (ctx.measureText(candidate).width <= maxWidth) {
        line = candidate;
        continue;
      }
      if (lines >= maxLines) return maxLines;
      lines++;
      line = words[i];
    }
    return lines;
  }

  /** Word-wrap helper for the conversation card. Draws up to `maxLines` lines,
   *  ellipsis-truncating the final line if it overflows. */
  private _drawWrapped(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    maxWidth: number,
    lineHeight: number,
    maxLines: number,
  ): void {
    const words = text.split(/\s+/).filter(Boolean);
    let line = '';
    let yy = y;
    let lineIdx = 0;
    for (let i = 0; i < words.length; i++) {
      const candidate = line ? `${line} ${words[i]}` : words[i];
      if (ctx.measureText(candidate).width <= maxWidth) {
        line = candidate;
        continue;
      }
      if (lineIdx === maxLines - 1) {
        // Last allowed line — ellipsis-truncate.
        let last = line ? `${line} ${words[i]}` : words[i];
        while (last && ctx.measureText(last + '…').width > maxWidth && last.length > 0) {
          last = last.slice(0, -1);
        }
        ctx.fillText(last + '…', x, yy);
        return;
      }
      if (line) {
        ctx.fillText(line, x, yy);
        yy += lineHeight;
        lineIdx++;
        line = words[i];
      } else {
        // Single word too long — hard break.
        let chunk = words[i];
        while (chunk && ctx.measureText(chunk).width > maxWidth) {
          let cut = chunk.length - 1;
          while (cut > 0 && ctx.measureText(chunk.slice(0, cut)).width > maxWidth) cut--;
          if (cut <= 0) return;
          ctx.fillText(chunk.slice(0, cut), x, yy);
          yy += lineHeight;
          lineIdx++;
          if (lineIdx >= maxLines) return;
          chunk = chunk.slice(cut);
        }
        line = chunk;
      }
    }
    if (line) ctx.fillText(line, x, yy);
  }

  private _createGlassTextTexture(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    text: string,
  ): THREE.CanvasTexture {
    const canvasW = canvas.width;
    const canvasH = canvas.height;
    const radius = 18;
    const padX = 28;
    const scale = canvasH / 420;

    this._fillGlassCard(ctx, canvasW, canvasH, radius, scale);

    const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
    const kind = this._node.kind;
    const badge = (kind === 'audio' ? 'AUDIO' : (lines[1] ?? '')).toUpperCase();
    const title = lines[0] ?? '';

    const glyphFont = Math.max(13, Math.round(14 * scale));
    const glyphY = Math.round(22 * scale);
    ctx.font = `500 ${glyphFont}px ${FONT_MONO}`;
    ctx.fillStyle = CYAN_CYBER;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    this._setLetterSpacing(ctx, `${Math.round(0.18 * glyphFont)}px`);
    ctx.fillText(badge || (kind === 'document' ? 'DOC' : kind.toUpperCase()), padX, glyphY);
    this._setLetterSpacing(ctx, '0px');

    const titleFont = Math.max(26, Math.round(28 * scale));
    const titleY = glyphY + glyphFont + Math.round(14 * scale);
    const maxTextWidth = canvasW - padX * 2;
    ctx.font = `500 ${titleFont}px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#f4fbff';
    this._setLetterSpacing(ctx, `${Math.round(-0.02 * titleFont)}px`);
    const titleLineH = Math.round(titleFont * 1.22);
    this._drawWrapped(ctx, title, padX, titleY, maxTextWidth, titleLineH, 2);
    this._setLetterSpacing(ctx, '0px');

    const bodyY = titleY + titleLineH * 2 + Math.round(16 * scale);
    if (kind === 'audio') {
      this._drawWaveformBars(
        ctx,
        padX,
        bodyY,
        maxTextWidth,
        Math.round(48 * scale),
        this._hashSeed(this._node.id),
      );
    } else if (badge === 'PDF') {
      this._drawDocLines(ctx, padX, bodyY, maxTextWidth, scale);
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  }

  /**
   * Bake `text` into a `THREE.CanvasTexture` for a `note` plane. Draws
   * wrapped, ellipsis-truncated prose on a warm paper background sized to
   * the node's plane aspect. Deterministic: identical `text` + aspect
   * produces an identical texture. The texture is owned by this `NodePlane`
   * and disposed in {@link dispose} — it is NOT registered with `textureCache`.
   */
  private _createTextTexture(text: string): THREE.CanvasTexture {
    // Canvas resolution: square base, tall enough for wrapped prose. The
    // plane geometry is 1×1 scaled by (width, height), so the texture's
    // pixel aspect should match width/height to avoid stretching.
    const aspect = this._node.width > 0 && this._node.height > 0
      ? this._node.width / this._node.height
      : 1 / 1.4;
    const canvasH = this._node.kind === 'note' ? 512 : 640;
    const canvasW = Math.max(128, Math.round(canvasH * aspect));
    const canvas = document.createElement('canvas');
    canvas.width = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      // Fallback: blank paper texture (no text) — still a valid texture.
      return new THREE.CanvasTexture(canvas);
    }

    if (this._node.kind !== 'note') {
      return this._createGlassTextTexture(ctx, canvas, text);
    }

    // Warm paper background + subtle border so the plane reads as a card.
    ctx.fillStyle = '#f5e9c8';
    ctx.fillRect(0, 0, canvasW, canvasH);
    ctx.strokeStyle = '#d8c79a';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, canvasW - 4, canvasH - 4);

    // Readable sans-serif, sized relative to canvas height. Margin keeps
    // text off the border; line spacing ~1.32× the font size.
    const margin = 16;
    const fontPx = Math.max(16, Math.round(canvasH / 26));
    const lineHeight = Math.round(fontPx * 1.32);
    ctx.fillStyle = '#2b2620';
    ctx.font = `${fontPx}px ${FONT_BODY}`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';

    const maxWidth = canvasW - margin * 2;
    const words = text.split(/\s+/).filter(Boolean);
    let line = '';
    let y = margin;
    const ellipsis = '…';
    for (let i = 0; i < words.length; i++) {
      const candidate = line ? `${line} ${words[i]}` : words[i];
      if (ctx.measureText(candidate).width <= maxWidth) {
        line = candidate;
        continue;
      }
      // Flush the current line if it fits.
      if (line) {
        ctx.fillText(line, margin, y);
        y += lineHeight;
        line = words[i];
      } else {
        // Single word too long — hard-break it to maxWidth.
        let chunk = words[i];
        while (chunk && ctx.measureText(chunk).width > maxWidth) {
          let cut = chunk.length - 1;
          while (cut > 0 && ctx.measureText(chunk.slice(0, cut)).width > maxWidth) {
            cut--;
          }
          if (cut <= 0) break;
          ctx.fillText(chunk.slice(0, cut), margin, y);
          y += lineHeight;
          chunk = chunk.slice(cut);
        }
        line = chunk;
      }
      // Stop once the next line would overflow the canvas; append ellipsis.
      if (y + lineHeight > canvasH - margin) {
        let last = line;
        // Try to fit an ellipsis on the final line; trim if needed.
        while (last && ctx.measureText(last + ellipsis).width > maxWidth && last.length > 0) {
          last = last.slice(0, -1);
        }
        ctx.fillText(last ? last + ellipsis : ellipsis, margin, y);
        line = '';
        y = canvasH;
        break;
      }
    }
    if (line && y + lineHeight <= canvasH - margin) {
      ctx.fillText(line, margin, y);
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  }
}