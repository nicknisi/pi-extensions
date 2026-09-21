/**
 * Deterministic real-Pi test fixture. Test-only; never a production runtime.
 *
 * Wires a scripted `fauxProvider` (from pi-ai) into a real `AgentSession` with
 * the self-compact extension loaded, using a persistent session file in a
 * disposable directory. Tests script the model's turns and the compaction
 * summary response, then drive the actual Pi lifecycle — the extension's
 * compaction events are never faked, only the provider's responses are.
 */
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type AssistantMessage,
  type FauxProviderHandle,
  type FauxResponseStep,
} from '@earendil-works/pi-ai';
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent';

export type { SessionManager, SessionEntry };
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import selfCompactExtension from '../extensions/self-compact/self-compact.js';

export { fauxAssistantMessage, fauxToolCall };
export type { AssistantMessage, FauxResponseStep };

export interface Fixture {
  session: AgentSession;
  faux: FauxProviderHandle;
  dir: string;
  sessionFile: string | undefined;
  /** Underlying session manager, exposed so recovery tests can seed durable state. */
  sessionManager: SessionManager;
  branch(): SessionEntry[];
  dispose(): void;
}

export interface FixtureOptions {
  contextWindow?: number;
  tools?: string[];
  responses?: FauxResponseStep[];
  sessionFile?: string | undefined;
  keepRecentTokens?: number;
  reserveTokens?: number;
  /** Throttle faux streaming so tests can observe/act during an in-flight turn. */
  tokensPerSecond?: number;
}

const DEFAULT_TOOLS = ['read', 'bash', 'edit', 'write', 'self_compact'];

export async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'self-compact-int-'));
  const agentDir = join(dir, 'agent');

  const faux = fauxProvider({
    provider: 'faux',
    models: [{ id: 'faux-1', contextWindow: options.contextWindow ?? 200000 }],
    ...(options.tokensPerSecond !== undefined ? { tokensPerSecond: options.tokensPerSecond } : {}),
  });
  if (options.responses) faux.setResponses(options.responses);

  // Low keep/reserve thresholds so a short scripted conversation has something
  // to summarize; the real compaction path still runs end to end.
  const settingsManager = SettingsManager.inMemory({
    compaction: {
      enabled: true,
      keepRecentTokens: options.keepRecentTokens ?? 1,
      reserveTokens: options.reserveTokens ?? 1,
    },
    retry: { enabled: false },
  });

  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir,
    settingsManager,
    extensionFactories: [
      { name: 'faux-provider', factory: (pi) => pi.registerProvider(faux.provider) },
      { name: 'self-compact', factory: selfCompactExtension },
    ],
  });
  await loader.reload();

  const sessionManager = options.sessionFile ? SessionManager.open(options.sessionFile) : SessionManager.create(dir);

  const { session } = await createAgentSession({
    cwd: dir,
    agentDir,
    model: faux.getModel(),
    thinkingLevel: 'off',
    tools: options.tools ?? DEFAULT_TOOLS,
    resourceLoader: loader,
    sessionManager,
    settingsManager,
  });

  const sessionFile = session.sessionFile;

  return {
    session,
    faux,
    dir,
    sessionFile,
    sessionManager,
    branch: () => sessionManager.getBranch(),
    dispose: () => {
      session.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Wait until `predicate` holds, polling the agent to idle, up to `timeoutMs`. */
export async function waitFor(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!predicate()) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
