import { afterEach, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptEventProcessor } from '../../src/services/transcripts/processor.js';
import { settleHookSpoolNudges } from '../../src/cli/spool-hook-event.js';
import { HookSpool } from '../../src/shared/hook-spool.js';
import * as workerUtils from '../../src/shared/worker-utils.js';
import * as runtimeSelector from '../../src/services/hooks/runtime-selector.js';

// In server runtime a standalone transcript watch (Codex and other watched
// hosts) hands its events to the server, as the hooks do, and never to a
// local worker: not the observation, not the summary, not a worker start.
const schema = { name: 'srv', sessionIdPath: 'session', events: [
  { name: 'use', match: { path: 'type', equals: 'use' }, action: 'tool_use', fields: { toolId: 'id', toolName: 'name', toolInput: 'input' } },
  { name: 'result', match: { path: 'type', equals: 'result' }, action: 'tool_result', fields: { toolId: 'id', toolResponse: 'output' } },
  { name: 'say', match: { path: 'type', equals: 'say' }, action: 'assistant_message', fields: { message: 'text' } },
  { name: 'end', match: { path: 'type', equals: 'end' }, action: 'session_end' },
] } as any;

const original = process.env.CLAUDE_MEM_DATA_DIR;
const spies: Array<{ mockRestore(): void }> = [];
afterEach(async () => {
  await settleHookSpoolNudges();
  spies.splice(0).forEach(spy => spy.mockRestore());
  if (original === undefined) delete process.env.CLAUDE_MEM_DATA_DIR; else process.env.CLAUDE_MEM_DATA_DIR = original;
});

it('sends watched tool events and the session summary to the server, never to the worker', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-watch-server-'));
  process.env.CLAUDE_MEM_DATA_DIR = root;
  const serverCalls: string[] = [];
  const runtime = {
    runtime: 'server' as const,
    projectId: 'name:repo',
    serverBaseUrl: 'https://memory.example',
    client: {
      recordEvent: async (event: any) => { serverCalls.push(`event:${event.eventType}`); return { event: { id: 'e' } }; },
      startSession: async () => { serverCalls.push('start'); return { session: { id: 'srv-1' } }; },
      endSession: async () => { serverCalls.push('end'); return {}; },
    },
  };
  spies.push(spyOn(runtimeSelector, 'selectRuntime').mockReturnValue('server'));
  spies.push(spyOn(runtimeSelector, 'resolveRuntimeContext').mockReturnValue(runtime as never));
  const workerRequests: string[] = [];
  spies.push(spyOn(workerUtils, 'workerHttpRequest').mockImplementation(async (path: string) => { workerRequests.push(path); throw new Error('no worker'); }));
  const ensure = spyOn(workerUtils, 'ensureWorkerRunning').mockResolvedValue(true as never);
  spies.push(ensure);
  const watch = { name: 'srv', path: '/unused', workspace: root, schema, context: { mode: 'agents', path: join(root, 'AGENTS.md') } };
  const processor = new TranscriptEventProcessor('spool');
  try {
    await processor.processEntry({ session: 's', type: 'use', id: 't', name: 'Bash', input: { command: 'ls' } }, watch as any, schema);
    await processor.processEntry({ session: 's', type: 'result', id: 't', output: 'a.ts' }, watch as any, schema);
    await processor.processEntry({ session: 's', type: 'say', text: 'Listed the files.' }, watch as any, schema);
    await processor.processEntry({ session: 's', type: 'end' }, watch as any, schema);
    await settleHookSpoolNudges();
    expect(serverCalls).toContain('event:tool_use');
    expect(serverCalls).toContain('end');
    expect(workerRequests).toEqual([]);
    expect(ensure).not.toHaveBeenCalled();
    const spooled: unknown[] = [];
    await new HookSpool().drain(entry => { spooled.push(entry); return true; });
    expect(spooled).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
