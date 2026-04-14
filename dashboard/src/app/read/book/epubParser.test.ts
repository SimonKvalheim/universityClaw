// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { extractTextFromHtml, resolveHref } from './epubParser';

describe('extractTextFromHtml', () => {
  it('strips HTML tags and returns text content', () => {
    const html = '<html><body><p>Hello <b>world</b></p></body></html>';
    expect(extractTextFromHtml(html)).toBe('Hello world');
  });

  it('joins multiple paragraphs with newlines', () => {
    const html = '<html><body><p>First.</p><p>Second.</p></body></html>';
    const result = extractTextFromHtml(html);
    expect(result).toContain('First.');
    expect(result).toContain('Second.');
  });

  it('returns empty string for empty body', () => {
    const html = '<html><body></body></html>';
    expect(extractTextFromHtml(html)).toBe('');
  });

  it('handles self-closing tags', () => {
    const html = '<html><body><p>Line one<br/>Line two</p></body></html>';
    const result = extractTextFromHtml(html);
    expect(result).toContain('Line one');
    expect(result).toContain('Line two');
  });
});

describe('resolveHref', () => {
  it('prepends opfDir to relative href', () => {
    expect(resolveHref('chapter1.xhtml', 'OEBPS/')).toBe('OEBPS/chapter1.xhtml');
  });

  it('handles empty opfDir', () => {
    expect(resolveHref('chapter1.xhtml', '')).toBe('chapter1.xhtml');
  });

  it('handles nested paths', () => {
    expect(resolveHref('text/ch1.xhtml', 'OEBPS/')).toBe('OEBPS/text/ch1.xhtml');
  });

  it('resolves ../ segments', () => {
    expect(resolveHref('../Text/ch1.xhtml', 'OEBPS/nav/')).toBe('OEBPS/Text/ch1.xhtml');
  });

  it('decodes URL-encoded characters', () => {
    expect(resolveHref('chapter%201.xhtml', 'OEBPS/')).toBe('OEBPS/chapter 1.xhtml');
  });
});
