#!/usr/bin/env bash
# Start the LightRAG API server for vault semantic search.
# Default: Ollama with nomic-embed-text + qwen2.5:3b on port 9621.
#
# Usage:
#   ./scripts/lightrag-server.sh              # foreground
#   ./scripts/lightrag-server.sh --daemon      # background (logs to store/rag/server.log)
#   ./scripts/lightrag-server.sh --stop        # stop background server
#
# Environment overrides:
#   LIGHTRAG_PORT          (default: 9621)
#   LIGHTRAG_LLM_MODEL     (default: qwen2.5:3b)
#   LIGHTRAG_EMBED_MODEL   (default: nomic-embed-text)
#   LIGHTRAG_LLM_BINDING   (default: ollama)
#   LIGHTRAG_EMBED_BINDING (default: ollama)
#   LIGHTRAG_OLLAMA_HOST   (default: http://localhost:11434)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VENV="$PROJECT_ROOT/.venv/bin"
RAG_DIR="$PROJECT_ROOT/store/rag"

mkdir -p "$RAG_DIR"

# Stop command
if [[ "${1:-}" == "--stop" ]]; then
  if [[ -f "$RAG_DIR/server.pid" ]]; then
    PID=$(cat "$RAG_DIR/server.pid")
    kill "$PID" 2>/dev/null && echo "Stopped LightRAG server (PID $PID)" || echo "Server not running"
    rm -f "$RAG_DIR/server.pid"
  else
    echo "No PID file found"
  fi
  exit 0
fi

# LightRAG reads these env vars (no LIGHTRAG_ prefix, see lightrag.api.config)
export WORKING_DIR="$RAG_DIR"
export INPUT_DIR="$PROJECT_ROOT/vault"
export HOST="0.0.0.0"
export PORT="${LIGHTRAG_PORT:-9621}"
export LLM_BINDING="${LIGHTRAG_LLM_BINDING:-ollama}"
export LLM_MODEL="${LIGHTRAG_LLM_MODEL:-qwen2.5:3b}"
export LLM_BINDING_HOST="${LIGHTRAG_OLLAMA_HOST:-http://localhost:11434}"
export EMBEDDING_BINDING="${LIGHTRAG_EMBED_BINDING:-ollama}"
export EMBEDDING_MODEL="${LIGHTRAG_EMBED_MODEL:-nomic-embed-text}"
export EMBEDDING_BINDING_HOST="${LIGHTRAG_OLLAMA_HOST:-http://localhost:11434}"
export EMBEDDING_DIM="${LIGHTRAG_EMBED_DIM:-768}"
# Disable auth for local use (container accesses via host.docker.internal)
export LIGHTRAG_API_KEY=""
export TOKEN_SECRET="nanoclaw-local-lightrag"

if [[ "${1:-}" == "--daemon" ]]; then
  LOG_FILE="$RAG_DIR/server.log"
  echo "Starting LightRAG server in background (port $PORT, log: $LOG_FILE)"
  nohup "$VENV/python3" -m lightrag.api.lightrag_server > "$LOG_FILE" 2>&1 &
  echo $! > "$RAG_DIR/server.pid"
  echo "PID: $(cat "$RAG_DIR/server.pid")"
else
  echo "Starting LightRAG server (port $PORT, working_dir: $RAG_DIR)"
  echo "Models: LLM=$LLM_MODEL ($LLM_BINDING), Embed=$EMBEDDING_MODEL ($EMBEDDING_BINDING)"
  exec "$VENV/python3" -m lightrag.api.lightrag_server
fi
