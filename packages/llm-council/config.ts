import { randomUUID } from 'node:crypto';
import { readFileSync, lstatSync, mkdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getAgentDir, withFileMutationQueue } from '@earendil-works/pi-coding-agent';
import { sameModelReference, type CouncilSelection } from './selection.js';
import type { CouncilMemberUserConfig, LlmCouncilUserConfig } from './types.js';

// ── Defaults ───────────────────────────────────────────────────────────────
// Council lineup defaults to models available in this user's setup (see
// ~/.pi/agent/settings.json enabledModels). Override per-project via
// <cwd>/.pi/configs/llm-council.json — see loadCouncil() below.

export const DEFAULT_CONFIG = {
  SHARED: {
    SPINNER: {
      PREFIX_CHARS: ['·', '✢', '✳', '✶', '✻', '✽'],
      INTERVAL: 80,
      COLOR: 'muted',
    },
    SUCCESS_PREFIX: { PREFIX: '✓', COLOR: 'success' },
    ERROR_PREFIX: { PREFIX: '✗', COLOR: 'error' },
    BRANCH: { PREFIX: '└─', COLOR: 'separator' },
    STATUS: {
      DONE_LABEL: 'Done',
      DONE_COLOR: 'success',
      ERROR_LABEL: 'Error',
      ERROR_COLOR: 'error',
      WORKING_LABEL: 'Working...',
      WORKING_COLOR: 'dim',
      WAITING_ICON: '↪',
      WAITING_ICON_COLOR: 'muted',
      SYNTHESIZING_LABEL: 'Synthesising...',
      WAITING_LABEL: 'Waiting for members...',
      ELAPSED_COLOR: 'dim',
    },
    TOOL_HEADER: { TITLE_COLOR: 'toolTitle', SUMMARY_COLOR: 'dim' },
    EXPAND_HINT: { COLOR: 'dim' },
    QUESTION_PREVIEW: { MAX_LENGTH: 40 },
  },

  MEMBER: {
    // Diverse, cost-aware: two cheap open models via fireworks + one Claude.
    COUNCIL: [
      {
        model: 'fireworks/accounts/fireworks/models/glm-5p2',
        displayName: 'GLM 5.2',
        label: 'Member A',
      },
      {
        model: 'fireworks/accounts/fireworks/models/kimi-k3',
        displayName: 'Kimi K3',
        label: 'Member B',
      },
      { model: 'anthropic/claude-fable-5', displayName: 'Claude Fable 5', label: 'Member C' },
    ],
    DEFAULT_SYSTEM_PROMPT:
      "You are a member of an LLM Council. Answer the user's question thoroughly and concisely. Provide your best reasoning. Do not spawn subprocesses or delegate tasks to other agents.",
    DISPLAY: { LABEL_COLOR: 'accent', MODEL_COLOR: 'dim' },
    // Built-in read-only tools only — no extension loading needed in the
    // subprocess. Add web tools + the pi-web-access extension by path in your
    // config if you want members to browse.
    TOOLS: ['read', 'grep', 'find', 'ls'],
    THINKING: 'medium',
    EXTENSIONS: [] as string[],
    SKILLS: [] as string[],
    CONTEXT_FILES: false,
  },

  CHAIRMAN: {
    MODEL: 'anthropic/claude-opus-5',
    DISPLAY_NAME: 'Claude Opus 5',
    SYSTEM_PROMPT:
      'You are the Chairman of an LLM Council. Multiple AI models answered the same question anonymously, labeled A, B, C, etc. ' +
      'Synthesize the best answer, drawing on the strongest points from each response. ' +
      'Resolve any disagreements. Present a unified, well-reasoned answer. ' +
      'Do not mention which model gave which answer — treat them as anonymous perspectives.',
    EXPOSE_PERSONAS: true,
    DISPLAY: { ICON: '', LABEL_COLOR: 'accent', MODEL_COLOR: 'dim' },
    TOOLS: [] as string[],
    THINKING: 'medium',
    EXTENSIONS: [] as string[],
    SKILLS: [] as string[],
    CONTEXT_FILES: false,
  },
};

