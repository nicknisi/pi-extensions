import { execFileSync } from 'node:child_process';
import { isViewportTUI, type TUI } from '@earendil-works/pi-tui';
import { paneHasFocusedClient, parseFocusInput } from './utils.js';

// Terminal focus tracking — delineates the focused tmux pane. Fullscreen pi
// owns DECSET 1004; other TUI modes need composer to enable it so tmux (with
// `focus-events on`) sends CSI I / CSI O. Observe raw stdin because fullscreen
// pi consumes those events before extension input listeners run. When composer
// enables 1004 itself, clean it up so the shell does not inherit `[I`/`[O`.

export let paneFocused = true;
let focusCarry = '';
let removeFocusListener: (() => void) | undefined;
let ownsFocusReporting = false;
let exitHookInstalled = false;

function detectPaneFocus(): boolean {
  if (!process.env.TMUX_PANE) return true;
  try {
    return paneHasFocusedClient(
      process.env.TMUX_PANE,
      execFileSync('tmux', ['list-clients', '-F', '#{client_flags}\t#{pane_id}'], { encoding: 'utf8' }),
    );
  } catch {
    return true;
  }
}

export function enableFocusTracking(tui: TUI): void {
  paneFocused = detectPaneFocus();
  ownsFocusReporting = !isViewportTUI(tui);
  process.stdout.write('\x1b[?1004h');
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', () => {
      if (!ownsFocusReporting) return;
      try {
        process.stdout.write('\x1b[?1004l');
      } catch {
        /* stdout gone */
      }
    });
  }
  removeFocusListener?.();
  const onInput = (data: string | Buffer) => {
    const parsed = parseFocusInput(focusCarry, String(data));
    focusCarry = parsed.carry;
    if (parsed.focused === undefined) return;
    paneFocused = parsed.focused;
    tui.requestRender();
  };
  process.stdin.on('data', onInput);
  removeFocusListener = () => process.stdin.off('data', onInput);
}

export function disableFocusTracking(): void {
  if (ownsFocusReporting) {
    try {
      process.stdout.write('\x1b[?1004l');
    } catch {
      /* stdout gone */
    }
  }
  removeFocusListener?.();
  removeFocusListener = undefined;
  ownsFocusReporting = false;
  focusCarry = '';
  paneFocused = true;
}
