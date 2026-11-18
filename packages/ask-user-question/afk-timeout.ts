/** How long an untouched questionnaire waits before the agent moves on. */
export const QUESTION_TIMEOUT_MS = 5 * 60 * 1000;

/** The timeout in whole minutes, for the texts that mention it. */
export const TIMEOUT_MINUTES = QUESTION_TIMEOUT_MS / 60_000;

/** What the model receives when the timer fires. Adapted from fitchmultz/pi-ask-question. */
export const TIMEOUT_MESSAGE = `The user is away: nobody touched these questions for ${TIMEOUT_MINUTES} minutes. A timeout does not answer a material scope, safety, or acceptance question and does not grant approval. Continue already-authorized work, use your best judgement for routine choices, and ask again later about anything that needs the user.`;

/**
 * Start the AFK timer for one questionnaire. The caller stops it on the first interaction with
 * the dialog, so once the user engages there is no time limit. The returned stop function is
 * safe to call more than once.
 */
export function startAfkTimer(onTimeout: () => void, ms = QUESTION_TIMEOUT_MS): () => void {
  const timer = setTimeout(onTimeout, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
}