// ── Config paths ───────────────────────────────────────────────────────────
// Global:   ~/.pi/agent/configs/llm-council.json
// Project:  <cwd>/.pi/configs/llm-council.json   (deep-merged over global;
//           only the keys that differ need to be present — e.g. just
//           member.council and chairman.model for a per-project lineup)

export function councilConfigPath(): string {
  return join(getAgentDir(), 'configs', 'llm-council.json');
}

function projectConfigPath(cwd: string): string {
  return join(cwd, '.pi', 'configs', 'llm-council.json');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Missing, malformed, or non-object config files read as `{}`. */
function readJson(path: string): Partial<LlmCouncilUserConfig> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isPlainObject(value) ? (value as Partial<LlmCouncilUserConfig>) : {};
  } catch {
    return {};
  }
}

/** Keep only council entries with a non-empty string `model`; non-arrays are ignored entirely. */
function validCouncil(value: unknown, source: string): CouncilMemberUserConfig[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    console.error(`[llm-council] ignoring member.council in ${source}: expected an array`);
    return undefined;
  }
  const valid = value.filter(
    (entry): entry is CouncilMemberUserConfig =>
      isPlainObject(entry) && typeof entry.model === 'string' && entry.model.trim() !== '',
  );
  if (valid.length < value.length) {
    console.error(
      `[llm-council] ignoring ${value.length - valid.length} member.council entr${value.length - valid.length === 1 ? 'y' : 'ies'} in ${source}: each needs a non-empty string "model"`,
    );
  }
  return valid;
}

// ── Global config (shared + display) ───────────────────────────────────────
// Loaded once at module load. Rendering uses this for shared/display settings
// (which don't vary per project). The council lineup + exec config is resolved
// per-call via loadCouncil() so project-local overrides take effect.

const userConfig = loadUserConfig();

function loadUserConfig(): LlmCouncilUserConfig {
  return readJson(councilConfigPath());
}

