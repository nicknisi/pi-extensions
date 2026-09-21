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
  /** Captured RPC UI output (widget line, notifications) when `captureUI` is set. */
  ui: CapturedUI;
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
  /** Raw self-compact flag values. Defaults to window-independent percentages. */
  flags?: Record<string, string>;
  /** Bind a capturing RPC UI so widget/notify output is observable. */
  captureUI?: boolean;
}

const DEFAULT_TOOLS = ['read', 'bash', 'edit', 'write', 'self_compact'];

// Window-independent thresholds so the phase-1 lifecycle scenarios never trip the
// fail-closed gate regardless of the (often tiny) fixture context window.
const DEFAULT_FLAGS: Record<string, string> = {
  'compact-soft-at': '50%',
  'compact-at': '70%',
  'compact-buffer': '10%',
};

export interface CapturedUI {
  widget(): string[] | undefined;
  notifications(): Array<{ message: string; type: string }>;
}

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
      {
        name: 'self-compact',
        factory: (pi) => selfCompactExtension(pi, () => settingsManager.getCompactionKeepRecentTokens(faux.getModel())),
      },
    ],
  });
  await loader.reload();

  // Seed flag values before session_start resolves the threshold configuration.
  const flagValues = { ...DEFAULT_FLAGS, ...options.flags };
  const runtimeFlags = loader.getExtensions().runtime.flagValues;
  for (const [name, value] of Object.entries(flagValues)) runtimeFlags.set(name, value);

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

  let capturedWidget: string[] | undefined;
  const notifications: Array<{ message: string; type: string }> = [];
  if (options.captureUI) {
    const capturingUi = {
      notify: (message: string, type = 'info') => notifications.push({ message, type }),
      setWidget: (_key: string, content: string[] | undefined) => {
        capturedWidget = content;
      },
      setStatus: () => {},
      setFooter: () => {},
      setHeader: () => {},
      setTitle: () => {},
      onTerminalInput: () => () => {},
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
      editor: async () => undefined,
      custom: async () => undefined as never,
      pasteToEditor: () => {},
      setEditorText: () => {},
      getEditorText: () => '',
      addAutocompleteProvider: () => {},
      setEditor: () => {},
    };
    // Rebind with a capturing UI (mode 'rpc' makes ctx.hasUI true) so the widget
    // and command notifications become observable, as they are under real RPC.
    await session.bindExtensions({ uiContext: capturingUi as never, mode: 'rpc' });
  } else {
    // Match CLI startup/resume, including session_start recovery hooks.
    await session.bindExtensions({ mode: 'print' });
  }

  const ui: CapturedUI = {
    widget: () => capturedWidget,
    notifications: () => notifications,
  };

  return {
    session,
    faux,
    dir,
    sessionFile,
    sessionManager,
    ui,
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
