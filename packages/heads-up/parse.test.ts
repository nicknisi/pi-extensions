import { describe, expect, it } from 'vitest';
import { parse } from './parse.js';

const NOTE = `learn: The agent made one-off /ask questions cost about 25% more.
tag: Heads up
explain:
**One-off /ask questions now cost more**
- Saving the cache costs 1.25x.
- One-off questions never reuse it.`;

describe('parse', () => {
  it('reads a full note', () => {
    expect(parse(NOTE)).toEqual({
      learn: 'The agent made one-off /ask questions cost about 25% more.',
      tag: 'Heads up',
      title: 'One-off /ask questions now cost more',
      body: '- Saving the cache costs 1.25x.\n- One-off questions never reuse it.',
    });
  });

  it('none is no note', () => {
    expect(parse('learn: none')).toBe(null);
    expect(parse('learn: none.')).toBe(null);
  });

  it('tolerates bold labels and a bold tag', () => {
    const note = parse(NOTE.replace('tag: Heads up', '**tag**: **You should know**').replace('learn:', '- **learn**:'));
    expect(note?.tag).toBe('You should know');
  });

  it('tolerates smart quotes and a heading title', () => {
    const note = parse(
      NOTE.replace('tag: Heads up', 'tag: “Heads up”').replace(
        '**One-off /ask questions now cost more**',
        '## Cost went up',
      ),
    );
    expect(note?.tag).toBe('Heads up');
    expect(note?.title).toBe('Cost went up');
  });

  it('a missing explain block is no note', () => {
    expect(parse(NOTE.split('explain:')[0] ?? '')).toBe(null);
  });

  it('an unknown tag is no note', () => {
    expect(parse(NOTE.replace('Heads up', 'FYI'))).toBe(null);
  });

  it('a title with no body is no note', () => {
    expect(parse('learn: x.\ntag: Heads up\nexplain:\n**Title**')).toBe(null);
  });

  it('garbage is no note', () => {
    expect(parse('I think the user should know about caching.')).toBe(null);
  });
});
