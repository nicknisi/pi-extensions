/**
 * Real-CLI survival harness extension. Test-only; never a production runtime.
 *
 * Loaded via `pi -e` alongside the self-compact extension in an actual `pi -p`
 * / `pi --mode json` subprocess. It registers the same deterministic
 * `fauxProvider` the in-process fixture uses, reading its scripted response
 * steps from the JSON file named by `SELF_COMPACT_FAUX_RESPONSES`. Only the
 * provider's responses are scripted; the self-compact extension's real
 * compaction/continuation lifecycle runs untouched, so the subprocess exercises
 * genuine CLI process completion and shutdown timing.
 */
import { fauxProvider, type FauxResponseStep } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { readFileSync } from 'node:fs';

export default function (pi: ExtensionAPI): void {
  const responsesPath = process.env.SELF_COMPACT_FAUX_RESPONSES;
  const responses: FauxResponseStep[] = responsesPath
    ? (JSON.parse(readFileSync(responsesPath, 'utf8')) as FauxResponseStep[])
    : [];
  const contextWindow = process.env.SELF_COMPACT_FAUX_CONTEXT_WINDOW
    ? Number(process.env.SELF_COMPACT_FAUX_CONTEXT_WINDOW)
    : 200000;

  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'faux-1', contextWindow }] });
  faux.setResponses(responses);
  pi.registerProvider(faux.provider);
}
