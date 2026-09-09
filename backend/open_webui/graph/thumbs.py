"""On-demand library thumbnails on the system disk.

Cache: ``{DATA_DIR}/graph_thumbs/{source_id}/{asset_id}_{512|1024}.webp``.
Generate only on miss. Never write next to originals, never reuse
``GRAPH_IMAGES_DIR`` / ``IMAGES_DIR``. Offline sources return None — stale
thumbs may remain on SSD for remount but are not served to the canvas.
PDF/document/audio are not rasterized here.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from open_webui.graph.extractors import classify_kind
from open_webui.graph.sources import is_online, presence_monitor

logger = logging.getLogger(__name__)

THUMB_MAX = 512
DISPLAY_MAX = 1024
_HEIC_SUFFIXES = frozenset({".heic", ".heif"})
_NO_RASTER = frozenset({"pdf", "document", "audio"})
_PLACEHOLDER_RGB = (10, 14, 23)

_BACKEND_DATA = Path(__file__).resolve().parent.parent.parent / "data"
GRAPH_THUMBS_DIR = Path(
    os.environ.get(
        "GRAPH_THUMBS_DIR",
        str(Path(os.environ.get("DATA_DIR", _BACKEND_DATA)) / "graph_thumbs"),
    )
)

_heif_registered = False


def _bare_asset_id(raw: str) -> str:
    if raw.startswith("asset:"):
        return raw[6:]
    return raw


def _safe_id(raw: str) -> str:
    name = Path(str(raw)).name
    if name in ("", ".", ".."):
        raise ValueError("invalid id")
    return name


def _kind(asset: Mapping[str, Any]) -> str | None:
    kind = asset.get("kind")
    if kind:
        return str(kind).lower()
    path = asset.get("abs_path") or asset.get("rel_path")
    if path:
        return classify_kind(path)
    return None


def clamp_thumb_size(size: int) -> int:
    return DISPLAY_MAX if size >= DISPLAY_MAX else THUMB_MAX


def thumb_path(asset: Mapping[str, Any], size: int = THUMB_MAX) -> Path:
    """Return the on-disk cache path (does not check presence or existence)."""
    source_id = _safe_id(str(asset["source_id"]))
    asset_id = _safe_id(_bare_asset_id(str(asset["id"])))
    edge = clamp_thumb_size(size)
    return GRAPH_THUMBS_DIR / source_id / f"{asset_id}_{edge}.webp"


def _original_path(asset: Mapping[str, Any]) -> Path | None:
    abs_path = asset.get("abs_path")
    if abs_path:
        return Path(abs_path)
    rel = asset.get("rel_path")
    if not rel:
        return None
    root = presence_monitor.last_abs_path(str(asset["source_id"]))
    if not root:
        return None
    return Path(root) / rel


def _ensure_heif_opener() -> bool:
    global _heif_registered
    if _heif_registered:
        return True
    try:
        import pillow_heif

        pillow_heif.register_heif_opener()
        _heif_registered = True
        return True
    except Exception:
        return False


def _heic_via_sips(src: Path) -> Any | None:
    if sys.platform != "darwin":
        return None
    sips = shutil.which("sips") or "/usr/bin/sips"
    if not os.path.isfile(sips):
        return None
    from PIL import Image

    try:
        with tempfile.TemporaryDirectory(prefix="owui-heic-") as td:
            out = Path(td) / "frame.jpg"
            completed = subprocess.run(
                [
                    sips,
                    "-s",
                    "format",
                    "jpeg",
                    os.fspath(src),
                    "--out",
                    os.fspath(out),
                ],
                capture_output=True,
                timeout=15,
                check=False,
            )
            if completed.returncode != 0 or not out.is_file() or out.stat().st_size == 0:
                return None
            with Image.open(out) as img:
                return img.copy()
    except (OSError, subprocess.TimeoutExpired):
        return None


def _open_photo(src: Path) -> Any | None:
    from PIL import Image

    suffix = src.suffix.lower()
    if suffix in _HEIC_SUFFIXES:
        if _ensure_heif_opener():
            try:
                return Image.open(src)
            except Exception:
                logger.debug("pillow-heif open failed for %s", src, exc_info=True)
        img = _heic_via_sips(src)
        if img is not None:
            return img
        return None
    try:
        return Image.open(src)
    except Exception:
        logger.debug("PIL open failed for %s", src, exc_info=True)
        return None


def _video_frame_ffmpeg(src: Path) -> Any | None:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return None
    from PIL import Image

    try:
        with tempfile.TemporaryDirectory(prefix="owui-vid-") as td:
            out = Path(td) / "frame.jpg"
            for ss in ("1", "0"):
                completed = subprocess.run(
                    [
                        ffmpeg,
                        "-nostdin",
                        "-hide_banner",
                        "-loglevel",
                        "error",
                        "-ss",
                        ss,
                        "-i",
                        os.fspath(src),
                        "-frames:v",
                        "1",
                        "-an",
                        "-y",
                        os.fspath(out),
                    ],
                    capture_output=True,
                    timeout=20,
                    check=False,
                )
                if completed.returncode == 0 and out.is_file() and out.stat().st_size > 0:
                    with Image.open(out) as img:
                        return img.copy()
            return None
    except (OSError, subprocess.TimeoutExpired):
        logger.debug("ffmpeg poster failed for %s", src, exc_info=True)
        return None


def _video_frame_imageio(src: Path) -> Any | None:
    try:
        import imageio.v3 as iio
        from PIL import Image

        frame = iio.imread(os.fspath(src), index=0)
        return Image.fromarray(frame)
    except Exception:
        logger.debug("imageio poster failed for %s", src, exc_info=True)
        return None


def _video_frame(src: Path) -> Any | None:
    img = _video_frame_ffmpeg(src)
    if img is not None:
        return img
    return _video_frame_imageio(src)


def _atomic_save_webp(img: Any, dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(suffix=".webp", dir=dest.parent)
    tmp = Path(tmp_name)
    try:
        os.close(fd)
        if img.mode != "RGB":
            img = img.convert("RGB")
        img.save(tmp, "WEBP", quality=88)
        tmp.replace(dest)
        return dest
    except Exception:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def _shared_placeholder_png() -> Path:
    path = GRAPH_THUMBS_DIR / "_placeholder_photo.png"
    if path.is_file() and path.stat().st_size > 0:
        return path
    from PIL import Image

    GRAPH_THUMBS_DIR.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (1, 1), _PLACEHOLDER_RGB).save(path, "PNG")
    return path


def placeholder_thumb() -> Path:
    return _shared_placeholder_png()


def _write_placeholder(dest: Path) -> Path:
    from PIL import Image

    img = Image.new("RGB", (1, 1), _PLACEHOLDER_RGB)
    try:
        return _atomic_save_webp(img, dest)
    except Exception:
        logger.warning("webp placeholder failed for %s; using PNG", dest, exc_info=True)
        return _shared_placeholder_png()
    finally:
        img.close()


def _write_raster_thumb(img: Any, dest: Path, max_edge: int = THUMB_MAX) -> Path:
    from PIL import ImageOps

    try:
        transposed = ImageOps.exif_transpose(img)
        if transposed is not None:
            img = transposed
        if img.mode != "RGB":
            img = img.convert("RGB")
        img.thumbnail((max_edge, max_edge))
        return _atomic_save_webp(img, dest)
    finally:
        try:
            img.close()
        except Exception:
            pass


def _write_photo_thumb(src: Path, dest: Path, max_edge: int = THUMB_MAX) -> Path:
    img = _open_photo(src)
    if img is None:
        return _write_placeholder(dest)
    try:
        return _write_raster_thumb(img, dest, max_edge)
    except Exception:
        logger.warning("photo thumb failed for %s", src, exc_info=True)
        return _write_placeholder(dest)


def _write_video_thumb(src: Path, dest: Path, max_edge: int = THUMB_MAX) -> Path:
    img = _video_frame(src)
    if img is None:
        return _write_placeholder(dest)
    try:
        return _write_raster_thumb(img, dest, max_edge)
    except Exception:
        logger.warning("video thumb failed for %s", src, exc_info=True)
        return _write_placeholder(dest)


def ensure_thumb(asset: Mapping[str, Any], size: int = THUMB_MAX) -> Path | None:
    """Return a cached WEBP path (512 or 1024), generating on miss.

    None when the source is offline, the kind has no raster thumb, or the
    original is missing. Never raises — HEIC/video decode failure yields a
    1×1 placeholder rather than 500ing the canvas.
    """
    edge = clamp_thumb_size(size)
    try:
        source_id = asset.get("source_id")
        if not source_id or not asset.get("id"):
            return None
        if not is_online(str(source_id)):
            return None
        dest = thumb_path(asset, edge)
        if dest.is_file() and dest.stat().st_size > 0:
            return dest
        kind = _kind(asset)
        if kind in _NO_RASTER or kind is None:
            return None
        src = _original_path(asset)
        if src is None or not src.is_file():
            return None
        if kind == "video":
            return _write_video_thumb(src, dest, edge)
        if kind == "photo":
            return _write_photo_thumb(src, dest, edge)
        return None
    except Exception:
        logger.exception("ensure_thumb failed")
        kind = _kind(asset) if asset else None
        if kind in ("photo", "video"):
            try:
                return _write_placeholder(thumb_path(asset, edge))
            except Exception:
                return None
        return None
