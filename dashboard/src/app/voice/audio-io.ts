// Browser-only audio I/O for /voice. Tests don't cover this file (jsdom has
// no Web Audio); the Task 20 integration test exercises the session path.

export interface MicCapture {
  stream: MediaStream;
  onFrame: (cb: (pcm: Int16Array) => void) => void;
  stop: () => void;
}

export async function startMicCapture(): Promise<MicCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  // A dedicated context for capture isolates sample-rate assumptions.
  const AC =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext!;
  const ctx = new AC();
  await ctx.audioWorklet.addModule('/voice/pcm-capture.js');

  const src = ctx.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(ctx, 'pcm-capture');
  src.connect(worklet);

  let cb: ((pcm: Int16Array) => void) | null = null;
  worklet.port.onmessage = (e: MessageEvent<Int16Array>) => {
    if (cb) cb(e.data);
  };

  let stopped = false;
  function stop(): void {
    if (stopped) return;
    stopped = true;
    try {
      worklet.disconnect();
    } catch {
      /* ignore */
    }
    try {
      src.disconnect();
    } catch {
      /* ignore */
    }
    for (const t of stream.getTracks()) t.stop();
    ctx.close().catch(() => {
      /* ignore */
    });
  }

  return {
    stream,
    onFrame: (fn) => {
      cb = fn;
    },
    stop,
  };
}

export interface Playback {
  enqueue: (pcm24: Int16Array) => void;
  stop: () => void;
}

export function createPlayback(): Playback {
  const AC =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext!;
  const ctx = new AC({ sampleRate: 24000 });

  let cursor = 0;
  const sources = new Set<AudioBufferSourceNode>();

  function enqueue(pcm: Int16Array): void {
    if (pcm.length === 0) return;
    const buf = ctx.createBuffer(1, pcm.length, 24000);
    const data = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) {
      data[i] = pcm[i] / (pcm[i] < 0 ? 0x8000 : 0x7fff);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const now = ctx.currentTime;
    const start = Math.max(now, cursor);
    src.start(start);
    cursor = start + buf.duration;
    sources.add(src);
    src.onended = () => sources.delete(src);
  }

  function stop(): void {
    for (const s of sources) {
      try {
        s.stop();
      } catch {
        /* ignore */
      }
    }
    sources.clear();
    ctx.close().catch(() => {
      /* ignore */
    });
  }

  return { enqueue, stop };
}
