# universityClaw Architecture

Four diagrams, zooming in: **system context → running services → NanoClaw internals → end-to-end flows**.

All diagrams are [Mermaid](https://mermaid.js.org/) and render natively on GitHub. Edit the source below to keep them in sync with the code.

Quick map of where things live:

| Concern | Code |
|---|---|
| Orchestrator + startup | [src/index.ts](../src/index.ts) |
| Channel registry + implementations | [src/channels/](../src/channels/) |
| Outbound formatting + routing | [src/router.ts](../src/router.ts) |
| Agent container spawn | [src/container-runner.ts](../src/container-runner.ts) |
| Host ↔ container IPC | [src/ipc.ts](../src/ipc.ts), `data/ipc/` |
| Cron-style tasks | [src/task-scheduler.ts](../src/task-scheduler.ts) |
| Document ingestion | [src/ingestion/](../src/ingestion/) |
| RAG indexing + client | [src/rag/](../src/rag/) |
| SQLite schema (Drizzle) | [src/db/schema/](../src/db/schema/) |
| Web UI | [dashboard/](../dashboard/) |

---

## 1. System context

Who uses universityClaw, and what external systems does it depend on?

```mermaid
flowchart LR
    simon([Simon])

    tg["Telegram<br/>Bot API"]
    claude["Claude API"]
    gemini["Gemini API<br/>(TTS / STT)"]
    zotero["Zotero<br/>library"]

    subgraph uc["universityClaw (local host)"]
        core["NanoClaw core<br/><sub>channels · agent runner ·<br/>ingestion · RAG indexer</sub>"]
        dash["Dashboard<br/><sub>Next.js UI</sub>"]
        vault[("Obsidian vault<br/><sub>concepts, sources, profile</sub>")]
    end

    simon <-->|"chat: 'Mr. Rogers …'"| tg
    tg <-->|gramjs| core

    simon <-->|browser| dash
    simon -->|"drop PDFs → upload/"| core
    simon <-->|edit notes| vault

    core <-->|"auto-ingest"| zotero
    core -->|"prompts (via local OneCLI gateway)"| claude
    core -->|"audio synthesis + transcription"| gemini

    core <--> vault
    dash <--> vault
```

**Notes**

- OneCLI is a **local** credential gateway (`:10254`), not an external service — it proxies to Claude (and others) while keeping secrets off the container.
- Telegram is the only remote channel wired up in `src/channels/` today (`web.ts` is served by the dashboard). WhatsApp/Slack/Discord/Gmail exist as optional skill branches.

---

## 2. Running services

Four long-lived processes run on the host. Each has a different lifecycle and port.

```mermaid
flowchart TB
    simon([Simon])
    tg["Telegram"]
    claudeapi[["Claude API"]]

    subgraph host["Host machine"]
        direction TB

        subgraph procs["Node / Python processes"]
            core["NanoClaw<br/><sub>tsx src/index.ts</sub>"]
            rag["LightRAG<br/><sub>:9621 · python venv</sub>"]
            dash["Dashboard<br/><sub>:3100 · next dev</sub>"]
        end

        subgraph docker["Docker"]
            onecli["OneCLI gateway<br/><sub>:10254<br/>onecli-app-1 + postgres</sub>"]
            agents["Agent containers<br/><sub>spawned per request/task</sub>"]
        end

        subgraph fs["Filesystem"]
            db[("SQLite<br/>store/messages.db")]
            vault[("vault/<br/><sub>concepts · sources ·<br/>drafts · profile</sub>")]
            upload[("upload/")]
            ipc[("data/ipc/")]
        end
    end

    simon -->|":3100"| dash
    simon -->|drop files| upload
    tg <--> core

    core --> db
    core -->|watches| upload
    core <-->|watches & writes| vault
    core -->|polls| ipc
    core -->|index / query| rag
    core -->|spawns| agents

    agents -->|"r/w group folder,<br/>read vault"| fs
    agents -->|writes output JSON| ipc
    agents -->|tool calls + LLM| onecli
    onecli -->|proxies| claudeapi

    dash --> db
    dash --> vault
    dash -->|"/api/…"| core
    dash -->|"retrieval"| rag
```

**Lifecycle at a glance**

| Service | How it's started | Port |
|---|---|---|
| OneCLI | `docker restart onecli-app-1 onecli-postgres-1` | 10254 |
| LightRAG | `.venv/bin/python3 -m lightrag.api.lightrag_server …` | 9621 |
| Dashboard | `cd dashboard && npm run dev` | 3100 |
| NanoClaw | `npm run dev` | — |
| Agent containers | spawned by NanoClaw on demand | — (IPC via files) |

See [CLAUDE.md](../CLAUDE.md#start-everything) for the copy-pasteable startup sequence.

---

## 3. NanoClaw internals

Components inside the NanoClaw Node process — what `src/index.ts` boots and how they wire up.

```mermaid
flowchart TB
    subgraph ch["Channels · src/channels/"]
        reg["registry.ts<br/><sub>registerChannel /<br/>findChannel</sub>"]
        tg["telegram.ts"]
        web["web.ts"]
    end

    subgraph inbound["Inbound path"]
        ml["message loop<br/><sub>polls DB ~1s</sub>"]
        gq["GroupQueue<br/><sub>serialize per group</sub>"]
    end

    subgraph run["Agent execution"]
        cr["container-runner.ts<br/><sub>runContainerAgent()</sub>"]
        crt["container-runtime.ts<br/><sub>docker / apple-container<br/>abstraction</sub>"]
    end

    subgraph outbound["Outbound path"]
        ipcw["ipc.ts<br/><sub>watches data/ipc/</sub>"]
        router["router.ts<br/><sub>formatOutbound /<br/>routeOutbound</sub>"]
    end

    subgraph bg["Background loops"]
        ts["task-scheduler.ts<br/><sub>cron / interval</sub>"]
        ing["ingestion/pipeline.ts<br/><sub>upload → vault</sub>"]
        idx["rag/indexer.ts<br/><sub>vault → LightRAG</sub>"]
        rc["remote-control.ts"]
    end

    db[("SQLite<br/>(Drizzle schemas)")]
    main(["index.ts · main()"])

    main --> ch
    main --> inbound
    main --> run
    main --> outbound
    main --> bg

    tg -.onMessage.-> db
    web -.onMessage.-> db

    ml --> db
    ml --> gq
    gq --> cr
    cr --> crt

    cr -. spawns agent .-> ipcw
    ipcw --> db

    gq --> router
    router --> tg
    router --> web

    ts --> cr
    ing --> cr
    idx --> db
```

**Key design points**

- **Channel self-registration.** Each channel calls `registerChannel()` at import time; `src/channels/index.ts` is a barrel that triggers those imports.
- **DB is the message bus.** Channels `storeMessage()` on receipt; the message loop polls `getNewMessages()` since `lastTimestamp`. This makes crash recovery trivial — no in-memory queue to lose.
- **GroupQueue serializes per chat.** Two messages in the same group can never run concurrently, so there's no interleaving of responses.
- **IPC is filesystem-based.** Agents write JSON into `data/ipc/{group}/output/`; the host watches the directory, applies each file to the DB, and deletes it. No shared memory, no sockets.

---

## 4. End-to-end flows

### 4a. Chat message → response

```mermaid
sequenceDiagram
    autonumber
    actor U as Simon
    participant T as Telegram
    participant C as telegram.ts
    participant D as SQLite
    participant ML as messageLoop
    participant Q as GroupQueue
    participant CR as container-runner
    participant A as Agent container
    participant I as IPC watcher
    participant R as router

    U->>T: "Mr. Rogers, what's my next concept?"
    T->>C: update event (gramjs)
    C->>D: storeMessage(jid, sender, text, ts)

    loop every ~1s
        ML->>D: getNewMessages(since)
    end
    ML->>Q: enqueue(jid, prompt)
    Q->>CR: runContainerAgent(group, prompt)
    CR->>A: docker run (mounts: vault, group, ipc, .claude)

    par Agent work
        A->>A: read vault, call tools via OneCLI
        A-->>I: write data/ipc/{group}/output/*.json
        I->>D: persist concepts, activities, tasks
    and Response stream
        A-->>CR: stdout markers
    end

    CR-->>Q: {status, result}
    Q->>R: routeOutbound(jid, text)
    R->>C: channel.sendMessage(jid, text)
    C->>T: send
    T->>U: reply
```

### 4b. Document ingestion (`upload/` → vault → RAG)

```mermaid
sequenceDiagram
    autonumber
    actor U as Simon
    participant UP as upload/
    participant FW as file-watcher
    participant P as pipeline<br/>(drainer)
    participant D as SQLite<br/>(ingestion_jobs)
    participant EX as extractor
    participant DL as docling-extract.py
    participant AP as agent-processor
    participant A as Review agent<br/>(container)
    participant V as vault/drafts
    participant PR as promoter
    participant VS as vault/sources<br/>+ concepts
    participant IDX as rag-indexer
    participant LR as LightRAG :9621

    U->>UP: drop paper.pdf
    FW->>P: new file event
    P->>D: createIngestionJob (status=pending)

    P->>EX: extract(jobId)
    EX->>DL: spawn python3 docling-extract.py
    DL-->>EX: content.md + figures + metadata
    P->>D: status=extracted

    P->>AP: process(jobId)
    AP->>A: runContainerAgent(review_agent, prompt)
    A->>V: write draft .md files
    A-->>AP: sentinel file signals done
    P->>D: status=generated

    P->>PR: promote(jobId)
    PR->>VS: move drafts → sources/ + concepts/
    P->>D: status=completed

    VS-->>IDX: chokidar file change
    IDX->>LR: POST (index document)
    IDX->>D: update tracked_docs
```

---

## How to update this doc

- When you add a new **channel**, update §1 (if it's remote) and §3 (channels subgraph).
- When you add a new **long-running service**, update §2.
- When you change **message flow** or **ingestion stages**, update the matching sequence in §4.
- When a file in the "Quick map" table moves or splits, update the table.

Diagrams should match the code. If you find a drift, fix the diagram in the same PR as the code change.
