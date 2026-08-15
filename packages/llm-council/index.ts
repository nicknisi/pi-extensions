/**
 * LLM Council Tool — Ask multiple models, synthesize with a chairman.
 *
 * Spawns member models in parallel, then a chairman model
 * that synthesizes the answers into a final response.
 * Progress streams inline via renderResult.
 *
 * Rendering follows styled-outputs visual vocabulary:
 * ✓/✗ prefix, └─ branch lines, · indent, expand hints.
 * All labels, colors, and symbols are configurable via
 * ~/.pi/agent/configs/llm-council.json
 */

import * as path from 'node:path';
import type { ExtensionAPI, Theme } from '@earendil-works/pi-coding-agent';
import { getMarkdownTheme } from '@earendil-works/pi-coding-agent';
import { Markdown, Text } from '@earendil-works/pi-tui';
import {
  createSubagentRuntime,
  resolveContainedAgentResource,
  type SpawnUsage,
  type SubagentRuntime,
} from '@nicknisi/pi-shared';
import { Type } from 'typebox';
import { CONFIG, loadCouncil, type ResolvedCouncil } from './config.js';
import { applyColor, formatElapsed, getExpandToggleKey, getVisibleWidth } from './utils.js';

// ── Derived constants (computed once from CONFIG) ────────────────────────

const SPINNER_FRAMES = [...CONFIG.shared.spinner.prefixChars, ...[...CONFIG.shared.spinner.prefixChars].reverse()];
const INDENT_WIDTH = getVisibleWidth(CONFIG.shared.branch.prefix) + 1;

// ── Styling helpers ──────────────────────────────────────────────────────

function successPrefix(theme: Theme): string {
  return `${applyColor(theme, CONFIG.shared.successPrefix.color, CONFIG.shared.successPrefix.prefix)} `;
}

function errorPrefix(theme: Theme): string {
  return `${applyColor(theme, CONFIG.shared.errorPrefix.color, CONFIG.shared.errorPrefix.prefix)} `;
}

function branchLine(text: string, theme: Theme): string {
  return `${applyColor(theme, CONFIG.shared.branch.color, CONFIG.shared.branch.prefix)} ${text}`;
}

function indentLine(text: string): string {
  return `${' '.repeat(INDENT_WIDTH)}${text}`;
}

function expandHint(theme: Theme): string {
  return applyColor(theme, CONFIG.shared.expandHint.color, ` • ${getExpandToggleKey()} to expand`);
}

function toolHeader(label: string, summary: string, theme: Theme, dot?: string, isError?: boolean): string {
  const d = dot ?? (isError ? errorPrefix(theme) : successPrefix(theme));
  const title = applyColor(theme, CONFIG.shared.toolHeader.titleColor, theme.bold(label));
  return `${d}${title} ${summary}`;
}

/** Status icon: ✓ / ✗ / spinner frame / waiting glyph. */
function statusIcon(status: MemberResult['status'], theme: Theme, spinnerFrame: number): string {
  switch (status) {
    case 'done':
      return applyColor(theme, CONFIG.shared.status.doneColor, CONFIG.shared.successPrefix.prefix);
    case 'error':
      return applyColor(theme, CONFIG.shared.status.errorColor, CONFIG.shared.errorPrefix.prefix);
    case 'working':
      return applyColor(theme, CONFIG.shared.spinner.color, SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]!);
    default:
      return applyColor(theme, CONFIG.shared.status.waitingIconColor, CONFIG.shared.status.waitingIcon);
  }
}

/** `<icon> <label> <model>` member row. */
function memberHeader(icon: string, m: Pick<MemberResult, 'label' | 'model' | 'displayName'>, theme: Theme): string {
  return indentLine(
    `${icon} ${applyColor(theme, CONFIG.member.display.labelColor, m.label)} ${applyColor(theme, CONFIG.member.display.modelColor, m.displayName ?? m.model)}`,
  );
}

