#!/usr/bin/env bash
set -euo pipefail

# start-all.sh — Start llama-server, Open WebUI backend, and frontend together.
#
# Defaults:
#   llama-server  → http://localhost:8082   (LLM_PORT)
#   backend       → http://localhost:8080   (PORT)
#   frontend      → http://localhost:5173
#
# Usage:
#   ./start-all.sh             # foreground (Ctrl+C stops everything)
#   ./start-all.sh --background  # tmux sessions, script exits after startup
#
# Override any env var before running, e.g.:
#   LLM_PORT=9000 ./start-all.sh

BACKGROUND=false
for arg in "$@"; do
    case "$arg" in
        --background|-d) BACKGROUND=true ;;
        --help|-h)
            echo "Usage: $0 [--background|-d]"
            echo "  --background  Run services in tmux sessions; exit after startup."
            exit 0 ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

TMUX_PREFIX="open-webui"

LLM_PORT="${LLM_PORT:-8082}"
PORT="${PORT:-8080}"

MODEL_DIR="${MODEL_DIR:-$HOME/models}"
LLM_MODEL_PATH="${LLM_MODEL_PATH:-$MODEL_DIR/bonsai-27b/Bonsai-27B-Q1_0.gguf}"
MMPROJ_PATH="${MMPROJ_PATH:-$MODEL_DIR/bonsai-27b/Bonsai-27B-mmproj-Q8_0.gguf}"
LLM_MODEL_ALIAS="${LLM_MODEL_ALIAS:-Bonsai-27B-Q1_0}"

LLM_REPEAT_PENALTY="${LLM_REPEAT_PENALTY:-1.15}"
LLM_REPEAT_LAST_N="${LLM_REPEAT_LAST_N:-128}"
LLM_DRY_MULTIPLIER="${LLM_DRY_MULTIPLIER:-0.8}"
LLM_DRY_BASE="${LLM_DRY_BASE:-1.75}"
LLM_DRY_ALLOWED_LENGTH="${LLM_DRY_ALLOWED_LENGTH:-3}"
LLM_XTC_PROBABILITY="${LLM_XTC_PROBABILITY:-0.1}"
LLM_XTC_THRESHOLD="${LLM_XTC_THRESHOLD:-0.1}"
LLM_SLOTS="${LLM_SLOTS:-1}"

LLAMA_PID=""
TTS_PID=""
BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
    echo ""
    echo "Stopping all services..."
    for pid in "$FRONTEND_PID" "$BACKEND_PID" "$TTS_PID" "$LLAMA_PID"; do
        [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
    done
    wait 2>/dev/null || true
    echo "Stopped."
}
if [[ "$BACKGROUND" == "false" ]]; then
    trap cleanup EXIT INT TERM
fi

KG_LLAMA_SERVER="$HOME/Projects/knowledge-graph/vendor/llama.cpp/src/build/bin/llama-server"
HOMEBREW_LLAMA_SERVER="$(which llama-server 2>/dev/null || echo /opt/homebrew/bin/llama-server)"

if [[ -x "$KG_LLAMA_SERVER" ]]; then
    LLAMA_SERVER="$KG_LLAMA_SERVER"
    export DYLD_LIBRARY_PATH="$HOME/Projects/knowledge-graph/vendor/llama.cpp/src/build/bin:${DYLD_LIBRARY_PATH:-}"
    echo "Using project-built llama-server (Metal): $LLAMA_SERVER"
elif [[ -x "$HOMEBREW_LLAMA_SERVER" ]]; then
    LLAMA_SERVER="$HOMEBREW_LLAMA_SERVER"
    echo "WARNING: Using Homebrew llama-server — Metal may not be available."
else
    echo "ERROR: llama-server not found."
    echo "  Option 1: Run ~/Projects/knowledge-graph/scripts/build-llama-cpp.sh"
    echo "  Option 2: brew install llama.cpp (CPU-only)"
    exit 1
fi

if [[ ! -f "$LLM_MODEL_PATH" ]]; then
    echo "ERROR: Model file not found: $LLM_MODEL_PATH"
    echo "  Run ~/Projects/knowledge-graph/scripts/download-models.sh first"
    exit 1
fi

MMPROJ_FLAG=""
if [[ -f "$MMPROJ_PATH" ]]; then
    MMPROJ_FLAG="--mmproj $MMPROJ_PATH"
    echo "Vision mmproj: $MMPROJ_PATH"
