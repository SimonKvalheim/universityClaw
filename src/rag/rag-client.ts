import { execFile } from 'node:child_process';

export interface RagConfig {
  workingDir: string;
  vaultDir: string;
  pythonBin?: string;
}

export interface RagResult {
  answer: string;
  sources: string[];
}

export class RagClient {
  private pythonBin: string;
  private workingDir: string;

  constructor(private config: RagConfig) {
    this.pythonBin = config.pythonBin || 'python3';
    this.workingDir = config.workingDir;
  }

  buildQuery(query: string, filters?: Record<string, string>): string {
    let enriched = query;
    if (filters) {
      const filterStr = Object.entries(filters)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      enriched = `[Context: ${filterStr}] ${query}`;
    }
    return enriched;
  }

  async query(
    question: string,
    mode: 'naive' | 'local' | 'global' | 'hybrid' = 'hybrid',
    filters?: Record<string, string>,
  ): Promise<RagResult> {
    const enriched = this.buildQuery(question, filters);
    const script = `
import sys, asyncio, os
from lightrag import LightRAG
rag = LightRAG(working_dir=os.environ["LIGHTRAG_WORKING_DIR"])
question = sys.stdin.read()
mode = os.environ["LIGHTRAG_QUERY_MODE"]
result = asyncio.run(rag.aquery(question, param={"mode": mode}))
print(result)
`;
    try {
      const result = await this.execPythonWithStdin(script, enriched, {
        LIGHTRAG_QUERY_MODE: mode,
      });
      return { answer: result.trim(), sources: [] };
    } catch {
      return { answer: '', sources: [] };
    }
  }

  async index(text: string): Promise<void> {
    const script = `
import sys, asyncio, os
from lightrag import LightRAG
rag = LightRAG(working_dir=os.environ["LIGHTRAG_WORKING_DIR"])
content = sys.stdin.read()
asyncio.run(rag.ainsert(content))
print("ok")
`;
    await this.execPythonWithStdin(script, text);
  }

  private execPythonWithStdin(
    script: string,
    input: string,
    extraEnv?: Record<string, string>,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.pythonBin,
        ['-c', script],
        {
          timeout: 120_000,
          maxBuffer: 10 * 1024 * 1024,
          env: {
            ...process.env,
            LIGHTRAG_WORKING_DIR: this.workingDir,
            ...extraEnv,
          },
        },
        (err, stdout, stderr) => {
          if (err) return reject(new Error(`Python error: ${stderr || err.message}`));
          resolve(stdout);
        },
      );
      child.stdin?.write(input);
      child.stdin?.end();
    });
  }
}