/** `<icon> [badge] Chairman <model>` row. */
function chairmanHeader(icon: string, c: { model: string; displayName?: string | undefined }, theme: Theme): string {
  const badge = CONFIG.chairman.display.icon ? `${CONFIG.chairman.display.icon} ` : '';
  return indentLine(
    `${icon} ${badge}${applyColor(theme, CONFIG.chairman.display.labelColor, 'Chairman')} ${applyColor(theme, CONFIG.chairman.display.modelColor, c.displayName ?? c.model)}`,
  );
}

function tokenSuffix(theme: Theme, usage: SpawnUsage | undefined): string {
  if (!usage) return '';
  const k = usage.totalTokens / 1000;
  const count = `${k >= 10 ? Math.round(k) : k.toFixed(1)}k tok`;
  return applyColor(theme, CONFIG.shared.status.elapsedColor, ` · ${count}`);
}

/** "done + elapsed + tokens" sub-line. */
function doneLine(theme: Theme, m: { startedAt?: number; doneAt?: number; usage?: SpawnUsage }): string {
  return `${applyColor(theme, CONFIG.shared.status.doneColor, CONFIG.shared.status.doneLabel)} ${applyColor(theme, CONFIG.shared.status.elapsedColor, formatElapsed(m.startedAt, m.doneAt))}${tokenSuffix(theme, m.usage)}`;
}

/** "error message (or label) + elapsed" sub-line. */
function errorLine(theme: Theme, m: { error?: string; startedAt?: number; doneAt?: number }): string {
  return `${applyColor(theme, CONFIG.shared.status.errorColor, m.error?.slice(0, 60) || CONFIG.shared.status.errorLabel)} ${applyColor(theme, CONFIG.shared.status.elapsedColor, formatElapsed(m.startedAt, m.doneAt))}`;
}

function workingLine(theme: Theme, usage: SpawnUsage | undefined, label = CONFIG.shared.status.workingLabel): string {
  return `${applyColor(theme, CONFIG.shared.status.workingColor, label)}${tokenSuffix(theme, usage)}`;
}

/** Sub-line while members may still be running: done/error show elapsed, else "working". */
function memberLiveSubLine(m: MemberResult, theme: Theme): string {
  if (m.status === 'done') return doneLine(theme, m);
  if (m.status === 'error') return errorLine(theme, m);
  return workingLine(theme, m.usage);
}

/** Sub-line once members have settled (done or error only). */
function memberFinalSubLine(m: MemberResult, theme: Theme): string {
  return m.status === 'done' ? doneLine(theme, m) : errorLine(theme, m);
}

function makeText(lastComponent: any, text: string): Text {
  const comp = lastComponent instanceof Text ? lastComponent : new Text('', 0, 0);
  comp.setText(text);
  return comp;
}

function renderMemberTree(
  details: CouncilDetails,
  theme: Theme,
  spinnerFrame: number,
  opts: {
    memberSubLine: (m: MemberResult) => string;
    chairmanSubLine: string;
    chairmanSubLineSuffix?: string;
  },
): string[] {
  const lines: string[] = [];
  for (const m of details.members) {
    lines.push(memberHeader(statusIcon(m.status, theme, spinnerFrame), m, theme));
    lines.push(indentLine(branchLine(opts.memberSubLine(m), theme)));
    lines.push('');
  }
  if (details.chairman) {
    lines.push(chairmanHeader(statusIcon(details.chairman.status, theme, spinnerFrame), details.chairman, theme));
    const suffix = opts.chairmanSubLineSuffix ?? '';
    lines.push(indentLine(branchLine(opts.chairmanSubLine + suffix, theme)));
  }
  return lines;
}

function ensureSpinner(ctx: any): number {
  if (ctx?.state?.spinnerInterval) return ctx.state.spinnerFrame ?? 0;
  if (!ctx?.state) ctx.state = {};
  ctx.state.spinnerFrame = 0;
  ctx.state.spinnerInterval = setInterval(() => {
    ctx.state.spinnerFrame = (ctx.state.spinnerFrame + 1) % SPINNER_FRAMES.length;
    ctx.invalidate?.();
  }, CONFIG.shared.spinner.interval);
  return 0;
}

function clearSpinner(ctx: any) {
  if (ctx?.state?.spinnerInterval) {
    clearInterval(ctx.state.spinnerInterval);
    ctx.state.spinnerInterval = undefined;
  }
}

