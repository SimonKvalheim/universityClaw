import { WebSocketServer, WebSocket } from 'ws';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

interface ToolResponseResolver {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export interface FakeGemini {
  url: string;
  close: () => Promise<void>;
  sendAssistantAudio: (base64Chunk: string) => void;
  sendInputTranscription: (text: string, partial?: boolean) => void;
  sendOutputTranscription: (text: string, partial?: boolean) => void;
  sendToolCall: (call: { id: string; name: string; args: unknown }) => void;
  sendUsage: (usage: {
    textIn: number;
    textOut: number;
    audioIn: number;
    audioOut: number;
  }) => void;
  terminate: () => void;
  waitForClientAudio: () => Promise<Buffer>;
  waitForToolResponse: (toolCallId: string) => Promise<unknown>;
}

export async function startFakeGemini(
  opts: { port?: number } = {},
): Promise<FakeGemini> {
  const httpServer: Server = createServer();
  const wss = new WebSocketServer({ server: httpServer });

  const clients = new Set<WebSocket>();

  const audioResolvers: Array<(buf: Buffer) => void> = [];
  const pendingAudio: Buffer[] = [];

  const toolResolvers = new Map<string, ToolResponseResolver>();
  const bufferedToolResponses = new Map<string, unknown>();

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('message', (raw) => {
      let msg: {
        type?: string;
        data?: string;
        id?: string;
        response?: unknown;
      };
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      if (msg.type === 'client_audio' && typeof msg.data === 'string') {
        const buf = Buffer.from(msg.data, 'base64');
        if (audioResolvers.length > 0) {
          const r = audioResolvers.shift()!;
          r(buf);
        } else {
          pendingAudio.push(buf);
        }
      } else if (msg.type === 'tool_response' && typeof msg.id === 'string') {
        const r = toolResolvers.get(msg.id);
        if (r) {
          r.resolve(msg.response);
          toolResolvers.delete(msg.id);
        } else {
          bufferedToolResponses.set(msg.id, msg.response);
        }
      }
      // client_content / bye / unknown → ignore
    });
    ws.on('close', () => clients.delete(ws));
  });

  function broadcast(obj: unknown): void {
    const line = JSON.stringify(obj);
    for (const c of clients) {
      if (c.readyState === WebSocket.OPEN) c.send(line);
    }
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.port ?? 0, '127.0.0.1', () => resolve());
  });

  const addr = httpServer.address() as AddressInfo;
  const url = `ws://127.0.0.1:${addr.port}`;

  async function close(): Promise<void> {
    for (const r of toolResolvers.values()) {
      r.reject(new Error('fake gemini closed'));
    }
    toolResolvers.clear();
    for (const c of clients) {
      try {
        c.close();
      } catch {
        /* ignore */
      }
    }
    clients.clear();
    await new Promise<void>((r) => wss.close(() => r()));
    await new Promise<void>((r) => httpServer.close(() => r()));
  }

  return {
    url,
    close,

    sendAssistantAudio: (data) => broadcast({ type: 'audio', data }),

    sendInputTranscription: (text, partial = false) =>
      broadcast({ type: 'input_transcription', text, partial }),

    sendOutputTranscription: (text, partial = false) =>
      broadcast({ type: 'output_transcription', text, partial }),

    sendToolCall: (call) =>
      broadcast({
        type: 'tool_call',
        id: call.id,
        name: call.name,
        args: call.args,
      }),

    sendUsage: (usage) =>
      broadcast({
        type: 'usage',
        textIn: usage.textIn,
        textOut: usage.textOut,
        audioIn: usage.audioIn,
        audioOut: usage.audioOut,
      }),

    terminate: () => {
      broadcast({ type: 'server_end' });
      for (const c of clients) {
        try {
          c.close(1000, 'server_end');
        } catch {
          /* ignore */
        }
      }
    },

    waitForClientAudio: () => {
      if (pendingAudio.length > 0) {
        return Promise.resolve(pendingAudio.shift()!);
      }
      return new Promise<Buffer>((resolve) => {
        audioResolvers.push(resolve);
      });
    },

    waitForToolResponse: (toolCallId) => {
      if (bufferedToolResponses.has(toolCallId)) {
        const v = bufferedToolResponses.get(toolCallId);
        bufferedToolResponses.delete(toolCallId);
        return Promise.resolve(v);
      }
      return new Promise((resolve, reject) => {
        toolResolvers.set(toolCallId, { resolve, reject });
      });
    },
  };
}
