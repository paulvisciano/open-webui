#!/usr/bin/env bash
set -euo pipefail

# start-all.sh — Start llama-server, Open WebUI backend, frontend, and Knowledge Graph MCP together.
#
# Defaults:
#   llama-server  → http://localhost:8082   (LLM_PORT)
#   backend       → http://localhost:8080   (PORT)
#   frontend      → https://localhost:5173
#   kg-mcp        → http://localhost:9653/mcp  (MCP_PORT)
#   lightrag      → http://localhost:9621   (LIGHTRAG_PORT, Docker)
#
# Usage:
#   ./start-all.sh             # foreground (Ctrl+C stops everything)
#   ./start-all.sh --background  # tmux sessions, script exits after startup
#
# Override any env var before running, e.g.:
#   LLM_PORT=9000 ./start-all.sh
#
# Knowledge Graph env vars (all optional — defaults point to the local
# knowledge-graph Docker stack):
#   KG_DIR              — knowledge-graph project root (default ~/Projects/knowledge-graph)
#   MCP_PORT            — MCP server port (default 9653)
#   LIGHTRAG_PORT       — LightRAG REST port (default 9621)
#   LIGHTRAG_API_URL     — LightRAG REST base URL (default http://localhost:9621)
#   LIGHTRAG_API_KEY     — API key for LightRAG (default "")
#   KG_API_URL           — Knowledge Graph API base URL (default http://localhost:8000)

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
MCP_PORT="${MCP_PORT:-9653}"
LIGHTRAG_PORT="${LIGHTRAG_PORT:-9621}"
KG_DIR="${KG_DIR:-$HOME/Projects/knowledge-graph}"

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
MCP_PID=""

