// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

// The server bundle now includes @anthropic-ai/claude-agent-sdk (the
// claude-subscription generation provider), whose ESM files call
// createRequire(import.meta.url) at load time. In a CJS bundle import.meta.url
// is undefined unless the build maps it, and the server dies on start with
// "The argument 'filename' must be a file URL ... Received undefined".

const buildScript = readFileSync(join(import.meta.dir, '../../scripts/build-hooks.js'), 'utf-8');

function buildBlock(entryConstant: string): string {
  const start = buildScript.indexOf(`entryPoints: [${entryConstant}.source]`);
  expect(start).toBeGreaterThan(-1);
  const end = buildScript.indexOf('assertBundleIntegrity', start);
  expect(end).toBeGreaterThan(start);
  return buildScript.slice(start, end);
}

describe('server bundle import.meta.url polyfill', () => {
  for (const entry of ['WORKER_SERVICE', 'SERVER_SERVICE']) {
    it(`${entry} maps import.meta.url and declares the replacement`, () => {
      const block = buildBlock(entry);
      expect(block).toContain(`'import.meta.url': '__IMPORT_META_URL__'`);
      expect(block).toContain('var __IMPORT_META_URL__ = require("node:url").pathToFileURL(__CM_FILENAME__).href;');
    });
  }
});
