import { describe, it, expect } from 'vitest';
import { DoclingClient } from './docling-client.js';

describe('DoclingClient', () => {
  describe('constructor', () => {
    it('constructs with default python3 binary', () => {
      const client = new DoclingClient();
      expect(client).toBeInstanceOf(DoclingClient);
    });

    it('constructs with a custom python binary', () => {
      const client = new DoclingClient('/usr/bin/python3');
      expect(client).toBeInstanceOf(DoclingClient);
    });
  });

  describe('isSupported()', () => {
    const client = new DoclingClient();

    it.each([
      'document.pdf',
      'slides.pptx',
      'slides.ppt',
      'report.docx',
      'report.doc',
      'photo.png',
      'photo.jpg',
      'photo.jpeg',
      'scan.tiff',
      'scan.bmp',
      'notes.md',
      'notes.txt',
      'page.html',
      'page.htm',
    ])('recognizes supported extension: %s', (fileName) => {
      expect(client.isSupported(fileName)).toBe(true);
    });

    it.each([
      'archive.zip',
      'data.csv',
      'spreadsheet.xlsx',
      'video.mp4',
      'audio.mp3',
      'code.ts',
      'noextension',
      '',
    ])('rejects unsupported extension: %s', (fileName) => {
      expect(client.isSupported(fileName)).toBe(false);
    });

    it('is case-insensitive for extensions', () => {
      expect(client.isSupported('document.PDF')).toBe(true);
      expect(client.isSupported('photo.JPG')).toBe(true);
      expect(client.isSupported('slides.PPTX')).toBe(true);
    });
  });
});
