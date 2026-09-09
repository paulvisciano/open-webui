#!/usr/bin/env bash
set -uo pipefail

PORT="${PORT:-8080}"
LLM_PORT="${LLM_PORT:-8082}"

TMUX_PREFIX="open-webui"

if command -v tmux &>/dev/null; then
	for name in frontend backend llama; do
        if tmux has-session -t "$TMUX_PREFIX-$name" 2>/dev/null; then
            echo "Killing tmux session: $TMUX_PREFIX-$name"
            tmux kill-session -t "$TMUX_PREFIX-$name" 2>/dev/null || true
        fi
    done
fi

PID_FILE="$(cd "$(dirname "$0")" && pwd)/.start-all.pids"
if [[ -f "$PID_FILE" ]]; then
    for pid in $(cat "$PID_FILE"); do
        kill "$pid" 2>/dev/null || true
    done
    rm -f "$PID_FILE"
    sleep 2
fi

stop_port() {
    local name="$1" port="$2"
    if pid="$(lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null)" && [[ -n "$pid" ]]; then
        echo "Stopping $name (port $port, PID $pid)..."
        kill $pid 2>/dev/null || true
    else
        echo "$name (port $port) — not running."
    fi
}

stop_port "frontend"    5173
stop_port "backend"     "$PORT"
stop_port "llama-server" "$LLM_PORT"

sleep 2

for port in 5173 "$PORT" "$LLM_PORT"; do
    if pid="$(lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null)" && [[ -n "$pid" ]]; then
        echo "Force killing port $port (PID $pid)..."
        kill -9 $pid 2>/dev/null || true
    fi
done

echo "All services stopped."