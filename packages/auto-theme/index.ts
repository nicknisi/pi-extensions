/**
 * Auto Theme Extension
 *
 * Syncs pi theme with macOS dark/light mode. Polls system appearance
 * every 3 seconds and switches between paired dark/light themes.
 *
 * Theme pairs:
 *   nightowl        ↔ lightowl
 *   tokyonight-night ↔ tokyonight-day
 *   catppuccin-mocha ↔ catppuccin-latte
 *   dark             ↔ light
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { execFile } from 'node:child_process';

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

function isDarkMode(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'osascript',
      ['-e', 'tell application "System Events" to tell appearance preferences to return dark mode'],
      { encoding: 'utf-8', timeout: 2000 },
      (err, stdout) => resolve(!err && stdout.trim() === 'true'),
    );
  });
}

export default function (pi: ExtensionAPI) {
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let lastDark: boolean | null = null;

  pi.on('session_start', async (_event, ctx) => {
    const dark = await isDarkMode();
    lastDark = dark;

    // Sync on startup if current theme doesn't match OS mode
    const current = ctx.ui.theme.name;
    if (current && PAIRS[current]) {
      const currentIsDark = DARK_THEMES.has(current);
      if (currentIsDark !== dark) {
        ctx.ui.setTheme(PAIRS[current]);
      }
    }

    // Poll for OS appearance changes
    intervalId = setInterval(async () => {
      const dark = await isDarkMode();
      if (dark === lastDark) return;
      lastDark = dark;

      const current = ctx.ui.theme.name;
      if (current && PAIRS[current]) {
        ctx.ui.setTheme(PAIRS[current]);
      }
    }, 3000);
  });

  pi.on('session_shutdown', async () => {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  });
}
