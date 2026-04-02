# Telegram Attachment Passthrough

**Date:** 2026-04-02
**Status:** Draft

## Problem

When a user sends a file (PDF, image, etc.) as a Telegram attachment, the agent in its container only sees a text placeholder like `[Document: filename.pdf]`. The file is never downloaded or made accessible to the agent. The agent cannot read or process the attached file.

## Solution

Download Telegram file attachments on the host, encode a machine-readable marker in the message content, and copy files into the container's mounted group folder before the agent turn. Clean up after.

## Design

### Marker Format

When a Telegram message has a file attachment, the handler downloads it and appends an `(attachment:...)` marker to the message content:

- Document: `[Document: report.pdf](attachment:/abs/path/data/attachments/tg:-123/456-report.pdf)`
- Photo: `[Photo](attachment:/abs/path/data/attachments/tg:-123/456-photo.jpg)`
- Photo with caption: `[Photo] Check this out(attachment:/abs/path/data/attachments/tg:-123/456-photo.jpg)`

The marker uses absolute host paths. It is stripped and rewritten before reaching the agent prompt.

### Attachment Storage

Downloaded files are stored at `data/attachments/{chatJid}/{msgId}-{filename}`. This location survives between message receipt and agent invocation. Telegram's Bot API enforces a 20MB file limit, so no additional size cap is needed.

Supported types: PDF, images (jpg, png, heic, webp), plain text.

### Attachment Utility Module (`src/attachments.ts`)

Channel-agnostic module with three functions:

**`prepareAttachments(messages, groupFolder)`** — Called before building the agent prompt. Scans all message contents for `(attachment:...)` markers. For each match:

1. Copies the file from `data/attachments/...` to `groups/{folder}/inputs/{filename}` (deduplicating filenames with numeric suffix if needed)
2. Rewrites message content: `[Document: report.pdf](attachment:...)` becomes `[Document: report.pdf — available at /workspace/group/inputs/report.pdf]`
3. Returns the list of consumed source paths for cleanup

**`cleanupAttachments(groupFolder, sourcePaths)`** — Called after the agent turn completes. Removes `groups/{folder}/inputs/` directory and deletes consumed source files from `data/attachments/`.

**`ATTACHMENT_MARKER_RE`** — Exported regex: `\(attachment:([^)]+)\)` for testing.

The `inputs/` directory lives inside the group folder, which is already mounted at `/workspace/group` (writable). No new mounts or security changes needed. The agent uses the standard Read tool to access files at `/workspace/group/inputs/`.

### Telegram Handler Changes (`src/channels/telegram.ts`)

Two handlers change: `message:document` and `message:photo`.

**Documents:** Download via `ctx.getFile()` (grammyjs/files already configured), save to `data/attachments/{chatJid}/{msgId}-{filename}`, store message with `(attachment:...)` marker.

**Photos:** Pick the largest resolution (last element in `ctx.message.photo`), download, name as `{msgId}-photo.jpg`.

Both fall back to current placeholder-only behavior on download failure. No new dependencies — `hydrateFiles` and `DATA_DIR` are already available.

### Integration Point (`src/index.ts`)

The attachment lifecycle hooks into `processMessages()`:

```
// Before building the prompt:
const attachmentPaths = prepareAttachments(missedMessages, group.folder);

// Build prompt as usual (messages now have rewritten content)
const prompt = reviewContext + formatMessages(missedMessages, TIMEZONE);

// ... run agent ...

// After agent turn completes (finally block):
cleanupAttachments(group.folder, attachmentPaths);
```

`prepareAttachments` mutates the `content` field of in-memory message objects. DB records are untouched — they keep original markers, which is fine since messages are formatted into prompts once per turn.

### Edge Cases

- **Duplicate filenames:** Second file gets `report-2.pdf` suffix in inputs dir
- **Download failure:** Falls back to placeholder-only (no marker), same as today
- **Missing source at prep time:** Log warning, strip marker, continue without that file
- **HEIC images:** No conversion. Claude reads HEIC natively via Read tool. Stored as-is.
- **Stale attachments:** Purge `data/attachments/` on NanoClaw startup to clean orphans

### Testing

- **Unit tests for `src/attachments.ts`:** Marker parsing, file copying, content rewriting, dedup logic, cleanup, missing-file handling
- **Telegram handler tests:** Update existing tests for download + marker behavior in document and photo handlers
- **Integration:** Marker in content → file in inputs dir → rewritten prompt → cleanup after turn

## Non-Goals

- Image conversion (HEIC→JPG etc.) — not needed, Claude handles HEIC
- Support for video or audio attachments — out of scope
- Multi-channel support in this iteration — Telegram only, but the utility module is channel-agnostic by design
- DB schema changes — markers live in the content string