function spinnerDot(theme: Theme, frame: number): string {
  return `${applyColor(theme, CONFIG.shared.spinner.color, SPINNER_FRAMES[frame % SPINNER_FRAMES.length]!)} `;
}

function createExpandedView(details: CouncilDetails, theme: Theme, markdownTheme: any) {
  const memberMds = details.members.map((m) => ({
    m,
    md: m.status === 'done' && m.text ? new Markdown(m.text.trim(), 0, 0, markdownTheme) : null,
  }));
  const chairmanMd = details.chairman?.text ? new Markdown(details.chairman.text.trim(), 0, 0, markdownTheme) : null;

  let cachedWidth: number | undefined;
  let cachedLines: string[] | undefined;

  return {
    render(width: number): string[] {
      if (cachedLines && cachedWidth === width) return cachedLines;
      const cw = Math.max(1, width - INDENT_WIDTH * 2);
      const lines: string[] = [''];

      for (const { m, md } of memberMds) {
        const icon =
          m.status === 'error'
            ? applyColor(theme, CONFIG.shared.status.errorColor, CONFIG.shared.errorPrefix.prefix)
            : applyColor(theme, CONFIG.shared.status.doneColor, CONFIG.shared.successPrefix.prefix);
        lines.push(memberHeader(icon, m, theme));
        if (m.status === 'error') {
          // Error label + elapsed only; the full error message gets its own line below.
          lines.push(
            indentLine(
              branchLine(
                `${applyColor(theme, CONFIG.shared.status.errorColor, CONFIG.shared.status.errorLabel)} ${applyColor(theme, CONFIG.shared.status.elapsedColor, formatElapsed(m.startedAt, m.doneAt))}`,
                theme,
              ),
            ),
          );
          if (m.error) lines.push(indentLine(indentLine(applyColor(theme, CONFIG.shared.status.errorColor, m.error))));
        } else {
          lines.push(indentLine(branchLine(doneLine(theme, m), theme)));
          if (md) for (const l of md.render(cw)) lines.push(indentLine(indentLine(l)));
        }
        lines.push('');
      }

      if (details.chairman) {
        const cIcon =
          details.chairman.status === 'error'
            ? applyColor(theme, CONFIG.shared.status.errorColor, CONFIG.shared.errorPrefix.prefix)
            : applyColor(theme, CONFIG.shared.status.doneColor, CONFIG.shared.successPrefix.prefix);
        const cStatus =
          details.chairman.status === 'done'
            ? doneLine(theme, details.chairman)
            : applyColor(theme, CONFIG.shared.status.errorColor, CONFIG.shared.status.errorLabel);
        lines.push(chairmanHeader(cIcon, details.chairman, theme));
        lines.push(indentLine(branchLine(cStatus, theme)));
        if (details.chairman.status === 'error' && details.chairman.error) {
          lines.push(
            indentLine(indentLine(applyColor(theme, CONFIG.shared.status.errorColor, details.chairman.error))),
          );
        } else if (chairmanMd) {
          for (const l of chairmanMd.render(cw)) lines.push(indentLine(indentLine(l)));
        }
      }

      cachedWidth = width;
      cachedLines = lines;
      return lines;
    },
    invalidate() {
      cachedWidth = undefined;
      cachedLines = undefined;
      for (const { md } of memberMds) md?.invalidate();
      chairmanMd?.invalidate();
    },
  };
}

// ── Types ────────────────────────────────────────────────────────────────

interface MemberResult {
  label: string;
  model: string;
  displayName?: string | undefined;
  systemPrompt: string;
  status: 'pending' | 'working' | 'done' | 'error';
  text: string;
  error?: string;
  startedAt?: number;
  doneAt?: number;
  usage?: SpawnUsage;
}

interface CouncilDetails {
  stage: 'members' | 'chairman' | 'complete' | 'error';
  members: MemberResult[];
  chairman?: {
    model: string;
    displayName?: string | undefined;
    status: 'pending' | 'working' | 'done' | 'error';
    text: string;
    error?: string;
    startedAt?: number;
    doneAt?: number;
    usage?: SpawnUsage;
  };
}

