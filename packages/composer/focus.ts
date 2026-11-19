import { execFile } from 'node:child_process';
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

/** Ask tmux whether this pane is focused, off the render path: a slow or hung tmux must not block the TUI. */
function detectPaneFocus(onResult: (focused: boolean) => void): void {
  const pane = process.env.TMUX_PANE;
  if (!pane) return;
  try {
    execFile(
      'tmux',
      ['list-clients', '-F', '#{client_flags}\t#{pane_id}'],
      // Its errors must not land on screen; on failure the pane stays "focused".
      { encoding: 'utf8', timeout: 1000 },
      (error, stdout) => {
        if (!error) onResult(paneHasFocusedClient(pane, stdout));
      },
    ).stdin?.end();
  } catch {
    /* tmux missing: stay focused */
  }
}

/** Bumped on every enable/disable so a stale tmux answer can't overwrite newer state. */
let generation = 0;

export function enableFocusTracking(tui: TUI): void {
  const gen = ++generation;
  paneFocused = true;
  detectPaneFocus((focused) => {
    if (gen !== generation) return;
    paneFocused = focused;
    tui.requestRender();
  });
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
    generation++; // a live focus event beats a pending tmux answer
    paneFocused = parsed.focused;
    tui.requestRender();
  };
  process.stdin.on('data', onInput);
  removeFocusListener = () => process.stdin.off('data', onInput);
}

export function disableFocusTracking(): void {
  generation++;
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