export const CONFIG = {
  shared: {
    spinner: {
      prefixChars: userConfig.shared?.spinner?.prefixChars ?? DEFAULT_CONFIG.SHARED.SPINNER.PREFIX_CHARS,
      interval: userConfig.shared?.spinner?.interval ?? DEFAULT_CONFIG.SHARED.SPINNER.INTERVAL,
      color: userConfig.shared?.spinner?.color ?? DEFAULT_CONFIG.SHARED.SPINNER.COLOR,
    },
    successPrefix: {
      prefix: userConfig.shared?.successPrefix?.prefix ?? DEFAULT_CONFIG.SHARED.SUCCESS_PREFIX.PREFIX,
      color: userConfig.shared?.successPrefix?.color ?? DEFAULT_CONFIG.SHARED.SUCCESS_PREFIX.COLOR,
    },
    errorPrefix: {
      prefix: userConfig.shared?.errorPrefix?.prefix ?? DEFAULT_CONFIG.SHARED.ERROR_PREFIX.PREFIX,
      color: userConfig.shared?.errorPrefix?.color ?? DEFAULT_CONFIG.SHARED.ERROR_PREFIX.COLOR,
    },
    branch: {
      prefix: userConfig.shared?.branch?.prefix ?? DEFAULT_CONFIG.SHARED.BRANCH.PREFIX,
      color: userConfig.shared?.branch?.color ?? DEFAULT_CONFIG.SHARED.BRANCH.COLOR,
    },
    status: {
      doneColor: userConfig.shared?.status?.doneColor ?? DEFAULT_CONFIG.SHARED.STATUS.DONE_COLOR,
      doneLabel: userConfig.shared?.status?.doneLabel ?? DEFAULT_CONFIG.SHARED.STATUS.DONE_LABEL,
      errorColor: userConfig.shared?.status?.errorColor ?? DEFAULT_CONFIG.SHARED.STATUS.ERROR_COLOR,
      errorLabel: userConfig.shared?.status?.errorLabel ?? DEFAULT_CONFIG.SHARED.STATUS.ERROR_LABEL,
      workingColor: userConfig.shared?.status?.workingColor ?? DEFAULT_CONFIG.SHARED.STATUS.WORKING_COLOR,
      workingLabel: userConfig.shared?.status?.workingLabel ?? DEFAULT_CONFIG.SHARED.STATUS.WORKING_LABEL,
      waitingIcon: userConfig.shared?.status?.waitingIcon ?? DEFAULT_CONFIG.SHARED.STATUS.WAITING_ICON,
      waitingIconColor: userConfig.shared?.status?.waitingIconColor ?? DEFAULT_CONFIG.SHARED.STATUS.WAITING_ICON_COLOR,
      synthesizingLabel:
        userConfig.shared?.status?.synthesizingLabel ?? DEFAULT_CONFIG.SHARED.STATUS.SYNTHESIZING_LABEL,
      waitingLabel: userConfig.shared?.status?.waitingLabel ?? DEFAULT_CONFIG.SHARED.STATUS.WAITING_LABEL,
      elapsedColor: userConfig.shared?.status?.elapsedColor ?? DEFAULT_CONFIG.SHARED.STATUS.ELAPSED_COLOR,
    },
    toolHeader: {
      titleColor: userConfig.shared?.toolHeader?.titleColor ?? DEFAULT_CONFIG.SHARED.TOOL_HEADER.TITLE_COLOR,
      summaryColor: userConfig.shared?.toolHeader?.summaryColor ?? DEFAULT_CONFIG.SHARED.TOOL_HEADER.SUMMARY_COLOR,
    },
    expandHint: {
      color: userConfig.shared?.expandHint?.color ?? DEFAULT_CONFIG.SHARED.EXPAND_HINT.COLOR,
    },
    questionPreview: {
      maxLength: userConfig.shared?.questionPreview?.maxLength ?? DEFAULT_CONFIG.SHARED.QUESTION_PREVIEW.MAX_LENGTH,
    },
  },

  member: {
    display: {
      labelColor: userConfig.member?.display?.labelColor ?? DEFAULT_CONFIG.MEMBER.DISPLAY.LABEL_COLOR,
      modelColor: userConfig.member?.display?.modelColor ?? DEFAULT_CONFIG.MEMBER.DISPLAY.MODEL_COLOR,
    },
  },

  chairman: {
    display: {
      icon: userConfig.chairman?.display?.icon ?? DEFAULT_CONFIG.CHAIRMAN.DISPLAY.ICON,
      labelColor: userConfig.chairman?.display?.labelColor ?? DEFAULT_CONFIG.CHAIRMAN.DISPLAY.LABEL_COLOR,
      modelColor: userConfig.chairman?.display?.modelColor ?? DEFAULT_CONFIG.CHAIRMAN.DISPLAY.MODEL_COLOR,
    },
  },
};

// ── Per-project council resolution ─────────────────────────────────────────

export interface ResolvedCouncil {
  member: {
    council: { model: string; displayName?: string | undefined; label: string; systemPrompt: string }[];
    defaultSystemPrompt: string;
    tools: string[] | null;
    thinking: string | null;
    extensions: string[] | null;
    skills: string[] | null;
    contextFiles: boolean;
  };
  chairman: {
    model: string;
    displayName?: string | undefined;
    systemPrompt: string;
    exposePersonas: boolean;
    tools: string[] | null;
    thinking: string | null;
    extensions: string[] | null;
    skills: string[] | null;
    contextFiles: boolean;
  };
}

/**
 * Execution settings reload per call. Display settings remain module-scoped.
 * The project file can grant child sessions tools and prompts, so it is only
 * read when the project is trusted (`ctx.isProjectTrusted()`).
 */
