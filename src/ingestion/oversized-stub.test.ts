import { describe, expect, it } from 'vitest';
import { buildOversizedStub } from './oversized-stub.js';

describe('buildOversizedStub', () => {
  it('produces the spec-mandated frontmatter shape', () => {
    const stub = buildOversizedStub({
      title: 'Big Book',
      slug: 'big-book',
      sourceType: 'book',
      ingestedFrom: 'upload/processed/jx-big.pdf',
      createdDate: '2026-04-29',
    });
    expect(stub.frontmatter).toEqual({
      title: 'Big Book',
      type: 'source',
      source_type: 'book',
      source_file: 'upload/processed/jx-big.pdf',
      library: '[[library/big-book]]',
      verification_status: 'unverified',
      auto_generated: true,
      concepts_generated: [],
      created: '2026-04-29',
    });
  });

  it('produces a body with the canned explanation and full-text link', () => {
    const stub = buildOversizedStub({
      title: 'Big Book',
      slug: 'big-book',
      sourceType: 'book',
      ingestedFrom: 'upload/processed/jx-big.pdf',
      createdDate: '2026-04-29',
    });
    expect(stub.body).toContain('# Big Book');
    expect(stub.body).toContain("exceeded the agent's token budget");
    expect(stub.body).toContain('[[library/big-book]]');
    expect(stub.body).toContain('**Full text:** [[library/big-book]]');
  });
});
