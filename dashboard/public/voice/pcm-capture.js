// Plain JS copy of audio-worklet-processor.ts. Kept in sync manually; this
// is what audioContext.audioWorklet.addModule('/voice/pcm-capture.js') loads.
// Modifications must be mirrored in the TS reference file.

const TARGET_RATE = 16000;
const TARGET_FRAMES = 320; // 20 ms at 16 kHz

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = [];
    this.ratio = sampleRate / TARGET_RATE;
    this.phase = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;

    for (let i = 0; i < ch.length; i++) {
      this.phase += 1;
      if (this.phase >= this.ratio) {
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
