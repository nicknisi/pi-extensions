import type { Api, Model } from '@earendil-works/pi-ai';
import type {
  ExtensionAPI,
  ExtensionToolContext,
  ExtensionUIContext,
  RegisteredCommand,
  SessionEntry,
  Theme,
  ToolDefinition,
  ToolInfo,
} from '@earendil-works/pi-coding-agent';
import { vi } from 'vitest';
import type { MockTheme } from './theme.js';

/** A captured `registerShortcut` registration (KeyId → handler). */
export interface CapturedShortcut {
  description?: string;
  handler: (ctx: unknown) => Promise<void> | void;
}

export interface CapturedPi {
  tools: Map<string, ToolDefinition>;
  commands: Map<string, Omit<RegisteredCommand, 'name' | 'sourceInfo'>>;
  /** Keyboard shortcuts registered via `pi.registerShortcut(keyId, opts)`. */
  shortcuts: Map<string, CapturedShortcut>;
  flags: Map<string, unknown>;
  events: Map<string, Array<(...args: unknown[]) => unknown>>;
  eventsEmitted: Map<string, unknown[]>;
  activeTools: string[];
  allTools: ToolInfo[];
  /** Custom entries appended via `pi.appendEntry(customType, data)`, in call order. */
  entries: Array<{ customType: string; data: unknown }>;
}

export interface MockPi {
  pi: ExtensionAPI;
  captured: CapturedPi;
}

export interface CreateMockPiOptions extends Partial<ExtensionAPI> {
  /**
   * Skill names to surface from `getCommands()` as `RegisteredCommand`s with
   * `source: "skill"` (matching the shape Pi emits from
   * `agent-session.js:1699` — `name` prefixed with `"skill:"`, `source`
   * `"skill"`). Lets tests of programmatic `/skill:<name>` dispatch (the
   * `rpiv-workflow` runner gates dispatch on this registry to prevent
   * raw-text leakage to the LLM) register the skills their workflow uses
   * without hand-rolling RegisteredCommand objects.
   *
   * Overridden completely by a `getCommands` override in the same call —
   * `getCommands` takes precedence when both are present.
   */
  skills?: readonly string[];
}

export function createMockPi(options: CreateMockPiOptions = {}): MockPi {
  const captured: CapturedPi = {
    tools: new Map(),
    commands: new Map(),
    shortcuts: new Map(),
    flags: new Map(),
    events: new Map(),
    eventsEmitted: new Map(),
    activeTools: [],
    allTools: [],
    entries: [],
  };

  const { skills, ...overrides } = options;
  const skillCommands: RegisteredCommand[] = (skills ?? []).map(
    (name) =>
      ({
        name: `skill:${name}`,
        source: 'skill',
        sourceInfo: { path: `/mock/skills/${name}/SKILL.md`, baseDir: `/mock/skills/${name}` },
      }) as unknown as RegisteredCommand,
  );

  const pi = {
    registerTool: vi.fn((tool: ToolDefinition) => {
      captured.tools.set(tool.name, tool);
      if (!captured.activeTools.includes(tool.name)) captured.activeTools.push(tool.name);
    }),
    registerCommand: vi.fn((name: string, cmd: Omit<RegisteredCommand, 'name' | 'sourceInfo'>) => {
      captured.commands.set(name, cmd);
    }),
    registerShortcut: vi.fn((shortcut: string, opts: CapturedShortcut) => {
      captured.shortcuts.set(shortcut, opts);
    }),
    registerFlag: vi.fn((name: string, value: unknown) => {
      captured.flags.set(name, value);
    }),
    getFlag: vi.fn((name: string) => captured.flags.get(name)),
    on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
      const list = captured.events.get(event) ?? [];
      list.push(handler);
      captured.events.set(event, list);
    }),
    appendEntry: vi.fn((customType: string, data?: unknown) => {
      captured.entries.push({ customType, data });
    }),
    sendMessage: vi.fn(async () => {}),
    sendUserMessage: vi.fn((_content: unknown, _options?: unknown) => {
      // Sync fire-and-forget in production; mock captures nothing extra.
      // Tests assert on sentMessages via the chain or directly on this spy.
    }),
    exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false })),
    getActiveTools: vi.fn(() => [...captured.activeTools]),
    setActiveTools: vi.fn((names: string[]) => {
      captured.activeTools = [...names];
    }),
    getAllTools: vi.fn(() => [...captured.allTools]),
    getThinkingLevel: vi.fn(() => 'medium' as unknown as string),
    events: {
      emit: vi.fn((channel: string, data: unknown) => {
        const list = captured.eventsEmitted.get(channel) ?? [];
        list.push(data);
        captured.eventsEmitted.set(channel, list);
      }),
      on: vi.fn(() => () => {}),
    },
    // Default skill registry: just the user-passed `skills` list. Tests
    // that need a custom getCommands can still pass one via overrides
    // (it'll replace this default via the spread below).
    getCommands: vi.fn(() => skillCommands),
    ...overrides,
  } as unknown as ExtensionAPI;

  return { pi, captured };
}

