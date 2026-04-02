# Telegram Attachment Passthrough

**Date:** 2026-04-02
**Status:** Draft

## Problem

When a user sends a file (PDF, image, etc.) as a Telegram attachment, the agent in its container only sees a text placeholder like `[Document: filename.pdf]`. The file is never downloaded or made accessible to the agent. The agent cannot read or process the attached file.

## Solution

Download Telegram file attachments on the host, encode a machine-readable marker in the message content, and stage files into the container's mounted group folder before the agent prompt is built. Files persist for the duration of the container session and are cleaned up at teardown.

## Design

### Marker Format

When a Telegram message has a file attachment, the handler downloads it and appends an `(__attachment__:...)` marker to the message content:

- Document: `[Document: report.pdf](__attachment__:/abs/path/data/attachments/main/456-report.pdf)`
- Photo: `[Photo](__attachment__:/abs/path/data/attachments/main/456-photo.jpg)`
- Photo with caption: `[Photo] Check this out(__attachment__:/abs/path/data/attachments/main/456-photo.jpg)`

The marker uses absolute host paths keyed by group folder (not raw JID). The `(__attachment__:...)` prefix is deliberately unlikely to collide with user message text. It is stripped and rewritten before reaching the agent prompt.

### Attachment Storage

Downloaded files are stored at `data/attachments/{groupFolder}/{msgId}-{filename}`. Using group folder (alphanumeric, validated by `GROUP_FOLDER_PATTERN`) instead of raw chatJid avoids colons and special characters in paths, consistent with how other `data/` subdirectories (sessions, IPC) are organized.

This location survives between message receipt and agent invocation. Telegram's Bot API enforces a 20MB file limit, so no additional size cap is needed.

Supported types: PDF, images (jpg, png, heic, webp), plain text.

### Attachment Utility Module (`src/attachments.ts`)

Channel-agnostic module with three functions:

**`prepareAttachments(messages, groupFolder)`** — Called before building the agent prompt. Scans all message contents for `(__attachment__:...)` markers. For each match:

1. Copies the file from `data/attachments/...` to `groups/{folder}/inputs/{filename}` (deduplicating filenames with numeric suffix if needed)
2. Rewrites message content: `[Document: report.pdf](__attachment__:...)` becomes `[Document: report.pdf — available at /workspace/group/inputs/report.pdf (1.4 MB)]`
3. Returns the list of consumed source paths for cleanup later

File size is included in the rewritten marker to help the agent make better tool-use decisions (e.g., paging large PDFs rather than reading 20MB at once).

**`cleanupAttachments(groupFolder, sourcePaths)`** — Called at container teardown (not after each agent turn). Removes `groups/{folder}/inputs/` directory and deletes consumed source files from `data/attachments/`.

**`ATTACHMENT_MARKER_RE`** — Exported regex: `\(__attachment__:([^)]+)\)` for testing.

The `inputs/` directory lives inside the group folder, which is already mounted at `/workspace/group` (writable). No new mounts or security changes needed. The agent uses the standard Read tool to access files at `/workspace/group/inputs/`.

### Telegram Handler Changes (`src/channels/telegram.ts`)

The `message:document` and `message:photo` handlers get dedicated async implementations that download the file before storing the message. They do **not** use the shared `storeNonText` helper, which is synchronous and not suitable for async downloads. This matches the pattern already used by the `message:voice` handler.

**Documents:**
1. Check if group is registered (early return if not)
2. Download via `ctx.getFile()` (grammyjs/files already configured)
3. Save to `data/attachments/{groupFolder}/{msgId}-{filename}`
4. Call `onMessage` with content `[Document: {filename}](__attachment__:{path})`
5. On download failure: fall back to `[Document: {filename}]` (no marker), same as today

**Photos:**
1. Pick the largest resolution (last element in `ctx.message.photo`)
2. Download and name as `{msgId}-photo.jpg`
3. Call `onMessage` with content `[Photo](__attachment__:{path})`

Both handlers also pass `thread_id` through to `onMessage`, fixing a pre-existing bug where non-text message handlers dropped the thread context.

The group folder for attachment storage is resolved by looking up the chatJid in `registeredGroups()`. No new dependencies — `hydrateFiles` and `DATA_DIR` are already available.

### Integration Points (`src/index.ts`)

Attachments must be prepared in **two** code paths:

**1. Initial turn (`processGroupMessages`):**

```
// Before building the prompt:
const attachmentPaths = prepareAttachments(missedMessages, group.folder);

// Build prompt as usual (messages now have rewritten content)
const prompt = reviewContext + formatMessages(missedMessages, TIMEZONE);
```

**2. Piped follow-up messages (`startMessageLoop`):**

When messages are piped to an already-running container via `queue.sendMessage()`, `prepareAttachments` must also be called before `formatMessages`:

```
// Before formatting for piping:
const pipedPaths = prepareAttachments(messagesToSend, group.folder);
attachmentPaths.push(...pipedPaths);

const formatted = formatMessages(messagesToSend, TIMEZONE);
queue.sendMessage(chatJid, formatted);
```

**Cleanup:** Runs at container teardown, not after each turn. When the container process exits (the `close` handler in `runContainerAgent`), cleanup removes `groups/{folder}/inputs/` and deletes consumed source files. This ensures files remain accessible across piped follow-up messages within the same container session.

`prepareAttachments` mutates the `content` field of in-memory message objects. DB records are untouched — they keep original markers.

### Edge Cases

- **Duplicate filenames:** Second file gets `report-2.pdf` suffix in inputs dir
- **Download failure:** Falls back to placeholder-only (no marker), same as today
- **Missing source at prep time:** Log warning, strip marker, continue without that file
- **HEIC images:** No conversion. Stored as-is. Must verify during implementation that Claude's Read tool supports HEIC inside Docker containers (host support is confirmed, container support may depend on image libraries).
- **Stale attachments:** On NanoClaw startup, delete files in `data/attachments/` older than 24 hours. This avoids purging attachments from messages that arrived just before a crash but haven't been processed yet. Age-based cleanup handles the common case (orphans from crashes days ago) without the race condition of a blanket purge.

### Testing

- **Unit tests for `src/attachments.ts`:** Marker parsing, file copying, content rewriting, dedup logic, cleanup, missing-file handling, file size formatting
- **Telegram handler tests:** Update existing tests for download + marker behavior in document and photo handlers; verify thread_id passthrough
- **Integration:** Marker in content → file in inputs dir → rewritten prompt → cleanup at container teardown
- **Piping path:** Verify attachments in follow-up messages (piped to running container) are also staged and rewritten correctly

## Non-Goals

- Image conversion (HEIC→JPG etc.) — not needed if container supports HEIC
- Support for video or audio attachments — out of scope
- Multi-channel support in this iteration — Telegram only, but the utility module is channel-agnostic by design
- DB schema changes — markers live in the content string