// Council `extensions`/`skills` entries are bare resource names resolved under
// the user's own agent dir. Project-local config (<cwd>/.pi/configs/llm-council.json)
// is untrusted repository input, so names are containment-checked by the shared
// resolver before reaching the child's resource loader.
function resolveResourceNames(kind: 'extensions' | 'skills', names: string[] | null, leaf: string): string[] {
  if (!names?.length) return [];
  const out: string[] = [];
  for (const name of names) {
    const resolved = resolveContainedAgentResource(kind, name, leaf);
    if (resolved === null) {
      console.error(
        `[llm-council] ignoring ${kind} ${JSON.stringify(name)}: names must be bare (no path separators or "..")`,
      );
      continue;
    }
    out.push(resolved);
  }
  return out;
}

// ── Council logic ─────────────────────────────────────────────────────────

async function runCouncil(
  subagents: SubagentRuntime,
  question: string,
  cwd: string,
  council: ResolvedCouncil,
  signal: AbortSignal | undefined,
  onUpdate: (details: CouncilDetails) => void,
): Promise<{ content: { type: 'text'; text: string }[]; details: CouncilDetails }> {
  const memberSpawn = {
    tools: council.member.tools ?? [],
    extensionPaths: resolveResourceNames('extensions', council.member.extensions, path.join('src', 'index.ts')),
    skillPaths: resolveResourceNames('skills', council.member.skills, 'SKILL.md'),
    includeContextFiles: council.member.contextFiles,
  };

  const details: CouncilDetails = {
    stage: 'members',
    members: council.member.council.map((m) => ({
      label: m.label,
      model: m.model,
      displayName: m.displayName,
      systemPrompt: m.systemPrompt,
      status: 'pending' as const,
      text: '',
    })),
    chairman: {
      model: council.chairman.model,
      displayName: council.chairman.displayName,
      status: 'pending',
      text: '',
    },
  };

  const emit = () => onUpdate(details);

  // Phase 1: Run members in parallel
  emit();

  const memberPromises = details.members.map(async (m) => {
    m.status = 'working';
    m.startedAt = Date.now();
    emit();
    const result = await subagents.spawn({
      agent: `member-${m.label}`,
      model: m.model,
      prompt: question,
      systemPrompt: m.systemPrompt,
      cwd,
      ...(signal ? { signal } : {}),
      ...(council.member.thinking ? { thinkingLevel: council.member.thinking } : {}),
      ...memberSpawn,
      onUsage: (usage) => {
        m.usage = usage;
        emit();
      },
    });
    m.usage = result.usage;
    if (result.ok) {
      m.status = 'done';
      m.doneAt = Date.now();
      m.text = result.text;
    } else {
      m.status = 'error';
      m.doneAt = Date.now();
      m.error = result.error || 'Failed';
      m.text = result.text || '';
    }
    emit();
  });

  await Promise.all(memberPromises);

  const successfulMembers = details.members.filter((m) => m.status === 'done' && m.text);
  if (successfulMembers.length === 0) {
    details.stage = 'error';
    emit();
    return {
      content: [{ type: 'text', text: `Council failed: no models returned valid responses.` }],
      details,
    };
  }

  // Phase 2: Run chairman
  // Held in a local so the mutations below don't each have to re-narrow
  // the optional `details.chairman`; both reference the same object.
  const chairman: NonNullable<CouncilDetails['chairman']> = {
    model: council.chairman.model,
    displayName: council.chairman.displayName,
    status: 'working',
    text: '',
    startedAt: Date.now(),
  };
  details.chairman = chairman;
  details.stage = 'chairman';
  emit();

  let chairmanPrompt = `Question: ${question}\n\nHere are answers from council members:\n`;
  for (const m of successfulMembers) {
    if (council.chairman.exposePersonas && m.systemPrompt) {
      chairmanPrompt += `\n--- Member ${m.label} (persona: "${m.systemPrompt}") ---\n${m.text}\n`;
    } else {
      chairmanPrompt += `\n--- Member ${m.label} ---\n${m.text}\n`;
    }
  }
  chairmanPrompt += '\n---\nSynthesize a unified answer incorporating the best points from each response.';

  const chairmanResult = await subagents.spawn({
    agent: 'chairman',
    model: council.chairman.model,
    prompt: chairmanPrompt,
    systemPrompt: council.chairman.systemPrompt,
    cwd,
    ...(signal ? { signal } : {}),
    ...(council.chairman.thinking ? { thinkingLevel: council.chairman.thinking } : {}),
    tools: council.chairman.tools ?? [],
    extensionPaths: resolveResourceNames('extensions', council.chairman.extensions, path.join('src', 'index.ts')),
    skillPaths: resolveResourceNames('skills', council.chairman.skills, 'SKILL.md'),
    includeContextFiles: council.chairman.contextFiles,
    onUsage: (usage) => {
      chairman.usage = usage;
      emit();
    },
  });

  chairman.usage = chairmanResult.usage;
  if (chairmanResult.ok) {
    chairman.status = 'done';
    chairman.doneAt = Date.now();
    chairman.text = chairmanResult.text;
  } else {
    chairman.status = 'error';
    chairman.doneAt = Date.now();
    chairman.error = chairmanResult.error || 'Chairman failed';
    chairman.text = chairmanResult.text || '';
  }

  details.stage = 'complete';
  emit();

  const finalText = chairman.text || chairman.error || 'No output from chairman';
  return {
    content: [{ type: 'text', text: finalText }],
    details,
  };
}

