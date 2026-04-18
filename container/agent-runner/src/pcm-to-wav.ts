/**
 * Gemini TTS returns raw 24kHz mono 16-bit little-endian PCM, but the host
 * ffmpeg WAV→OGG pipeline expects a WAV file on disk. This helper prepends
 * the standard 44-byte RIFF/WAVE header so the downstream pipeline works
 * unchanged.
 */

export function pcmToWav(pcm: Buffer): Buffer {
  const SAMPLE_RATE = 24000;
  const CHANNELS = 1;
  const BITS_PER_SAMPLE = 16;
  const BYTE_RATE = SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8);
  const BLOCK_ALIGN = CHANNELS * (BITS_PER_SAMPLE / 8);

  const header = Buffer.alloc(44);

  // RIFF chunk descriptor
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(pcm.length + 36, 4);
  header.write('WAVE', 8, 'ascii');

  // fmt sub-chunk
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size (PCM)
  header.writeUInt16LE(1, 20); // audio format (PCM = 1)
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(BYTE_RATE, 28);
  header.writeUInt16LE(BLOCK_ALIGN, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);

  // data sub-chunk
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}
