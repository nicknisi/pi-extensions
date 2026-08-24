#!/usr/bin/env node
/**
 * CLI for Claude Design auth outside pi. Core logic lives in ../auth.ts
 * (compiled to ../dist/auth.js). Commands: login | token | status | logout | selfcheck
 *
 * `token` prints "Bearer <access-token>", refreshing only when expired —
 * wire it into pi-mcp-adapter as a `!command` Authorization header.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import {
  STORE_PATH,
  completeLogin,
  freshAccessToken,
  logout,
  parsePastedCode,
  startLogin,
  statusText,
} from '../dist/auth.js';

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    }),
  );
}

const commands = {
  login: async () => {
    const start = startLogin();
    console.log(`Open to authorize Claude Design access:\n\n${start.url}\n`);
    if (process.platform === 'darwin') {
      spawn('open', [start.url], { detached: true, stdio: 'ignore' }).unref();
    }
    await completeLogin(start, await ask('Paste the CODE#STATE value shown after approval > '));
    console.log(`\nAuthorized. Credentials saved to ${STORE_PATH}`);
  },
  token: async () => {
    process.stdout.write(`Bearer ${await freshAccessToken()}`);
  },
  status: async () => {
    console.log(await statusText());
  },
  logout: async () => {
    await logout();
    console.log(`Removed ${STORE_PATH}`);
  },
  selfcheck: async () => {
    const { deepStrictEqual, strictEqual, match } = await import('node:assert/strict');
    deepStrictEqual(parsePastedCode(" 'abc#xyz' "), { code: 'abc', state: 'xyz' });
    strictEqual(parsePastedCode('abc'), null);
    strictEqual(parsePastedCode('abc#xyz#extra'), null);
    strictEqual(parsePastedCode('#xyz'), null);
    const start = startLogin();
    match(start.url, /^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
    match(start.url, /code_challenge_method=S256/);
    strictEqual(new URL(start.url).searchParams.get('state'), start.state);
    console.log('ok');
  },
};

const run = commands[process.argv[2] || 'token'];
if (!run) {
  console.error('Usage: claude-design-auth <login|token|status|logout>');
  process.exit(2);
}
run().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
