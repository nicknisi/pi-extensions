/**
 * Auto Theme Extension
 *
 * Syncs pi theme with the OS dark/light mode, switching between paired
 * dark/light themes.
 *
 * Mode detection per platform:
 *   macOS:   polls appearance via osascript every 3 seconds
 *   Linux:   polls `mode` in Omarchy's colors.toml (~/.local/state/
 *            omarchy/current/theme/colors.toml), which omarchy theme
 *            set refreshes. Inert without Omarchy — an unreadable mode
 *            never resolves to "light" and stomp paired themes.
 *   other:   inert
 *
 * Theme pairs:
 *   nightowl        ↔ lightowl
 *   tokyonight-night ↔ tokyonight-day
 *   catppuccin-mocha ↔ catppuccin-latte
 *   dark             ↔ light
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Map every known theme to its opposite-mode counterpart. */
const PAIRS: Record<string, string> = {
  nightowl: 'lightowl',
  lightowl: 'nightowl',
  'tokyonight-night': 'tokyonight-day',
  'tokyonight-day': 'tokyonight-night',
  'catppuccin-mocha': 'catppuccin-latte',
  'catppuccin-latte': 'catppuccin-mocha',
  dark: 'light',
  light: 'dark',
};

const DARK_THEMES = new Set(['nightowl', 'tokyonight-night', 'catppuccin-mocha', 'dark']);

/** true = dark mode, false = light mode, null = unknown (never sync on null). */
async function macosDarkMode(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'osascript',
      ['-e', 'tell application "System Events" to tell appearance preferences to return dark mode'],
      { encoding: 'utf-8', timeout: 2000 },
      (err, stdout) => resolve(!err && stdout.trim() === 'true'),
    );
  });
}

async function linuxDarkMode(): Promise<boolean | null> {
  try {
    const toml = await readFile(join(homedir(), '.local/state/omarchy/current/theme/colors.toml'), 'utf-8');
    const mode = toml.match(/^mode\s*=\s*"([^"]+)"/m)?.[1];
    if (mode === 'dark') return true;
    if (mode === 'light') return false;
    return null;
  } catch {
    return null; // no Omarchy state — don't guess
  }
}

const isDarkMode = process.platform === 'darwin' ? macosDarkMode : process.platform === 'linux' ? linuxDarkMode : null;

export { linuxDarkMode };

export default function (pi: ExtensionAPI) {
  if (!isDarkMode) return;

  let intervalId: ReturnType<typeof setInterval> | null = null;
  let lastDark: boolean | null = null;

  const sync = (dark: boolean, ctx: ExtensionContext) => {
    const current = ctx.ui.theme.name;
    if (current && PAIRS[current] && DARK_THEMES.has(current) !== dark) {
      ctx.ui.setTheme(PAIRS[current]);
    }
  };

  pi.on('session_start', async (_event, ctx) => {
    const dark = await isDarkMode();
    lastDark = dark;
    if (dark === null) return; // can't detect mode — don't sync or poll

    // Sync on startup if current theme doesn't match OS mode
    sync(dark, ctx);

    // Poll for OS appearance changes
    intervalId = setInterval(async () => {
      const dark = await isDarkMode();
      if (dark === null || dark === lastDark) return;
      lastDark = dark;
      sync(dark, ctx);
    }, 3000);
  });

  pi.on('session_shutdown', async () => {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  });
}
