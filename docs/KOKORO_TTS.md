# Kokoro TTS Integration

## Overview

Added [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) as a local TTS engine option in Open WebUI. Kokoro is a lightweight, high-quality neural TTS model that runs entirely on-device — no API key, no network calls after the initial model download.

## Installation

```bash
pip install kokoro==0.9.4 soundfile
```

The model (~few hundred MB) auto-downloads from `hexgrad/Kokoro-82M` on first inference and is cached under `~/.cache/huggingface/`.

**System dependency:** English OOD voices require `espeak-ng`:
```bash
brew install espeak-ng   # macOS
```

## Configuration

Set via Admin Settings → Audio → TTS Engine → **Kokoro (Local)**, or via environment variables:

| Env Var | Default | Description |
|---------|---------|-------------|
| `AUDIO_TTS_ENGINE` | `""` | Set to `kokoro` to use Kokoro |
| `AUDIO_TTS_KOKORO_LANG_CODE` | `a` | G2P language code (must match voice prefix) |
| `AUDIO_TTS_KOKORO_VOICE` | `af_heart` | Voice name (e.g. `af_heart`, `am_michael`) |
| `AUDIO_TTS_KOKORO_SPEED` | `1.0` | Speech rate multiplier |

### Language Codes

| Code | Language | Voice prefixes |
|------|----------|----------------|
| `a` | American English | `af_*`, `am_*` |
| `b` | British English | `bf_*`, `bm_*` |
| `e` | Spanish | `ef_*`, `em_*` |
| `f` | French | `ff_*`, `fm_*` |
| `j` | Japanese | `jf_*`, `jm_*` |
| `z` | Mandarin | `zf_*`, `zm_*` |
| `h` | Hindi | `hf_*`, `hm_*` |
| `i` | Italian | `if_*`, `im_*` |
| `p` | Portuguese | `pf_*`, `pm_*` |

The lang code must match the voice's language prefix. Mismatching produces garbled output.

## Files Changed

### Backend

**`backend/open_webui/config.py`**
- Added env vars: `AUDIO_TTS_KOKORO_LANG_CODE`, `AUDIO_TTS_KOKORO_VOICE`, `AUDIO_TTS_KOKORO_SPEED`
- Registered defaults in `DEFAULT_CONFIG`: `audio.tts.kokoro.lang_code`, `audio.tts.kokoro.voice`, `audio.tts.kokoro.speed`

**`backend/open_webui/routers/audio.py`**
- Added `KOKORO_*` keys to `TTS_CONFIG_KEYS` map
- Added `KOKORO_*` fields to `TTSConfigForm` model
- Added `_KOKORO_VOICES` allowlist (54 voices) — validates incoming `payload['voice']` against known Kokoro voices to prevent 404s from stale config values
- Added `load_kokoro_pipeline()` — lazily instantiates `KPipeline(lang_code=...)` on `app.state.kokoro_pipeline`
- Added `_tts_kokoro()` handler:
  - Reads lang code, voice, speed from config
  - Validates payload voice against allowlist, falls back to config default if invalid
  - Runs `KPipeline` off-thread via `asyncio.to_thread` (avoids blocking the event loop during inference)
  - Writes WAV to an in-memory buffer, transcodes to MP3 via `transcode_audio_to_mp3` (same pattern as piper engine) so cached files are real MP3 with correct MIME type
- Registered `'kokoro'` in `_TTS_ENGINES` dispatcher
- `get_available_models` returns `kokoro-82M`
- `get_available_voices` returns 28 English voices (`af_*`, `am_*`, `bf_*`, `bm_*`)

**`backend/open_webui/main.py`**
- Added `app.state.kokoro_pipeline = None` initialization

**`backend/requirements.txt`**
- Added `kokoro==0.9.4`

### Frontend

**`src/lib/components/admin/Settings/Audio.svelte`**
- Added `Kokoro (Local)` option to TTS engine dropdown
- Added state vars: `TTS_KOKORO_LANG_CODE`, `TTS_KOKORO_VOICE`, `TTS_KOKORO_SPEED`
- Added config UI block: Voice (datalist), Language Code (datalist with language names), Speed
- Wired vars into config-load (read from `res.tts`) and config-update (sent in `tts` payload)
- Engine-switch handler sets `TTS_VOICE`/`TTS_MODEL` defaults when Kokoro is selected

**`src/lib/components/chat/Messages/ResponseMessage.svelte`**
- Parallelized TTS sentence requests in `speak()` — all sentence requests fire immediately via `Promise` array, then awaited in order, enqueued as they resolve
- AudioQueue plays the first chunk while subsequent sentences are still synthesizing on the server
- Cuts perceived delay from (sum of all sentence synthesis times) to (time to first sentence)

## Bugs Fixed During Integration

1. **Wrong MIME type (no audio playback):** Initial handler wrote WAV bytes to a `.mp3` cache path. `FileResponse` inferred `Content-Type: audio/mpeg` from the extension, but the content was WAV — browsers silently failed to play it. Fixed by writing to an in-memory buffer and transcoding to real MP3 via `transcode_audio_to_mp3`.

2. **404 on voice download:** The frontend was sending the old Piper voice (`en_US-lessac-medium`) in the speech request payload. Kokoro tried to download a non-existent voice file from HuggingFace → 404 → exception → no audio. Fixed by adding a `_KOKORO_VOICES` allowlist; invalid payload voices are ignored and the config default is used.

3. **Sequential TTS delay:** The original `for...of` loop awaited each sentence's HTTP response before starting the next request, causing cumulative delay before audio started. Fixed by firing all requests in parallel and enqueuing results in order.

## Verification

- Config round-trip: upsert + get of all 3 Kokoro keys passes
- Dispatcher contains `kokoro` → `_tts_kokoro`
- Handler produces valid MP3 (ID3 header) from text input
- `/voices` returns 28 English voices; `/models` returns `kokoro-82M`
- Live dialogue test: audio plays correctly with `af_heart` voice