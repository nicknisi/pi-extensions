// Re-export the nested extension factory as the package's compiled entry point.
//
// The repository build (`scripts/build.ts`) compiles each package with a flat
// `./*.ts` include, so nested sources under `extensions/` are only pulled into
// the emitted output through the imports reachable from this file. Keep this
// re-export in place: it is what makes `dist/index.js` (the published
// `exports["."].default`) resolve the nested factory and its helpers.
export { default } from './extensions/self-compact/self-compact.js';
export type { HandoffPhase, HandoffState } from './extensions/self-compact/self-compact.js';
