import { describe, expect, it, vi } from 'vitest';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { SectionPicker, type PickerSection } from './section-picker.js';

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function sections(): PickerSection[] {
  return [
    {
      name: 'work',
      items: [
        { value: 'cloudflare-ai-gateway/gpt-5.6-sol', label: '  cloudflare-ai-gateway/gpt-5.6-sol' },
        { value: 'cloudflare-ai-gateway/claude-opus-5', label: '  cloudflare-ai-gateway/claude-opus-5' },
        {
          value: 'fireworks/accounts/fireworks/models/kimi-k3',
          label: '  fireworks/accounts/fireworks/models/kimi-k3',
        },
      ],
    },
    {
      name: 'personal',
      items: [
        {
          value: 'fireworks/accounts/fireworks/models/kimi-k3',
          label: '  fireworks/accounts/fireworks/models/kimi-k3',
        },
      ],
    },
  ];
}

function render(picker: SectionPicker): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escape codes
  return picker
    .render(240)
    .join('\n')
    .replace(/\x1b\[[0-9;]*m/g, '');
}

function type(picker: SectionPicker, text: string): void {
  for (const char of text) picker.handleInput(char);
}

describe('SectionPicker filtering', () => {
  it('matches a model name substring inside provider/modelId', () => {
    const picker = new SectionPicker(sections(), theme, vi.fn());

    type(picker, 'claude');
    const output = render(picker);

    expect(output).toContain('cloudflare-ai-gateway/claude-opus-5');
    expect(output).not.toContain('gpt-5.6-sol');
    expect(output).not.toContain('kimi-k3');
  });

  it('searches across all sections and dedupes models present in multiple sections', () => {
    const picker = new SectionPicker(sections(), theme, vi.fn());

    type(picker, 'kimi');
    const output = render(picker);

    const occurrences = output.split('kimi-k3').length - 1;
    expect(occurrences).toBe(1);
  });

  it('shows only the active section when the query is empty', () => {
    const picker = new SectionPicker(sections(), theme, vi.fn());

    type(picker, 'claude');
    type(picker, '\x7f'.repeat(7)); // backspace away the query
    const output = render(picker);

    expect(output).toContain('cloudflare-ai-gateway/claude-opus-5');
    expect(output).toContain('cloudflare-ai-gateway/gpt-5.6-sol');
  });

  it('confirms the highlighted filtered match on enter', () => {
    const done = vi.fn();
    const picker = new SectionPicker(sections(), theme, done);

    type(picker, 'kimi');
    picker.handleInput('\r');

    expect(done).toHaveBeenCalledWith('fireworks/accounts/fireworks/models/kimi-k3');
  });
});
