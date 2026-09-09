/** Config: storage paths, server constants, and user-tunable theme settings. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

/** Directory for artifact files, relative to project root (mirrors plan-mode's .pi/plans). */
export const ARTIFACT_DIR = '.pi/artifacts';

/** Server bind host — localhost-only, never exposed externally. */
export const HOST = '127.0.0.1';

/** Mermaid CDN script URL (the only client-side JS; everything else renders at write time). */
export const MERMAID_CDN = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js';

// ─── User config (optional): ~/.pi/agent/configs/artifacts.json ───────────────

export interface ArtifactsConfig {
  /** "auto" follows the OS via prefers-color-scheme; "light"/"dark" pin one scheme. */
  theme: 'auto' | 'light' | 'dark';
  /** Accent color used on the dark scheme (links, badge, blockquote). */
  accent: string;
  /** Accent color used on the light scheme (darker for contrast on white). */
  accentLight: string;
  /** Content column width in px. */
  maxWidth: number;
}

const DEFAULTS: ArtifactsConfig = {
  theme: 'auto',
  accent: '#d67858',
  accentLight: '#b95730',
  maxWidth: 860,
};

const CONFIG_PATH = join(getAgentDir(), 'configs', 'artifacts.json');

function loadConfig(defaults = DEFAULTS): ArtifactsConfig {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as Partial<ArtifactsConfig>;
    return {
      theme: raw.theme === 'light' || raw.theme === 'dark' ? raw.theme : defaults.theme,
      accent: typeof raw.accent === 'string' ? raw.accent : defaults.accent,
      accentLight: typeof raw.accentLight === 'string' ? raw.accentLight : defaults.accentLight,
      maxWidth: typeof raw.maxWidth === 'number' && raw.maxWidth > 300 ? raw.maxWidth : defaults.maxWidth,
    };
  } catch {
    return defaults;
  }
}

export const CONFIG: ArtifactsConfig = loadConfig();
/** Markdown has its own defaults; explicit user accents still take precedence. */
export const READER_CONFIG: ArtifactsConfig = loadConfig({ ...DEFAULTS, accent: '#ffa293', accentLight: '#b74445' });
