import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxProvider,
  type AssistantMessage,
  type Model,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import {
  applyLeadingSystemInstruction,
  buildSummaryStreamFn,
  interpolateGuidance,
  leadingSystemInstruction,
  loadGuidanceTemplate,
  renderGuidance,
  resolveCompactionInstruction,
  runSelfCompaction,
  type CompactionPreparation,
  type GuidanceValues,
  type StreamSimpleFn,
} from './extensions/self-compact/prompts.js';

function streamOf(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: 'done', reason: 'stop', message });
  stream.end(message);
  return stream;
}

function capturingProvider(response: AssistantMessage) {
  const captured: { context?: TranscriptContext } = {};
  const streamSimple: StreamSimpleFn = (_model, context, _options) => {
    captured.context = context as unknown as TranscriptContext;
    return streamOf(response);
  };
  return { streamSimple, captured };
}

function transcript(systemText: string): TranscriptContext {
  return {
    messages: [
      { role: 'system', content: systemText, timestamp: Date.now() },
      { role: 'user', content: 'summarize this', timestamp: Date.now() },
    ],
  } as unknown as TranscriptContext;
}

function preparation(): CompactionPreparation {
  return {
    firstKeptEntryId: 'keep-1',
    messagesToSummarize: [{ role: 'user', content: [{ type: 'text', text: 'earlier work' }], timestamp: Date.now() }],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 4321,
    fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
    settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
  } as unknown as CompactionPreparation;
}

function fauxModel(): Model<string> {
  return fauxProvider({ provider: 'faux', models: [{ id: 'faux-1', contextWindow: 200000 }] }).getModel();
}

const DEFAULT_INSTRUCTION = 'DEFAULT summary instruction';

describe('prompt overrides', () => {
  it('replaces the leading transcript system instruction, not an obsolete field', () => {
    const ctx = transcript('pi default summarizer prompt');
    applyLeadingSystemInstruction(ctx, 'CUSTOM instruction');
    expect(leadingSystemInstruction(ctx)).toBe('CUSTOM instruction');
    expect(ctx.messages[0]?.role).toBe('system');
  });

  it('inserts a leading system message when the transcript lacks one', () => {
    const ctx = { messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] } as unknown as TranscriptContext;
    applyLeadingSystemInstruction(ctx, 'CUSTOM instruction');
    expect(ctx.messages[0]?.role).toBe('system');
    expect(leadingSystemInstruction(ctx)).toBe('CUSTOM instruction');
  });

  it('prefers a literal --compact-prompt override over the editable default file', () => {
    const resolved = resolveCompactionInstruction({
      compactPromptOverride: 'LITERAL override wins',
      loadDefault: () => DEFAULT_INSTRUCTION,
    });
    expect(resolved).toBe('LITERAL override wins');
  });

  it('falls back to the editable default when there is no override', () => {
    expect(resolveCompactionInstruction({ loadDefault: () => DEFAULT_INSTRUCTION })).toBe(DEFAULT_INSTRUCTION);
    expect(resolveCompactionInstruction({ compactPromptOverride: '   ', loadDefault: () => DEFAULT_INSTRUCTION })).toBe(
      DEFAULT_INSTRUCTION,
    );
  });

  it('sends the resolved instruction as the leading system message of the actual request', async () => {
    const { streamSimple, captured } = capturingProvider(fauxAssistantMessage('## Goal\nfinish the task'));
    const result = await runSelfCompaction({
      preparation: preparation(),
      model: fauxModel(),
      streamSimple,
      loadDefault: () => DEFAULT_INSTRUCTION,
    });
    expect(result.summary).toContain('## Goal');
    expect(captured.context).toBeDefined();
    expect(leadingSystemInstruction(captured.context!)).toBe(DEFAULT_INSTRUCTION);
  });

  it('routes a literal override through the actual summary request', async () => {
    const { streamSimple, captured } = capturingProvider(fauxAssistantMessage('summary body'));
    await runSelfCompaction({
      preparation: preparation(),
      model: fauxModel(),
      streamSimple,
      compactPromptOverride: 'OVERRIDE for this request',
      loadDefault: () => DEFAULT_INSTRUCTION,
    });
    expect(leadingSystemInstruction(captured.context!)).toBe('OVERRIDE for this request');
  });

  it('builds a stream callback that overrides then delegates to the provider', () => {
    let seen: TranscriptContext | undefined;
    const streamSimple: StreamSimpleFn = (_m, context) => {
      seen = context as unknown as TranscriptContext;
      return streamOf(fauxAssistantMessage('x'));
    };
    const fn = buildSummaryStreamFn('INSTRUCTION', streamSimple);
    const ctx = transcript('to be replaced');
    fn(fauxModel(), ctx, undefined);
    expect(leadingSystemInstruction(seen!)).toBe('INSTRUCTION');
  });
});