else
    echo "WARNING: mmproj not found at $MMPROJ_PATH — vision/image input disabled"
fi

if existing_pid="$(lsof -ti tcp:"$LLM_PORT" -sTCP:LISTEN 2>/dev/null)" && [[ -n "$existing_pid" ]]; then
    echo "Port $LLM_PORT in use (PID $existing_pid) — killing it."
    kill "$existing_pid" 2>/dev/null || true
    sleep 2
fi

if [[ "$BACKGROUND" == "true" ]]; then
    if ! command -v tmux &>/dev/null; then
        echo "ERROR: tmux not found. Install with: brew install tmux"
        exit 1
    fi
    tmux kill-session -t "$TMUX_PREFIX-llama" 2>/dev/null || true
    tmux kill-session -t "$TMUX_PREFIX-piper" 2>/dev/null || true
    tmux kill-session -t "$TMUX_PREFIX-backend" 2>/dev/null || true
    tmux kill-session -t "$TMUX_PREFIX-frontend" 2>/dev/null || true
fi

LLAMA_CMD=(
    "$LLAMA_SERVER"
    -m "$LLM_MODEL_PATH"
    --alias "$LLM_MODEL_ALIAS"
    $MMPROJ_FLAG
    --image-max-tokens 280 --image-min-tokens 40
    -c 32768 -b 2048 -ub 2048
    -ctk f16 -ctv f16
    -np "$LLM_SLOTS" -fa on -cram 0 -ngl 99
    --repeat-penalty "$LLM_REPEAT_PENALTY" --repeat-last-n "$LLM_REPEAT_LAST_N"
    --dry-multiplier "$LLM_DRY_MULTIPLIER" --dry-base "$LLM_DRY_BASE" --dry-allowed-length "$LLM_DRY_ALLOWED_LENGTH"
    --xtc-probability "$LLM_XTC_PROBABILITY" --xtc-threshold "$LLM_XTC_THRESHOLD"
    --reasoning off --reasoning-budget 0
    --host 0.0.0.0 --port "$LLM_PORT"
)

echo "▶ Starting llama-server on port $LLM_PORT..."
if [[ "$BACKGROUND" == "true" ]]; then
    tmux new-session -d -s "$TMUX_PREFIX-llama" "${LLAMA_CMD[*]} 2>&1 | tee /tmp/bonsai-llama.log"
else
    "${LLAMA_CMD[@]}" &>/tmp/bonsai-llama.log &
    LLAMA_PID=$!
fi

echo -n "  waiting for llama-server..."
for i in $(seq 1 120); do
    if curl -sf "http://localhost:${LLM_PORT}/health" &>/dev/null; then
        echo " ✓ ready"
        break
    fi
    echo -n "."
    sleep 1
    [[ "$i" -eq 120 ]] && { echo " ✗ FAILED"; tail -20 /tmp/bonsai-llama.log; exit 1; }
done

echo "▶ Starting Open WebUI backend on port $PORT..."

# Auto-detect primary LAN IP for cross-device access (phone, tablet, etc.)
LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "")

# Generate/regenerate HTTPS cert for the LAN IP so phone mic/camera work over HTTPS
if [[ -n "$LAN_IP" ]] && command -v mkcert &>/dev/null; then
    mkdir -p "$SCRIPT_DIR/certs"
    if [[ ! -f "$SCRIPT_DIR/certs/cert.pem" ]] || ! grep -q "$LAN_IP" "$SCRIPT_DIR/certs/cert.pem" 2>/dev/null; then
        echo "▶ Generating HTTPS cert for localhost + $LAN_IP..."
        mkcert -cert-file "$SCRIPT_DIR/certs/cert.pem" -key-file "$SCRIPT_DIR/certs/key.pem" localhost "$LAN_IP" 2>/dev/null
    fi
    CA_B64=$(base64 -i "$(mkcert -CAROOT)/rootCA.pem")
    cat > "$SCRIPT_DIR/static/install-ca.html" << CAEOF