cleanup() {
    echo ""
    echo "Stopping all services..."
    for pid in "$FRONTEND_PID" "$BACKEND_PID" "$MCP_PID" "$TTS_PID" "$LLAMA_PID"; do
        [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
    done
    wait 2>/dev/null || true
    rm -f "$SCRIPT_DIR/.start-all.pids"
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
    tmux kill-session -t "$TMUX_PREFIX-mcp" 2>/dev/null || true
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

# ─── LightRAG (Docker) ─────────────────────────────────────────────────────
# Starts the LightRAG + Postgres containers from the knowledge-graph Docker
# stack.  The MCP facade proxies query/save calls to LightRAG (:9621), so it
# must be up before the MCP server starts.
KG_COMPOSE_FILE="$KG_DIR/docker-compose.yml"
if [[ ! -f "$KG_COMPOSE_FILE" ]]; then
    echo "ERROR: docker-compose.yml not found at $KG_COMPOSE_FILE"
    echo "  Set KG_DIR to the knowledge-graph project root."
    exit 1
fi

if ! command -v docker &>/dev/null; then
    echo "ERROR: docker not found. Start Docker Desktop first."
    exit 1
fi

if ! docker info &>/dev/null; then
    echo "▶ Starting Docker Desktop..."
    open -a Docker
    echo -n "  waiting for Docker daemon..."
    for i in $(seq 1 60); do
        docker info &>/dev/null && { echo " ✓ ready"; break; }
        echo -n "."
        sleep 2
        [[ "$i" -eq 60 ]] && { echo " ✗ FAILED"; exit 1; }
    done
fi

echo "▶ Starting LightRAG + Postgres via docker compose..."
docker compose -f "$KG_COMPOSE_FILE" up -d lightrag postgres

echo -n "  waiting for LightRAG on port $LIGHTRAG_PORT..."
for i in $(seq 1 30); do
    code="$(curl -sk -o /dev/null -w "%{http_code}" "http://localhost:${LIGHTRAG_PORT}/health" 2>/dev/null || echo "000")"
    if [[ "$code" == "200" ]]; then
        echo " ✓ ready"
        break
    fi
    echo -n "."
    sleep 2
    [[ "$i" -eq 30 ]] && { echo " ✗ FAILED"; docker logs knowledge-graph-lightrag --tail 20 2>/dev/null; exit 1; }
done

# ─── Knowledge Graph MCP ───────────────────────────────────────────────────
# Starts the MCP facade server (mcp-services/) via uv run — it manages its own
# venv.  The server proxies query/save/navigate calls to LightRAG (:9621) and
# the KG API (:8000), both expected to be running from the knowledge-graph
# Docker stack.
if existing_mcp_pid="$(lsof -ti tcp:"$MCP_PORT" -sTCP:LISTEN 2>/dev/null)" && [[ -n "$existing_mcp_pid" ]]; then
    echo "Port $MCP_PORT in use (PID $existing_mcp_pid) — killing it."
    kill "$existing_mcp_pid" 2>/dev/null || true
    sleep 1
fi

MCP_DIR="$SCRIPT_DIR/mcp-services"
export MEMORY_SEARCH_MCP_PORT="$MCP_PORT"
echo "▶ Starting Knowledge Graph MCP on port $MCP_PORT..."
if [[ "$BACKGROUND" == "true" ]]; then
    tmux new-session -d -s "$TMUX_PREFIX-mcp" \
        "cd '$MCP_DIR' && MEMORY_SEARCH_MCP_PORT='$MCP_PORT' uv run python -m knowledge_graph_mcp 2>&1 | tee /tmp/open-webui-mcp.log"
else
    cd "$MCP_DIR"
    uv run python -m knowledge_graph_mcp &>/tmp/open-webui-mcp.log &
    MCP_PID=$!
    cd "$SCRIPT_DIR"
fi

echo -n "  waiting for MCP server..."
for i in $(seq 1 30); do
    if lsof -ti tcp:"$MCP_PORT" -sTCP:LISTEN &>/dev/null; then
        echo " ✓ ready"
        break
    fi
    echo -n "."
    sleep 1
    [[ "$i" -eq 30 ]] && { echo " ✗ FAILED"; tail -20 /tmp/open-webui-mcp.log; exit 1; }
done

# Kokoro TTS runs in-process inside the backend (not a separate daemon).
if ! command -v espeak-ng &>/dev/null; then
    echo "WARNING: espeak-ng not found — server Kokoro TTS needs it (brew install espeak-ng)"
fi
echo "▶ Ensuring kokoro TTS is installed..."
VENV_PY="$SCRIPT_DIR/.venv/bin/python"
if [[ ! -x "$VENV_PY" ]] || ! "$VENV_PY" -c "from kokoro import KPipeline" &>/dev/null; then
    echo "  installing kokoro==0.9.4 into the project venv..."
    uv pip install 'kokoro==0.9.4' --python "$VENV_PY"
fi

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
export TOOL_SERVER_CONNECTIONS="[{\"url\":\"http://localhost:${MCP_PORT}/mcp\",\"path\":\"/mcp\",\"type\":\"mcp\",\"auth_type\":\"none\",\"key\":null,\"config\":{\"enable\":true,\"access_grants\":[{\"principal_type\":\"user\",\"principal_id\":\"*\",\"permission\":\"read\"}]},\"info\":{\"id\":\"knowledge-graph\",\"name\":\"Knowledge Graph\"}}]"

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
echo "  Frontend:    https://localhost:5173"
if [[ -n "$LAN_IP" ]]; then
    echo "  Frontend:    https://${LAN_IP}:5173  (LAN — use this from your phone)"
fi
echo "  Backend:     https://localhost:${PORT}"
if [[ -n "$LAN_IP" ]]; then
    echo "  Backend:     https://${LAN_IP}:${PORT}  (LAN)"
fi
echo "  Llama API:   http://localhost:${LLM_PORT}/v1/models"
echo "  KG MCP:      http://localhost:${MCP_PORT}/mcp"
if [[ -n "$LAN_IP" ]] && [[ -f "$SCRIPT_DIR/static/install-ca.html" ]]; then
    echo ""
    echo "  Phone setup: open https://${LAN_IP}:5173/install-ca.html on your phone,"
    echo "  download the CA cert, then install & trust it in device settings."
fi
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
        if curl -skf "https://localhost:5173" &>/dev/null; then
            break
        fi
        sleep 1
        [[ "$i" -eq 60 ]] && { echo "  Frontend not ready — skipping browser launch."; exit 0; }
    done
    echo "▶ Opening browser: https://localhost:5173"
    if command -v open &>/dev/null; then
        open "https://localhost:5173"
    elif command -v xdg-open &>/dev/null; then
        xdg-open "https://localhost:5173"
    else
        echo "  No browser launcher found (open/xdg-open). Open https://localhost:5173 manually."
    fi
)

if [[ "$BACKGROUND" == "false" ]]; then
    # Record PIDs so stop-all.sh can clean up even if it can't reach the ports.
    : > "$SCRIPT_DIR/.start-all.pids"
    [[ -n "$LLAMA_PID" ]]     && echo "$LLAMA_PID"     >> "$SCRIPT_DIR/.start-all.pids"
    [[ -n "$MCP_PID" ]]       && echo "$MCP_PID"       >> "$SCRIPT_DIR/.start-all.pids"
    [[ -n "$BACKEND_PID" ]]   && echo "$BACKEND_PID"   >> "$SCRIPT_DIR/.start-all.pids"
    [[ -n "$FRONTEND_PID" ]]  && echo "$FRONTEND_PID"  >> "$SCRIPT_DIR/.start-all.pids"
    wait
fi