export interface MockUI {
  notify: ReturnType<typeof vi.fn>;
  confirm: ReturnType<typeof vi.fn>;
  input: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  setWidget: ReturnType<typeof vi.fn>;
  setStatus: ReturnType<typeof vi.fn>;
  setWorkingMessage: ReturnType<typeof vi.fn>;
  setHiddenThinkingLabel: ReturnType<typeof vi.fn>;
  onTerminalInput: ReturnType<typeof vi.fn>;
  pasteToEditor: ReturnType<typeof vi.fn>;
  setEditorComponent: ReturnType<typeof vi.fn>;
  /** Only present when a test passes one in; overlay renders fall back to the factory theme otherwise. */
  theme?: Theme | MockTheme;
}

export function createMockUI(
  overrides: Partial<Omit<ExtensionUIContext, 'theme'>> & { theme?: Theme | MockTheme } = {},
): MockUI {
  return {
    notify: vi.fn(),
    confirm: vi.fn(async () => true),
    input: vi.fn(async () => ''),
    select: vi.fn(async () => undefined),
    setWidget: vi.fn(),
    setStatus: vi.fn(),
    setWorkingMessage: vi.fn(),
    setHiddenThinkingLabel: vi.fn(),
    onTerminalInput: vi.fn(() => () => {}),
    pasteToEditor: vi.fn(),
    setEditorComponent: vi.fn(),
    ...overrides,
  } as unknown as MockUI;
}

export function createMockSessionManager(
  branch: SessionEntry[] = [],
  sessionId = 'test-session',
  sessionName?: string,
) {
  return {
    getBranch: vi.fn(() => branch),
    getEntries: vi.fn(() => branch),
    getLeafId: vi.fn(() => (branch.length ? branch[branch.length - 1]!.id : null)),
    getSessionFile: vi.fn(() => '/tmp/test-session.jsonl'),
    getSessionId: vi.fn(() => sessionId),
    // Pi reports an UNNAMED session as `undefined`, so the default mirrors a
    // session the user never renamed.
    getSessionName: vi.fn(() => sessionName),
  };
}

export function createMockModelRegistry(models: Model<Api>[] = []) {
  return {
    find: vi.fn((provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id)),
    getAvailable: vi.fn(() => [...models]),
    getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: 'test-key', headers: {} })),
  };
}

export interface MockCtxOptions {
  hasUI?: boolean;
  /** Host mode the ctx advertises (`"rpc"` for ACP hosts). Pi ≥0.79 field — omitted by default, matching the pinned 0.74 peer types. */
  mode?: string;
  cwd?: string;
  model?: Model<Api>;
  branch?: SessionEntry[];
  models?: Model<Api>[];
  ui?: Partial<ExtensionUIContext>;
  /** Concurrency cap the ctx advertises. Defaults to 1 (sequential). */
  maxConcurrency?: number;
  /** Session id the ctx advertises via `sessionManager.getSessionId()`. Defaults to "test-session". */
  sessionId?: string;
  /** Display name the ctx advertises via `sessionManager.getSessionName()`. Omitted = unnamed session. */
  sessionName?: string;
  /**
   * Session id a `spawnChild`-minted child ctx advertises. Defaults to
   * `${sessionId}-child` so parent/child isolation is exercised, not masked.
   */
  childSessionId?: string;
}

/** A tool `execute()` ctx (Pi ≥ 1.1: `ExtensionToolContext`), which also satisfies `ExtensionContext`. */
export function createMockCtx(opts: MockCtxOptions = {}): ExtensionToolContext {
  return {
    hasUI: opts.hasUI ?? false,
    mode: opts.mode,
    cwd: opts.cwd ?? '/tmp/test-cwd',
    model: opts.model,
    ui: createMockUI(opts.ui),
    sessionManager: createMockSessionManager(opts.branch ?? [], opts.sessionId, opts.sessionName),
    modelRegistry: createMockModelRegistry(opts.models ?? []),
    isIdle: vi.fn(() => true),
    tools: [],
    executeTool: vi.fn(),
  } as unknown as ExtensionToolContext;
}
