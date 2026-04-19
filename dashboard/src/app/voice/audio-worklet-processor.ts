/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
// Reference-only source; runtime is dashboard/public/voice/pcm-capture.js.
// Excluded from tsconfig because it declares worklet-scope globals
// (sampleRate, registerProcessor, AudioWorkletProcessor) that don't exist in
// the main-thread lib types. @ts-nocheck is belt-and-suspenders. Keep in
// sync with the plain-JS copy in public/voice/pcm-capture.js by hand.
//
// Downsamples the native AudioContext sampleRate to 16 kHz mono, converts
// Float32 [-1,1] to Int16, and posts Int16Array buffers to the main thread.
// Target chunk = 320 samples (20 ms at 16 kHz).

declare const sampleRate: number;
declare function registerProcessor(name: string, cls: unknown): void;

declare class AudioWorkletProcessorBase {
  port: MessagePort;
  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>): boolean;
}

const TARGET_RATE = 16_000;
const TARGET_FRAMES = 320;

class PcmCaptureProcessor extends AudioWorkletProcessorBase {
  private buf: number[] = [];
  private ratio = sampleRate / TARGET_RATE;
  private phase = 0;

  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0];
    if (!ch) return true;

    for (let i = 0; i < ch.length; i++) {
      this.phase += 1;
      if (this.phase >= this.ratio) {
        // Simple decimation — not anti-aliased. Acceptable for speech.
        this.buf.push(ch[i]);
        this.phase -= this.ratio;
      }
    }

    while (this.buf.length >= TARGET_FRAMES) {
      const slice = this.buf.splice(0, TARGET_FRAMES);
      const out = new Int16Array(TARGET_FRAMES);
      for (let i = 0; i < TARGET_FRAMES; i++) {
        const s = Math.max(-1, Math.min(1, slice[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.port.postMessage(out, [out.buffer]);
    }

    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
