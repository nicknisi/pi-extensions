/**
 * Retired. @nicknisi/pi-composer 1.0 renders the footer, and fleet's pi hook writes the tmux status files.
 *
 * This stub does nothing except say so once per session, so an install that
 * still lists it keeps loading cleanly. Remove it from your pi packages.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function (pi: ExtensionAPI) {
  pi.on('session_start', async (_event, ctx) => {
    if (ctx.hasUI)
      ctx.ui.notify(
        `@nicknisi/pi-statusline is retired: @nicknisi/pi-composer 1.0 renders the footer, and fleet's pi hook writes the tmux status files. Remove it from your pi packages.`,
        'warning',
      );
  });
}
