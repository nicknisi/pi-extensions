// Adapted from dot-pi extensions/lsp at 73fe0529c38f9a66fbf9a1b71c88d0d4980afceb.
// Owned read-only implementation. See THIRD_PARTY_NOTICES.md.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { basename } from 'node:path';
import {
  CancellationTokenSource,
  createMessageConnection,
  ErrorCodes,
  ResponseError,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node.js';
import type { Config } from './project.js';

export const capabilities = {
  workspace: { applyEdit: false, configuration: false, workspaceFolders: true },
  textDocument: {
    synchronization: { dynamicRegistration: false, willSave: false, willSaveWaitUntil: false, didSave: false },
    hover: { contentFormat: ['plaintext', 'markdown'] },
    definition: { linkSupport: true },
    references: {},
    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
    publishDiagnostics: { versionSupport: true },
  },
};
export function serverRequest(method: string): unknown {
  if (method === 'workspace/applyEdit')
    return { applied: false, failureReason: 'Read-only lsp tool never applies workspace edits.' };
  throw new ResponseError(ErrorCodes.MethodNotFound, `Read-only client does not support ${method}`);
}
export class Client {
  readonly process: ChildProcessWithoutNullStreams;
  readonly connection: MessageConnection;
  readonly documents = new Map<string, { text: string; version: number }>();
  readonly diagnostics = new Map<string, { version?: number; diagnostics: unknown[]; sequence: number }>();
  private sequence = 0;
  private failure: Error | undefined;
  private failures = new Set<(error: Error) => void>();
  private diagnosticListeners = new Set<() => void>();
  private stderr = '';
  private closed = false;

  constructor(
    readonly root: string,
    command: string,
    readonly config: Config,
    path = process.env.PATH,
  ) {
    this.process = spawn(command, config.args, {
      cwd: root,
      stdio: 'pipe',
      shell: false,
      windowsHide: true,
      env: { ...process.env, PATH: path },
    });
    this.connection = createMessageConnection(
      new StreamMessageReader(this.process.stdout),
      new StreamMessageWriter(this.process.stdin),
    );
    this.connection.onRequest((method: string) => serverRequest(method));
    this.connection.onNotification(
      'textDocument/publishDiagnostics',
      (params: { uri: string; version?: number; diagnostics: unknown[] }) => {
        if (!params || !this.documents.has(params.uri) || !Array.isArray(params.diagnostics)) return;
        this.diagnostics.set(params.uri, { ...params, sequence: ++this.sequence });
        for (const listener of this.diagnosticListeners) listener();
      },
    );
    this.process.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + String(chunk)).slice(-2000);
    });
    this.process.on('error', (error) => this.fail(new Error(`LSP_PROCESS: ${error.message}`)));
    this.process.on('exit', (code, signal) =>
      this.fail(new Error(`LSP_PROCESS: Server exited (${code ?? signal}). ${this.stderr}`)),
    );
    this.connection.onClose(() => this.fail(new Error('LSP_PROCESS: Server connection closed.')));
    this.connection.onError(([error]) => this.fail(new Error(`LSP_PROTOCOL: ${error.message}`)));
    this.connection.listen();
  }
  get alive(): boolean {
    return !this.failure && !this.closed;
  }
  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const reject of this.failures) reject(error);
  }
  async initialize(signal?: AbortSignal): Promise<void> {
    if (!this.process.pid) {
      await new Promise<void>((resolve, reject) => {
        this.process.once('spawn', resolve);
        this.process.once('error', (error) => reject(new Error(`LSP_PROCESS: ${error.message}`)));
      });
    }
    await this.request(
      'initialize',
      {
        processId: process.pid,
        rootUri: pathToFileURL(this.root).href,
        capabilities,
        initializationOptions: this.config.initializationOptions,
        workspaceFolders: [{ uri: pathToFileURL(this.root).href, name: basename(this.root) }],
      },
      signal,
    );
    await this.connection.sendNotification('initialized', {});
  }
  async request(
    method: string,
    params: unknown,
    signal?: AbortSignal,
    timeoutMs = this.config.timeoutMs,
  ): Promise<unknown> {
    if (this.failure) throw this.failure;
    if (signal?.aborted) throw new Error('LSP_CANCELLED: Request aborted.');
    const token = new CancellationTokenSource();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectWait: (error: Error) => void = () => {};
    const interrupted = new Promise<never>((_resolve, reject) => {
      rejectWait = reject;
    });
    const cancel = () => {
      token.cancel();
      rejectWait(new Error('LSP_CANCELLED: Request aborted.'));
    };
    this.failures.add(rejectWait);
    signal?.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => {
      token.cancel();
      rejectWait(new Error(`LSP_TIMEOUT: ${method} exceeded ${timeoutMs}ms.`));
    }, timeoutMs);
    try {
      return await Promise.race([this.connection.sendRequest(method, params, token.token), interrupted]);
    } catch (error) {
      if (this.failure) throw this.failure;
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      this.failures.delete(rejectWait);
      token.dispose();
    }
  }
  async sync(file: string, text: string, force = false): Promise<void> {
    if (this.failure) throw this.failure;
    const uri = pathToFileURL(file).href;
    const old = this.documents.get(uri);
    const version = (old?.version ?? 0) + 1;
    if (old && old.text === text && !force) return;
    this.diagnostics.delete(uri);
    this.documents.set(uri, { text, version });
    if (!old) {
      const languageId = /\.tsx$/i.test(file)
        ? 'typescriptreact'
        : /\.jsx$/i.test(file)
          ? 'javascriptreact'
          : /\.[cm]?ts$/i.test(file)
            ? 'typescript'
            : 'javascript';
      await this.connection.sendNotification('textDocument/didOpen', {
        textDocument: { uri, languageId, version, text },
      });
    } else {
      await this.connection.sendNotification('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
    }
  }
  // TS language server publishes diagnostics rather than implementing LSP pull diagnostics.
  // Wait for a fresh publication and a short quiet period, never treat a timeout as clean.
  async collectDiagnostics(uri: string, signal?: AbortSignal): Promise<unknown[]> {
    if (this.failure) throw this.failure;
    if (signal?.aborted) throw new Error('LSP_CANCELLED: Diagnostics aborted.');
    return new Promise((resolve, reject) => {
      let quiet: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        clearTimeout(deadline);
        clearTimeout(quiet);
        this.failures.delete(failed);
        this.diagnosticListeners.delete(changed);
        signal?.removeEventListener('abort', aborted);
      };
      const failed = (error: Error) => {
        cleanup();
        reject(error);
      };
      const aborted = () => failed(new Error('LSP_CANCELLED: Diagnostics aborted.'));
      const changed = () => {
        const result = this.diagnostics.get(uri);
        if (!result || (result.version !== undefined && result.version !== this.documents.get(uri)?.version)) return;
        clearTimeout(quiet);
        quiet = setTimeout(() => {
          cleanup();
          resolve(result.diagnostics);
        }, 1500);
      };
      const deadline = setTimeout(
        () => failed(new Error('LSP_TIMEOUT: No fresh diagnostic snapshot received.')),
        this.config.timeoutMs,
      );
      this.failures.add(failed);
      this.diagnosticListeners.add(changed);
      signal?.addEventListener('abort', aborted, { once: true });
      changed();
    });
  }
  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.failure) {
      try {
        await this.request('shutdown', null, undefined, 500);
        await this.connection.sendNotification('exit');
      } catch {
        /* Force termination below. */
      }
    }
    this.fail(new Error('LSP_SHUTDOWN: Session ended.'));
    this.connection.dispose();
    this.process.kill('SIGTERM');
    if (this.process.exitCode === null && this.process.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.process.kill('SIGKILL');
          resolve();
        }, 500);
        this.process.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}
