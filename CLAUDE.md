# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/` | Skills loaded inside agent containers (browser, status, formatting) |

## Secrets / Credentials / Proxy (OneCLI)

API keys, secret keys, OAuth tokens, and auth credentials are managed by the OneCLI gateway — which handles secret injection into containers at request time, so no keys or tokens are ever passed to containers directly. Run `onecli --help`.

## Skills

Four types of skills exist in NanoClaw. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and guidelines.

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-telegram`, `/add-slack`)
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/init-onecli` | Install OneCLI Agent Vault and migrate `.env` credentials to it |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Contributing

All PRs target `SimonKvalheim/universityClaw` — never the upstream `qwibitai/nanoclaw` repo. See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate skill, not bundled in core. Run `/add-whatsapp` (or `npx tsx scripts/apply-skill.ts .claude/skills/add-whatsapp && npm run build`) to install it. Existing auth credentials and groups are preserved.

## universityClaw Extensions

This is a fork of NanoClaw customized as a personal university teaching assistant ("Mr. Rogers").

### Subsystems

| Subsystem | Location | Purpose |
|-----------|----------|---------|
| Vault Utility | `src/vault/` | Direct Obsidian vault file I/O (gray-matter + regex) |
| Ingestion Pipeline | `src/ingestion/` | File watcher → Docling extraction → Claude note generation → auto-promotion |
| RAG Layer | `src/rag/` | LightRAG hybrid retrieval with SQLite-tracked indexing |
| RAG Indexer | `src/rag/indexer.ts` | Chokidar watcher with content-hash dedup, delete-before-reinsert lifecycle |
| Student Profile | `src/profile/` | Learning progress tracking, knowledge map, study log rotation |
| Web Dashboard | `dashboard/` | Next.js app for upload, verification status, vault browsing |
| Live Voice (`/voice`) | `dashboard/src/app/voice/` + `src/voice/` | Gemini Live brainstorm partner (Dev Assistant persona). See `docs/superpowers/specs/2026-04-18-live-voice-chat-design.md`. |

### Key Paths

- `vault/` — Obsidian vault (flat structure: `concepts/`, `sources/`, `profile/archive/`)
- `upload/` — Watched folder for new documents (processed files move to `upload/processed/`)
- `dashboard/` — Next.js web dashboard
- `scripts/docling-extract.py` — Python document extraction script
- `store/messages.db` — SQLite database (messages, tasks, ingestion jobs, RAG tracker)
- `data/` — IPC files, extraction artifacts
- `data/voice.log` — JSON-line structured log for the live voice feature (session start/end, tool calls)
- `docs/superpowers/brainstorm-sessions/` — voice session transcripts (dogfooded; NOT indexed by RAG)
- `docs/superpowers/mockups/` — Dev-Assistant-authored HTML mockups and mermaid diagrams
- `onecli/` — OneCLI credential gateway config (containers already built; for new installs, run `/init-onecli`)

### Testing

- `npm test` — Run all tests (vitest)
- `cd dashboard && npm test` — Dashboard tests

## Services & Dependencies

universityClaw runs as a stack of 4 services. All must be running for full functionality.

### Service Stack

| Service | What it does | How to start | How to stop | Port |
|---------|-------------|--------------|-------------|------|
| **NanoClaw** | Main orchestrator (Node.js) | `npm run dev` | Ctrl+C or `kill <pid>` | — |
| **LightRAG** | RAG server (Python, venv) | `./scripts/lightrag-server.sh --daemon` | `./scripts/lightrag-server.sh --stop` | 9621 |
| **OneCLI** | Credential proxy (Docker) | `docker restart onecli-app-1 onecli-postgres-1` | `docker stop onecli-app-1 onecli-postgres-1` | 10254 |
| **Dashboard** | Web UI (Next.js) | `cd dashboard && npm run dev` | Ctrl+C or `kill <pid>` | 3100 |

