export type Tag = 'You should know' | 'Heads up';

export type Note = { learn: string; tag: Tag; title: string; body: string };

const QUOTES = /[“”‘’]/g;
const LABEL = /^[\s>*_"'-]*(learn|tag|explain)[\s*_"']*:\s*\**\s*/i;

const label = (line: string): { key: string; rest: string } | null => {
  const plain = line.replace(QUOTES, '"');
  const match = plain.match(LABEL);
  return match ? { key: (match[1] ?? '').toLowerCase(), rest: plain.slice(match[0].length).trim() } : null;
};

const toTag = (raw: string): Tag | null => {
  const plain = raw
    .replace(/[*_"'.\s-]+/g, ' ')
    .trim()
    .toLowerCase();
  if (plain === 'heads up') return 'Heads up';
  if (plain === 'you should know') return 'You should know';
  return null;
};

const toTitle = (line: string): string | null => {
  const match = line.trim().match(/^(?:\*\*([^*]+)\*\*|#+\s*(.+))$/);
  return match ? (match[1] ?? match[2] ?? '').trim() || null : null;
};

/**
 * Reads the side agent's reply. Null for `learn: none` and for anything
 * malformed: a half note is never shown.
 */
export const parse = (text: string): Note | null => {
  const lines = text.split('\n');
  let learn = '';
  let tag: Tag | null = null;
  let explainAt = -1;

  for (const [i, line] of lines.entries()) {
    const found = label(line);
    if (!found) continue;
    if (found.key === 'learn') learn = found.rest;
    if (found.key === 'tag') tag = toTag(found.rest);
    if (found.key === 'explain') {
      explainAt = i;
      break;
    }
  }

  if (!learn || /^none\b/i.test(learn) || !tag || explainAt < 0) return null;

  const rest = lines.slice(explainAt + 1);
  const titleAt = rest.findIndex((line) => line.trim());
  const title = toTitle(rest[titleAt] ?? '');
  if (!title) return null;

  const body = rest
    .slice(titleAt + 1)
    .join('\n')
    .trim();
  if (!body) return null;

  return { learn, tag, title, body };
};
