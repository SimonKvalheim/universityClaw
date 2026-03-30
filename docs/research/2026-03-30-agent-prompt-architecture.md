# Agent Prompt Architecture for Document Ingestion

**Date:** 2026-03-30
**Context:** Restructuring how the ingestion pipeline delivers prompts to container agents

## Problem

The ingestion pipeline was sending ~80K char prompts to container agents — the full extracted document (up to 67K chars) inlined alongside ~12K chars of workflow instructions. This caused:
- High token cost per job
- Rate limit hits during processing
- Wasted context on instructions that are identical across every job

## Research Findings

### 1. Inline Document Content (Don't Use File References)

**Consensus from Anthropic, LangChain, LlamaIndex:** For documents under ~150K tokens, inline the content in the prompt. Giving the agent a file path to read adds an agentic loop (extra latency, tool call overhead, risk of partial reads).

> "If your knowledge base is smaller than 200,000 tokens, you can just include the entire knowledge base in the prompt."
> — [Anthropic: Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval)

Our extractions range from 4K-67K chars — well within the inline threshold.

### 2. Document First, Instructions Last

Anthropic's testing shows up to 30% quality improvement when long-form data is placed at the top of the prompt, with instructions at the end.

> "Queries at the end can improve response quality by up to 30% in tests, especially with complex, multi-document inputs."
> — [Anthropic: Prompting Best Practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)

The "Lost in the Middle" research (Liu et al., TACL 2024) confirms: performance is highest when relevant information occurs at the beginning or end of the input context.

**Sources:**
- [Liu et al. - Lost in the Middle (arXiv:2307.03172)](https://arxiv.org/abs/2307.03172)
- [Anthropic: Long Context Tips](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/long-context-tips)

### 3. Stable Workflow in System Prompt, Dynamic Content in Task Prompt

The Agent SDK's intended architecture separates:
- **System prompt (CLAUDE.md):** Stable workflow definition — note schemas, cite-then-generate rules, manifest format, self-review checklist
- **Task prompt:** Dynamic per-job content — the document text + job metadata

> "Subagents receive only this system prompt (plus basic environment details), not the full Claude Code system prompt."
> — [Anthropic: Custom Subagents](https://code.claude.com/docs/en/sub-agents)

This matches the recommended pattern: move the ~12K of repeated instructions into the review agent's CLAUDE.md, and send only the document content + job parameters in the prompt.

### 4. Let the Agent Handle Multi-Step Reasoning Internally

> "Prefer general instructions over prescriptive steps. A prompt like 'think thoroughly' often produces better reasoning than a hand-written step-by-step plan."
> — [Anthropic: Prompting Best Practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)

The read → decompose → write manifest → self-review workflow is best handled as a single prompt with structured instructions in the system prompt, not four separate API calls.

### 5. Use XML Tags for Document Wrapping

Anthropic recommends wrapping documents in XML tags with metadata subtags for structured retrieval:

```xml
<document>
  <source>filename.pdf</source>
  <document_content>...</document_content>
</document>
```

### 6. Quote Before Synthesizing

> "For long document tasks, ask Claude to quote relevant parts of the documents first before carrying out its task. This helps Claude cut through the noise."
> — [Anthropic: Long Context Tips](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/long-context-tips)

This aligns with our cite-then-generate approach — the agent quotes source passages in `<internal>` tags before writing claims.

## Decision

| Component | Contains | Rationale |
|-----------|----------|-----------|
| `groups/review_agent/CLAUDE.md` | Agent identity, note schemas, cite-then-generate rules, manifest format, self-review checklist | Stable across all jobs; loaded once into agent context |
| Task prompt (from `agent-processor.ts`) | XML-wrapped document content + job ID + filename + figures | Dynamic per job; document placed first for attention quality |

This reduces per-job prompt overhead from ~12K to ~200 chars of job metadata, while keeping the full document inline for deterministic access.