<!doctype html>
<html>
<head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Install Root CA</title></head>
<body style="font-family:system-serif;padding:2rem;max-width:600px;margin:auto">
<h2>Install mkcert Root CA</h2>
<p>Tap the button below to download the root CA certificate, then install it in your device settings.</p>
<button onclick="dl()" style="font-size:1.2rem;padding:1rem 2rem;background:#007aff;color:#fff;border:none;border-radius:12px;cursor:pointer">Download Certificate</button>
<script>
function dl(){
  const b64 = "$CA_B64";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
  const blob = new Blob([bytes],{type:'application/x-x509-ca-cert'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href=url; a.download='mkcert-rootCA.crt'; a.click();
  URL.revokeObjectURL(url);
}
</script>
<h3>After download:</h3>
<p><b>iPhone:</b> Settings → Profile Downloaded → Install → Settings → General → About → Certificate Trust Settings → enable mkcert</p>
<p><b>Android:</b> Settings → Security → Install a certificate → CA certificate → select the file</p>
</body>
</html>
CAEOF
fi

export CORS_ALLOW_ORIGIN="http://localhost:5173;http://localhost:${PORT};https://localhost:5173;https://localhost:${PORT}"
if [[ -n "$LAN_IP" ]]; then
    export CORS_ALLOW_ORIGIN="${CORS_ALLOW_ORIGIN};http://${LAN_IP}:5173;http://${LAN_IP}:${PORT};https://${LAN_IP}:5173;https://${LAN_IP}:${PORT}"
fi
export OPENAI_API_BASE_URL="http://localhost:${LLM_PORT}/v1"
export OPENAI_API_KEY="dummy"
export WEBUI_SECRET_KEY="${WEBUI_SECRET_KEY:-$(head -c 24 /dev/random | base64)}"

if [[ "$BACKGROUND" == "true" ]]; then
    tmux new-session -d -s "$TMUX_PREFIX-backend" \
        "cd '$SCRIPT_DIR/backend' && CORS_ALLOW_ORIGIN='$CORS_ALLOW_ORIGIN' OPENAI_API_BASE_URL='$OPENAI_API_BASE_URL' OPENAI_API_KEY='$OPENAI_API_KEY' WEBUI_SECRET_KEY='$WEBUI_SECRET_KEY' uv run uvicorn open_webui.main:app --port '$PORT' --host 0.0.0.0 --forwarded-allow-ips '*' --reload --ssl-keyfile '$SCRIPT_DIR/certs/key.pem' --ssl-certfile '$SCRIPT_DIR/certs/cert.pem' 2>&1 | tee /tmp/open-webui-backend.log"
else
    cd "$SCRIPT_DIR/backend"
    uv run uvicorn open_webui.main:app --port "$PORT" --host 0.0.0.0 --forwarded-allow-ips "*" --reload \
        --ssl-keyfile "$SCRIPT_DIR/certs/key.pem" --ssl-certfile "$SCRIPT_DIR/certs/cert.pem" \
        &>/tmp/open-webui-backend.log &
    BACKEND_PID=$!
    cd "$SCRIPT_DIR"
fi

echo "▶ Starting frontend on port 5173..."
if [[ "$BACKGROUND" == "true" ]]; then
    tmux new-session -d -s "$TMUX_PREFIX-frontend" \
        "cd '$SCRIPT_DIR' && npm run dev 2>&1 | tee /tmp/open-webui-frontend.log"
else
    cd "$SCRIPT_DIR"
    npm run dev &
    FRONTEND_PID=$!
fi

echo ""
echo "═══ All services running ═══"
echo "  Frontend:    http://localhost:5173"
echo "  Backend:     http://localhost:${PORT}"
echo "  Llama API:   http://localhost:${LLM_PORT}/v1/models"
echo ""
if [[ "$BACKGROUND" == "true" ]]; then
    echo "  Tmux sessions: tmux ls | grep $TMUX_PREFIX"
    echo "  Attach:        tmux attach -t $TMUX_PREFIX-backend"
    echo "  Stop:          ./stop-all.sh"
else
    echo "  Press Ctrl+C to stop all services."
fi
echo ""

(
    for i in $(seq 1 60); do
        if curl -sf "http://localhost:5173" &>/dev/null; then
            break
        fi
        sleep 1
        [[ "$i" -eq 60 ]] && { echo "  Frontend not ready — skipping browser launch."; exit 0; }
    done
    echo "▶ Opening browser: http://localhost:5173"
    if command -v open &>/dev/null; then
        open "http://localhost:5173"
    elif command -v xdg-open &>/dev/null; then
        xdg-open "http://localhost:5173"
    else
        echo "  No browser launcher found (open/xdg-open). Open http://localhost:5173 manually."
    fi
)

if [[ "$BACKGROUND" == "false" ]]; then
    wait
fi