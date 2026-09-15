import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { realpath } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from './client.js';
import {
  documentText,
  executable,
  loadConfig,
  projectFile,
  requireTrust,
  trustedPath,
  type TrustContext,
} from './project.js';

export interface LspInput {
  action: 'definition' | 'references' | 'hover' | 'symbols' | 'diagnostics';
  file: string;
  line?: number;
  column?: number;
}
const methods = {
  definition: 'textDocument/definition',
  references: 'textDocument/references',
  hover: 'textDocument/hover',
  symbols: 'textDocument/documentSymbol',
};
// Keep structured LSP fields, but convert every protocol position to 1-based coordinates.
export function readable(value: unknown, depth = 0): unknown {
  if (depth > 20) return '[depth limit]';
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => readable(item, depth + 1));
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.line === 'number' && typeof record.character === 'number')
      return { line: record.line + 1, column: record.character + 1 };
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, readable(item, depth + 1)]));
  }
  return value;
}
export function bounded(value: unknown): string {
  const json = JSON.stringify(readable(value), null, 2) ?? 'null';
  const lines = json.split('\n');
  const head = lines.slice(0, 800).join('\n');
  const bytes = Buffer.from(head);
  const text = bytes.subarray(0, 24000).toString('utf8');
  return `${text}${lines.length > 800 || bytes.length > 24000 ? '\n[Output truncated. Narrow the request.]' : ''}\n[Arrays limited to 100 entries. Positions are 1-based.]`;
}
export class Service {
  private clients = new Map<string, Client>();
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;
  async execute(input: LspInput, ctx: TrustContext, signal?: AbortSignal): Promise<string> {
    requireTrust(ctx); // Must precede all config/project IO and executable resolution.
    const work = this.queue.then(async () => {
      requireTrust(ctx);
      if (this.stopped) throw new Error('LSP_SHUTDOWN: Session ended.');
      if (signal?.aborted) throw new Error('LSP_CANCELLED: Request aborted.');
      if (!['definition', 'references', 'hover', 'symbols', 'diagnostics'].includes(input.action))
        throw new Error('LSP_ACTION: Unsupported read-only action.');
      const root = await realpath(ctx.cwd);
      const file = await projectFile(root, input.file);
      const text = await documentText(root, file);
      if (['definition', 'references', 'hover'].includes(input.action)) {
        const line = input.line;
        const column = input.column;
        const lines = text.split(/\r?\n/);
        if (
          !Number.isInteger(line) ||
          !Number.isInteger(column) ||
          !line ||
          !column ||
          line < 1 ||
          column < 1 ||
          line > lines.length ||
          column > (lines[line - 1]?.length ?? 0) + 1
        )
          throw new Error('LSP_POSITION: Provide valid 1-based line and UTF-16 column.');
      }
      let client = this.clients.get(root);
      if (!client?.alive) {
        if (client) await client.shutdown();
        const config = await loadConfig();
        const command = await executable(config, root);
        const path = await trustedPath(root);
        requireTrust(ctx);
        if (this.stopped) throw new Error('LSP_SHUTDOWN: Session ended.');
        if (signal?.aborted) throw new Error('LSP_CANCELLED: Request aborted.');
        client = new Client(root, command, config, path);
        this.clients.set(root, client);
        try {
          await client.initialize(signal);
        } catch (error) {
          await client.shutdown();
          this.clients.delete(root);
          throw error;
        }
      }
      // Refresh all previously opened documents so edits in another file are visible too.
      for (const uri of client.documents.keys()) {
        requireTrust(ctx);
        const opened = fileURLToPath(uri);
        if (opened !== file) await client.sync(opened, await documentText(root, opened));
      }
      requireTrust(ctx);
      if (signal?.aborted) throw new Error('LSP_CANCELLED: Request aborted.');
      await client.sync(file, await documentText(root, file), input.action === 'diagnostics');
      const uri = pathToFileURL(file).href;
      if (input.action === 'diagnostics') {
        const diagnostics = await client.collectDiagnostics(uri, signal);
        return bounded({
          file,
          snapshot: true,
          note: 'Fresh server publication, not a guarantee that project analysis is complete.',
          diagnostics,
        });
      }
      const params = {
        textDocument: { uri },
        ...(input.action === 'symbols' ? {} : { position: { line: input.line! - 1, character: input.column! - 1 } }),
        ...(input.action === 'references' ? { context: { includeDeclaration: true } } : {}),
      };
      return bounded(await client.request(methods[input.action], params, signal));
    });
    this.queue = work.catch(() => {});
    return work;
  }
  async shutdown(): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.clients.values()].map((client) => client.shutdown()));
    this.clients.clear();
  }
}
export default function lsp(pi: ExtensionAPI): void {
  const service = new Service();
  pi.registerTool({
    name: 'lsp',
    label: 'LSP',
    description:
      'Read-only TypeScript/JavaScript definition, references, hover, document symbols, or diagnostic snapshot. Requires a trusted project and externally installed typescript-language-server. file is inside cwd. Positional actions require 1-based line and UTF-16 column. Output bounded to 100 entries per array, 800 lines, 24KB. Does not write files.',
    parameters: Type.Object({
      action: StringEnum(['definition', 'references', 'hover', 'symbols', 'diagnostics'] as const),
      file: Type.String(),
      line: Type.Optional(Type.Integer({ minimum: 1 })),
      column: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    async execute(_id, input, signal, _update, ctx) {
      return { content: [{ type: 'text', text: await service.execute(input, ctx, signal) }], details: {} };
    },
  });
  pi.on('session_shutdown', async () => {
    await service.shutdown();
  });
}
