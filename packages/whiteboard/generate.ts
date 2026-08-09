/** LLM-powered Mermaid diagram generation from natural language. */

export interface GenerateOptions {
  /** The user's instruction (typed text or transcribed speech). */
  prompt: string;
  /** Current Mermaid diagram code, if a diagram already exists. */
  currentMermaid: string | null;
  /** OpenAI API key. */
  apiKey: string;
  /** Chat completion model. Defaults to `gpt-4o-mini`. */
  model?: string | undefined;
  /** API base URL. Defaults to `https://api.openai.com/v1`. */
  baseUrl?: string | undefined;
  /** Abort signal for cancelling in-flight requests. */
  signal?: AbortSignal | undefined;
}

const SYSTEM_PROMPT = `You are a diagram generator. Convert natural language descriptions into Mermaid diagrams.

Rules:
- Output ONLY valid Mermaid diagram code — no markdown fences, no explanations, no prose.
- If a current diagram exists, modify it according to the user's instruction. Preserve existing elements unless the user explicitly asks to change or remove them.
- Choose the most appropriate diagram type: flowchart for systems/architecture, sequenceDiagram for interactions, classDiagram for class structures, stateDiagram-v2 for state machines, erDiagram for data models, C4 diagrams for architecture.
- Keep labels concise and readable.
- Use proper Mermaid syntax — verify node IDs, arrows, and labels are valid.
- For flowcharts, use subgraphs to group related components.
- When the user says "no" or corrects something, modify the existing diagram rather than starting over.`;

/** Call an LLM to generate or update a Mermaid diagram from a natural-language prompt. */
export async function generateMermaid(opts: GenerateOptions): Promise<string> {
  const model = opts.model ?? 'gpt-4o-mini';
  const baseUrl = opts.baseUrl ?? 'https://api.openai.com/v1';

  const userContent = opts.currentMermaid
    ? `Current diagram:\n\`\`\`mermaid\n${opts.currentMermaid}\n\`\`\`\n\nInstruction: ${opts.prompt}`
    : `Create a diagram: ${opts.prompt}`;

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      temperature: 0.3,
    }),
    signal: opts.signal ?? null,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`LLM API error ${response.status}: ${text}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content ?? '';

  // Strip markdown fences if the model wraps the output
  const stripped = content
    .replace(/^```(?:mermaid)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();

  return stripped;
}