describe('guidance prompts', () => {
  const values: GuidanceValues = {
    tokens: 250000,
    percent: 25,
    context_window: 1_000_000,
    soft_tokens: 225000,
    warning_tokens: 250000,
    hard_tokens: 270000,
    hard_percent: 27,
  };

  it('interpolates the documented vocabulary and leaves unknown tokens intact', () => {
    const out = interpolateGuidance(
      '{{tokens}}/{{context_window}} = {{percent}}%, hard {{hard_tokens}} ({{hard_percent}}%) {{unknown}}',
      values,
    );
    expect(out).toBe('250000/1000000 = 25%, hard 270000 (27%) {{unknown}}');
  });

  it('loads the soft template and states that the guidance is optional', () => {
    const template = loadGuidanceTemplate('soft');
    expect(template.toLowerCase()).toContain('optional');
    expect(template).toContain('{{tokens}}');
  });

  it('loads the warning template and names the hard cutoff', () => {
    const template = loadGuidanceTemplate('warning');
    expect(template.toLowerCase()).toContain('compact');
    expect(template).toContain('{{hard_tokens}}');
  });

  it('renders a soft heads-up with live values and no leftover placeholders', () => {
    const rendered = renderGuidance('soft', values);
    expect(rendered).toContain('250000');
    expect(rendered).toContain('270000');
    expect(rendered).not.toMatch(/\{\{\w+\}\}/);
  });

  it('describes the useful note contents in both templates', () => {
    for (const level of ['soft', 'warning'] as const) {
      const rendered = renderGuidance(level, values);
      expect(rendered.toLowerCase()).toContain('note_to_self');
      expect(rendered.toLowerCase()).toContain('next unfinished action');
    }
  });

  it('propagates a template load failure to the caller so compaction guidance never silently vanishes', () => {
    expect(() =>
      renderGuidance('soft', values, () => {
        throw new Error('self-compact: cannot read guidance template USER_PROMPT_SOFT_SELF_COMPACT.md');
      }),
    ).toThrow(/cannot read guidance template/);
  });
});

describe('summary failure', () => {
  it('throws on an empty summary rather than reporting success', async () => {
    const { streamSimple } = capturingProvider(fauxAssistantMessage(''));
    await expect(
      runSelfCompaction({
        preparation: preparation(),
        model: fauxModel(),
        streamSimple,
        loadDefault: () => DEFAULT_INSTRUCTION,
      }),
    ).rejects.toThrow(/empty/);
  });

  it('throws when the summary is only whitespace', async () => {
    const { streamSimple } = capturingProvider(fauxAssistantMessage('   \n  '));
    await expect(
      runSelfCompaction({
        preparation: preparation(),
        model: fauxModel(),
        streamSimple,
        loadDefault: () => DEFAULT_INSTRUCTION,
      }),
    ).rejects.toThrow(/empty/);
  });

  it('throws when the summarization is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { streamSimple } = capturingProvider(fauxAssistantMessage('late summary'));
    await expect(
      runSelfCompaction({
        preparation: preparation(),
        model: fauxModel(),
        streamSimple,
        signal: controller.signal,
        loadDefault: () => DEFAULT_INSTRUCTION,
      }),
    ).rejects.toThrow();
  });
});
