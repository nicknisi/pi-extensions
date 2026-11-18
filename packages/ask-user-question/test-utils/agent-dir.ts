import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';
import { configFilePath } from '../config.js';

/**
 * Point PI_CODING_AGENT_DIR at a fresh temp dir for every test in the calling file, so config
 * reads and writes never touch the real ~/.pi/agent. Replaces upstream's global HOME swap.
 */
export function useTempAgentDir(): { writeConfig: (data: object) => void; configPath: () => string } {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ask-user-question-'));
    vi.stubEnv('PI_CODING_AGENT_DIR', dir);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    configPath: () => configFilePath(),
    writeConfig: (data) => {
      mkdirSync(dirname(configFilePath()), { recursive: true });
      writeFileSync(configFilePath(), JSON.stringify(data, null, 2), 'utf-8');
    },
  };
}
