/**
 * Retired. @nicknisi/pi-composer 1.0 shows the working verbs and shimmer (working.messages).
 *
 * This stub does nothing except say so once per session, so an install that
 * still lists it keeps loading cleanly. Remove it from your pi packages.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function (pi: ExtensionAPI) {
  pi.on('session_start', async (_event, ctx) => {
    if (ctx.hasUI)
      ctx.ui.notify(
        `@nicknisi/pi-spinner is retired: @nicknisi/pi-composer 1.0 shows the working verbs and shimmer (working.messages). Remove it from your pi packages.`,
        'warning',
      );
  });
}
