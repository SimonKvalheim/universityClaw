export interface OversizedStubInput {
  title: string;
  slug: string;
  sourceType: string;
  ingestedFrom: string;
  createdDate: string;
}

export interface OversizedStub {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function buildOversizedStub(input: OversizedStubInput): OversizedStub {
  const frontmatter: Record<string, unknown> = {
    title: input.title,
    type: 'source',
    source_type: input.sourceType,
    source_file: input.ingestedFrom,
    library: `[[library/${input.slug}]]`,
    verification_status: 'unverified',
    auto_generated: true,
    concepts_generated: [],  // required by draft-validator; empty since no agent ran
    created: input.createdDate,
  };

  const body = `# ${input.title}

This document was ingested but exceeded the agent's token budget for full synthesis.
The complete extracted text is available at [[library/${input.slug}]].

**Full text:** [[library/${input.slug}]]
`;

  return { frontmatter, body };
}
