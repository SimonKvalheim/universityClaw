<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="universityClaw" width="400">
</p>

<p align="center">
  A personal university teaching assistant built on <a href="https://github.com/qwibitai/nanoclaw">NanoClaw</a>. Processes course materials, generates study notes, runs quizzes, and manages an Obsidian knowledge vault — all through Telegram.
</p>

---

## What is this?

**universityClaw** is a fork of [NanoClaw](https://github.com/qwibitai/nanoclaw) customized as a university teaching assistant for a Digital Transformation degree program. It extends NanoClaw's secure agent-in-container architecture with:

- **Document ingestion** — Upload PDFs, slides, and readings. They're processed into structured Obsidian study notes with metadata, tags, and wikilinks.
- **Review workflow** — Drafts go through a review queue before entering the vault. Chat with the agent to refine notes before approving.
- **RAG retrieval** — Hybrid search over the Obsidian vault so the agent can ground answers in your actual course material.
- **Quiz generation** — Generate questions from specific courses or topics, with adaptive difficulty and knowledge tracking.
- **Student profile** — Tracks courses, knowledge confidence, and study activity over time.
- **Web dashboard** — Next.js app for uploading documents, reviewing drafts, and browsing the vault.

## Architecture

Built on NanoClaw's single-process, container-isolated design:

```
Telegram / Web Dashboard
        ↓
    Orchestrator (Node.js)
        ↓
  ┌─────┴─────┐
  │  Ingestion │ ← File watcher → Docling extraction → Agent note generation → Review queue
  │  Pipeline  │
  └─────┬─────┘
        ↓
  Container (Claude Agent SDK) ← RAG retrieval over Obsidian vault
        ↓
    Response → Telegram / Dashboard
```

### Key additions over NanoClaw

| Subsystem | Path | Purpose |
|-----------|------|---------|
| Vault utility | `src/vault/` | Direct Obsidian vault file I/O (frontmatter, wikilinks) |
| Ingestion pipeline | `src/ingestion/` | File watcher → Docling → agent note gen → review queue |
| RAG layer | `src/rag/` | LightRAG hybrid retrieval over the vault |
| Student profile | `src/profile/` | Learning progress tracking |
| Web channel | `src/channels/web.ts` | Dashboard ↔ agent communication |
| Web dashboard | `dashboard/` | Next.js app (submodule) |

## Getting Started

This is a personal project. If you want something similar, fork [NanoClaw](https://github.com/qwibitai/nanoclaw) and customize it for your own needs — that's the NanoClaw philosophy.

If you're interested in the approach:

1. Fork this repo (or NanoClaw directly)
2. `npm install`
3. Copy `.env.example` to `.env` and fill in your credentials
4. `npm run dev`

See the [NanoClaw docs](https://docs.nanoclaw.dev) for the base platform setup.

## Development

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
npm test             # Run all tests (vitest)
cd dashboard && npm test  # Dashboard tests
./container/build.sh # Rebuild agent container
```

## Upstream

This project is a fork of [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw). Core NanoClaw functionality (channels, container isolation, scheduling, IPC) comes from upstream. The extensions listed above are specific to this fork.

To pull upstream updates: run `/update-nanoclaw` inside Claude Code.

## License

MIT — same as NanoClaw.