### Start Everything

```bash
# 1. OneCLI (credential proxy — restart existing containers)
docker restart onecli-app-1 onecli-postgres-1

# 2. LightRAG (RAG server — script sets working-dir to ./store/rag and reads config from .env)
./scripts/lightrag-server.sh --daemon

# 3. Dashboard (web UI — background)
cd dashboard && npm run dev &
cd ..

# 4. NanoClaw (main process — foreground)
npm run dev
```

### Stop Everything

```bash
# Stop services (script uses the PID file written by --daemon)
./scripts/lightrag-server.sh --stop
pkill -f "tsx src/index.ts"
pkill -f "next dev.*dashboard"

# Stop OneCLI containers
docker stop onecli-app-1 onecli-postgres-1
```

### Verify Status

```bash
# Check all processes
ps aux | grep -iE "nanoclaw|universityClaw|lightrag|next.*dashboard" | grep -v grep

# Check Docker
docker ps --format "table {{.Names}}\t{{.Status}}"
```

### Environment Variables

Key env vars (set in `.env` or shell). All have sensible defaults:

| Variable | Default | Purpose |
|----------|---------|---------|
| `ASSISTANT_NAME` | `Andy` (should be `Mr. Rogers`) | Bot name and trigger word |
| `VAULT_DIR` | `./vault` | Obsidian vault path |
| `UPLOAD_DIR` | `./upload` | Ingestion watch directory |
| `ONECLI_URL` | `http://localhost:10254` | OneCLI gateway URL |
| `CONTAINER_IMAGE` | `nanoclaw-agent:latest` | Docker image for agent containers |
| `CONTAINER_TIMEOUT` | `1800000` (30min) | Agent container idle timeout |
| `MAX_CONCURRENT_CONTAINERS` | `5` | Parallel container limit |
| `EXTRACTION_TIMEOUT` | `600000` (10min) | Docling per-document timeout |
| `DASHBOARD_PORT` | `3100` | Dashboard web UI port |
| `GEMINI_API_KEY` | — | Gemini API key — used by TTS/STT and by `/voice` (live voice chat) |
| `VOICE_MONTHLY_BUDGET_USD` | — | Optional — surfaces an amber banner on `/voice` when monthly cost exceeds this |
| `LIGHTRAG_LLM_BINDING` | `openai` | LightRAG LLM provider |
| `LIGHTRAG_LLM_MODEL` | `gpt-4o-mini` | LightRAG LLM model |
| `LIGHTRAG_EMBED_BINDING` | `openai` | LightRAG embedding provider |
| `LIGHTRAG_EMBED_MODEL` | `text-embedding-3-small` | LightRAG embedding model |
| `TZ` | auto-detected | Timezone for scheduling |

## Database Migrations

**All schema changes to `store/messages.db` MUST go through Drizzle migrations.** Never run `CREATE TABLE`, `ALTER TABLE`, `CREATE INDEX`, etc. directly against the DB — not in dev, not to "try something out." Doing so desyncs the live schema from `drizzle/migrations/` and breaks startup for every other install when the eventual migration tries to create an object that already exists.

Workflow for any schema change:
1. Edit the schema file in `src/db/schema*.ts`
2. Run `npx drizzle-kit generate` to create a new migration SQL in `drizzle/migrations/`
3. Commit both the schema edit and the generated migration together
4. Migrations apply automatically on next `npm run dev` / NanoClaw start via `runMigrations` in `src/db/migrate.ts`

If you hit drift (migration fails because the object already exists and the table is empty / data is disposable): the clean fix is to drop the offending object and let the migration recreate it. Only mark a migration as pre-applied by inserting its SHA256 hash into `__drizzle_migrations` when you have verified the live schema matches the migration SQL exactly.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.

## Design Specs

Active design documents live in `docs/superpowers/specs/`. Implementation plans in `docs/superpowers/plans/`. Check these before making changes to covered subsystems.