export function loadCouncil(cwd: string, projectTrusted: boolean): ResolvedCouncil {
  const global = loadUserConfig();
  const projectPath = projectConfigPath(cwd);
  const proj = projectTrusted ? readJson(projectPath) : {};
  const gm = global.member;
  const gc = global.chairman;
  const pm = proj.member;
  const pc = proj.chairman;
  const defaultSystemPrompt =
    pm?.defaultSystemPrompt ?? gm?.defaultSystemPrompt ?? DEFAULT_CONFIG.MEMBER.DEFAULT_SYSTEM_PROMPT;
  const council = (
    validCouncil(pm?.council, projectPath) ??
    validCouncil(gm?.council, councilConfigPath()) ??
    DEFAULT_CONFIG.MEMBER.COUNCIL
  ).map((m: CouncilMemberUserConfig, i) => ({
    model: m.model,
    displayName: m.displayName,
    label: m.label ?? String(i + 1),
    systemPrompt: m.systemPrompt ?? defaultSystemPrompt,
  }));
  const chairmanModel = pc?.model ?? gc?.model ?? DEFAULT_CONFIG.CHAIRMAN.MODEL;

  return {
    member: {
      council,
      defaultSystemPrompt,
      tools: pm?.tools ?? gm?.tools ?? DEFAULT_CONFIG.MEMBER.TOOLS,
      thinking:
        pm?.thinking !== undefined
          ? pm.thinking
          : gm?.thinking !== undefined
            ? gm.thinking
            : DEFAULT_CONFIG.MEMBER.THINKING,
      extensions: pm?.extensions ?? gm?.extensions ?? DEFAULT_CONFIG.MEMBER.EXTENSIONS,
      skills: pm?.skills ?? gm?.skills ?? DEFAULT_CONFIG.MEMBER.SKILLS,
      contextFiles: pm?.contextFiles ?? gm?.contextFiles ?? DEFAULT_CONFIG.MEMBER.CONTEXT_FILES,
    },
    chairman: {
      model: chairmanModel,
      displayName:
        pc?.displayName ??
        (pc?.model ? undefined : gc?.displayName) ??
        (chairmanModel === DEFAULT_CONFIG.CHAIRMAN.MODEL ? DEFAULT_CONFIG.CHAIRMAN.DISPLAY_NAME : undefined),
      systemPrompt: pc?.systemPrompt ?? gc?.systemPrompt ?? DEFAULT_CONFIG.CHAIRMAN.SYSTEM_PROMPT,
      exposePersonas: pc?.exposePersonas ?? gc?.exposePersonas ?? DEFAULT_CONFIG.CHAIRMAN.EXPOSE_PERSONAS,
      tools: pc?.tools ?? gc?.tools ?? DEFAULT_CONFIG.CHAIRMAN.TOOLS,
      thinking:
        pc?.thinking !== undefined
          ? pc.thinking
          : gc?.thinking !== undefined
            ? gc.thinking
            : DEFAULT_CONFIG.CHAIRMAN.THINKING,
      extensions: pc?.extensions ?? gc?.extensions ?? DEFAULT_CONFIG.CHAIRMAN.EXTENSIONS,
      skills: pc?.skills ?? gc?.skills ?? DEFAULT_CONFIG.CHAIRMAN.SKILLS,
      contextFiles: pc?.contextFiles ?? gc?.contextFiles ?? DEFAULT_CONFIG.CHAIRMAN.CONTEXT_FILES,
    },
  };
}

/** Preserve unrelated settings and config symlinks. Never overwrite invalid JSON. */
export async function saveCouncilDefaults(selection: CouncilSelection): Promise<void> {
  const path = councilConfigPath();
  await withFileMutationQueue(path, async () => {
    const existing = lstatSync(path, { throwIfNoEntry: false });
    const target = existing ? realpathSync(path) : path;
    const value = existing ? JSON.parse(readFileSync(target, 'utf8')) : {};
    for (const object of [value, value?.member ?? {}, value?.chairman ?? {}]) {
      if (!object || typeof object !== 'object' || Array.isArray(object)) {
        throw new Error(`Invalid council config at ${path}. Expected objects. File left unchanged.`);
      }
    }
    const previous = validCouncil(value.member?.council, path);
    value.member = {
      ...value.member,
      council: selection.models.map((model) => ({
        ...previous?.find((member) => sameModelReference(member.model, model)),
        model,
      })),
      thinking: selection.memberThinking,
    };
    value.chairman = {
      ...value.chairman,
      model: selection.chairman,
      displayName:
        value.chairman?.model && sameModelReference(value.chairman.model, selection.chairman)
          ? value.chairman.displayName
          : undefined,
      thinking: selection.chairmanThinking,
    };
    mkdirSync(dirname(target), { recursive: true });
    const temporaryPath = `${target}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
        flag: 'wx',
        mode: existing ? statSync(target).mode & 0o777 : 0o600,
      });
      renameSync(temporaryPath, target);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  });
}
