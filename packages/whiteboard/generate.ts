/** Utilities for Mermaid generation: system prompt, context building, heuristics. */

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

export const MERMAID_SYSTEM_PROMPT = `You are a diagram generator. Convert natural language descriptions into Mermaid diagrams.

Rules:
- Output ONLY valid Mermaid diagram code — no markdown fences, no explanations, no prose.
- If a current diagram exists, modify it according to the user's instruction. Preserve existing elements unless the user explicitly asks to change or remove them.
- Choose the most appropriate diagram type: flowchart for systems/architecture, sequenceDiagram for interactions, classDiagram for class structures, stateDiagram-v2 for state machines, erDiagram for data models, C4 diagrams for architecture.
- Keep labels concise and readable.
- Use proper Mermaid syntax — verify node IDs, arrows, and labels are valid.
- For flowcharts, use subgraphs to group related components.
- When the user says "no" or corrects something, modify the existing diagram rather than starting over.
- Use the conversation context to understand what the user is working on. If they reference "the auth service" or "the gateway", those refer to things discussed in the session.`;

/** Strip markdown fences if the model wraps Mermaid output. */
export function stripMermaidFences(text: string): string {
  return text
    .replace(/^```(?:mermaid)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();
}

/** Extract text content from a session entry's message. */
function entryText(message: { role?: string; content?: unknown }): string | null {
  if (!message?.content) return null;
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    const texts = message.content
      .filter((p: { type?: string; text?: string }) => p?.type === 'text' && typeof p.text === 'string')
      .map((p: { text?: string }) => p.text as string);
    return texts.length > 0 ? texts.join('\n') : null;
  }
  return null;
}

/** Build the messages array for a Mermaid generation call, including recent session context. */
export function buildGenerationMessages(
  sessionManager: ExtensionContext['sessionManager'],
  currentMermaid: string | null,
  prompt: string,
): Array<{ role: 'user'; content: string; timestamp: number }> {
  // Extract recent user messages from the session for context
  const entries = sessionManager.getBranch();
  const recentUserTexts: string[] = [];
  for (const entry of entries) {
    if (entry.type !== 'message') continue;
    const message = (entry as { message?: { role?: string; content?: unknown } }).message;
    if (!message || message.role !== 'user') continue;
    const text = entryText(message);
    if (text && !text.startsWith('/whiteboard')) {
      recentUserTexts.push(text);
    }
  }
  // Keep last 5 user messages for context (avoid token bloat)
  const contextMessages = recentUserTexts.slice(-5).map((text) => ({
    role: 'user' as const,
    content: text,
    timestamp: Date.now(),
  }));

  // The actual generation instruction
  const instruction = currentMermaid
    ? `Current diagram:\n\`\`\`mermaid\n${currentMermaid}\n\`\`\`\n\nInstruction: ${prompt}`
    : `Create a diagram: ${prompt}`;

  return [...contextMessages, { role: 'user' as const, content: instruction, timestamp: Date.now() }];
}

/** Heuristic: should this transcript be routed to the agent instead of direct generation? */
export function shouldRouteToAgent(transcript: string): boolean {
  const lower = transcript.toLowerCase();
  const triggers = [
    /\bshould (we|i)\b/,
    /\bwhat if\b/,
    /\bcan (we|you)\b/,
    /\bbased on\b/,
    /\bfrom the (codebase|code|repo|project)\b/,
    /\bbuild (it|this)\b/,
    /\bscaffold\b/,
    /\bgenerate (the )?code\b/,
    /\bcreate (the )?files\b/,
    /\bimplement\b/,
    /\bwhat do you think\b/,
    /\bhow (do|should) (we|i)\b/,
  ];
  return triggers.some((re) => re.test(lower));
}