// ── Live progress bridge (renderCall workaround for isPartial bug) ────────
let liveDetails: CouncilDetails | null = null;

// ── Tool registration ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const subagents = createSubagentRuntime({ namespace: 'llm-council' });
  pi.registerTool({
    name: 'llm_council',
    label: 'LLM Council',
    description: [
      'Convene an LLM Council — multiple models answer a question independently,',
      'then a chairman synthesizes their answers into a unified response.',
      'Use for questions that benefit from multiple perspectives, cross-checking,',
      'or when accuracy matters. Not for simple factual questions.',
    ].join(' '),
    promptSnippet: 'Ask multiple LLMs for a council opinion',
    promptGuidelines: [
      'Use llm_council for complex questions that benefit from multiple LLM perspectives or cross-checking.',
      'Do NOT use llm_council for simple factual questions or routine tasks.',
    ],
    parameters: Type.Object({
      question: Type.String({ description: 'The question to pose to the council' }),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const council = loadCouncil(ctx.cwd);
      return runCouncil(subagents, params.question, ctx.cwd, council, signal, (details) => {
        liveDetails = details;
        const stageLabels: Record<string, string> = {
          members: CONFIG.shared.status.waitingLabel,
          chairman: CONFIG.shared.status.synthesizingLabel,
          complete: CONFIG.shared.status.doneLabel,
          error: CONFIG.shared.status.errorLabel,
        };
        const doneCount = details.members.filter((m) => m.status === 'done' || m.status === 'error').length;
        const stageText = stageLabels[details.stage] || details.stage;
        let text = `[Council] ${stageText}`;
        if (details.stage === 'members') {
          text += ` ${doneCount}/${details.members.length} done`;
        }
        onUpdate?.({
          content: [{ type: 'text', text }],
          details,
        });
      });
    },

    renderCall(args, theme, ctx) {
      const preview =
        args.question?.length > CONFIG.shared.questionPreview.maxLength
          ? `${args.question.slice(0, CONFIG.shared.questionPreview.maxLength)}...`
          : args.question || '...';
      const summary = applyColor(theme, CONFIG.shared.toolHeader.summaryColor, preview);

      if (!ctx?.isPartial) {
        clearSpinner(ctx);
        liveDetails = null;
        return makeText(ctx?.lastComponent, toolHeader('LLM Council', summary, theme));
      }

      const frame = ensureSpinner(ctx);
      const lines = [toolHeader('LLM Council', summary, theme, spinnerDot(theme, frame)), ''];

      // Live progress from onUpdate
      if (!liveDetails) {
        lines.push(
          indentLine(
            branchLine(applyColor(theme, CONFIG.shared.status.workingColor, CONFIG.shared.status.workingLabel), theme),
          ),
        );
        return makeText(ctx.lastComponent, lines.join('\n'));
      }
      const details = liveDetails;
      lines.push(
        ...renderMemberTree(details, theme, frame, {
          memberSubLine: (m) => memberLiveSubLine(m, theme),
          chairmanSubLine:
            details.stage === 'chairman' && details.chairman?.status === 'working'
              ? workingLine(theme, details.chairman.usage, CONFIG.shared.status.synthesizingLabel)
              : applyColor(theme, CONFIG.shared.status.workingColor, CONFIG.shared.status.waitingLabel),
        }),
      );
      return makeText(ctx.lastComponent, lines.join('\n'));
    },

    renderResult(result, options, theme, ctx) {
      const details = result.details as CouncilDetails | undefined;
      const expanded = options?.expanded ?? false;

      // No details — plain text fallback
      if (!details) {
        const text = result.content[0];
        return makeText(ctx?.lastComponent, text?.type === 'text' ? text.text : '(no output)');
      }

      const frame = ctx?.state?.spinnerFrame ?? 0;

      // ── Error state ──────────────────────────────────────────────────
      if (details.stage === 'error') {
        const lines = [
          '',
          ...renderMemberTree(details, theme, 0, {
            memberSubLine: (m) =>
              applyColor(
                theme,
                CONFIG.shared.status.errorColor,
                m.error?.slice(0, 60) || CONFIG.shared.status.errorLabel,
              ),
            chairmanSubLine: applyColor(theme, CONFIG.shared.status.workingColor, CONFIG.shared.status.waitingLabel),
          }),
        ];
        return makeText(ctx?.lastComponent, lines.join('\n'));
      }

      // ── Progress: members deliberating ─────────────────────────────────
      if (details.stage === 'members') {
        const lines = renderMemberTree(details, theme, frame, {
          memberSubLine: (m) => memberLiveSubLine(m, theme),
          chairmanSubLine: applyColor(theme, CONFIG.shared.status.workingColor, CONFIG.shared.status.waitingLabel),
        });
        return makeText(ctx?.lastComponent, lines.join('\n'));
      }

      // ── Progress: chairman synthesizing ────────────────────────────────
      if (details.stage === 'chairman') {
        const c = details.chairman;
        let chairmanSubLine: string;
        if (c?.status === 'working')
          chairmanSubLine = workingLine(theme, c.usage, CONFIG.shared.status.synthesizingLabel);
        else if (c?.status === 'error')
          chairmanSubLine = applyColor(
            theme,
            CONFIG.shared.status.errorColor,
            c.error?.slice(0, 60) || CONFIG.shared.status.errorLabel,
          );
        else if (c?.status === 'done') chairmanSubLine = doneLine(theme, c);
        else chairmanSubLine = applyColor(theme, CONFIG.shared.status.workingColor, CONFIG.shared.status.waitingLabel);

        const lines = [
          '',
          ...renderMemberTree(details, theme, frame, {
            memberSubLine: (m) => memberFinalSubLine(m, theme),
            chairmanSubLine,
          }),
        ];
        return makeText(ctx?.lastComponent, lines.join('\n'));
      }

      // ── Complete: collapsed ────────────────────────────────────────────
      if (!expanded) {
        const lines = [
          '',
          ...renderMemberTree(details, theme, 0, {
            memberSubLine: (m) => memberFinalSubLine(m, theme),
            chairmanSubLine:
              details.chairman?.status === 'error'
                ? applyColor(
                    theme,
                    CONFIG.shared.status.errorColor,
                    details.chairman.error?.slice(0, 60) || CONFIG.shared.status.errorLabel,
                  )
                : doneLine(theme, details.chairman!),
            chairmanSubLineSuffix: expandHint(theme),
          }),
        ];
        return makeText(ctx?.lastComponent, lines.join('\n'));
      }

      // ── Complete: expanded ────────────────────────────────────────────
      return createExpandedView(details, theme, getMarkdownTheme());
    },
  });
}
