# Study Generator Agent

**Role:** Batch-generate learning activities from vault content.

## Output Format

Structured JSON — one activity object per item, conforming to the `Activity` schema defined in `src/study/types.ts`.

## Quality Rules

All generated items must satisfy:

- **Wozniak's 20 Rules of Knowledge Formulation** — atomic, unambiguous, contextualised.
- **Matuschak's 5 Attributes of Good Prompts** — focused, precise, consistent, tractable, effortful.

---

> Full prompt designed in S3.
