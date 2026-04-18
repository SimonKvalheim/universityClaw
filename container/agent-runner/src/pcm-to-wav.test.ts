import { describe, it, expect } from 'vitest';
import { pcmToWav } from './pcm-to-wav.js';

describe('pcmToWav', () => {
  it('prepends a 44-byte RIFF/WAVE header to the PCM buffer', () => {
    const pcm = Buffer.alloc(100, 0xAB);
    const wav = pcmToWav(pcm);
    expect(wav.length).toBe(100 + 44);
    expect(wav.slice(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.slice(8, 12).toString('ascii')).toBe('WAVE');
    expect(wav.slice(12, 16).toString('ascii')).toBe('fmt ');
    expect(wav.slice(36, 40).toString('ascii')).toBe('data');
    expect(wav.slice(44).equals(pcm)).toBe(true);
  });

  it('encodes fmt chunk for 24kHz mono 16-bit little-endian PCM', () => {
    const pcm = Buffer.alloc(10);
    const wav = pcmToWav(pcm);
    expect(wav.readUInt32LE(16)).toBe(16);
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(24000);
    expect(wav.readUInt32LE(28)).toBe(48000);
    expect(wav.readUInt16LE(32)).toBe(2);
    expect(wav.readUInt16LE(34)).toBe(16);
  });

  it('writes the RIFF and data chunk sizes correctly', () => {
    const pcm = Buffer.alloc(1000);
    const wav = pcmToWav(pcm);
    expect(wav.readUInt32LE(4)).toBe(1000 + 36);
    expect(wav.readUInt32LE(40)).toBe(1000);
  });

  it('handles an empty PCM buffer', () => {
    const wav = pcmToWav(Buffer.alloc(0));
    expect(wav.length).toBe(44);
    expect(wav.readUInt32LE(4)).toBe(36);
    expect(wav.readUInt32LE(40)).toBe(0);
  });
});
