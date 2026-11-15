import { describe, expect, it } from 'bun:test';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { join } from 'node:path';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { MCP_TOOL_NAMES, MCP_TOOL_SERVER_SUPPORT, type McpToolName } from '../../src/shared/server-runtime-support.js';

/**
 * Server runtime parity, end to end through the built plugin/scripts/mcp-server.cjs:
 * every tool it advertises is named in the support table, and calling every one
 * of them reaches the server or answers that it is unavailable, never a local
 * worker (the fixture also answers the worker's /api routes and counts them),
 * and leaves no local store or spool behind.
 */

const ARGS: Partial<Record<McpToolName, Record<string, unknown>>> = {
  dumb_search: { query: 'deploy' },
  save_memory: { text: 'Parity note' },
  search: { query: 'deploy' },
  timeline: { anchor: 'obs-1' },
  get_observations: { ids: ['obs-1'] },
  get_tool_uses: { ids: ['obs-1'] },
  work_state_write: { list: 'parity', fields: { task: 'check', status: 'todo' } },
  work_state_read: {},
  team_brief: {},
  team_search: { query: 'deploy' },
  session_start_context: { project: 'repo' },
  observation_add: { content: 'Parity note' },
  observation_record_event: { eventType: 'note', payload: { a: 1 } },
  observation_search: { query: 'deploy' },
  observation_context: {},
  observation_generation_status: { jobId: 'job-1' },
  build_corpus: { name: 'c' },
  list_corpora: {},
  prime_corpus: { name: 'c' },
  query_corpus: { name: 'c', question: 'q' },
  rebuild_corpus: { name: 'c' },
  reprime_corpus: { name: 'c' },
};

// Source tools read files on this machine; given a path that does not exist they
// answer with an error of their own, which is not a memory backend call.
const LOCAL_SOURCE_TOOLS = new Set<McpToolName>(['smart_search', 'smart_unfold', 'smart_outline']);

describe('server runtime parity over MCP stdio', () => {
  it('advertises only tools in the support table and never reaches a local worker', async () => {
    const observation = { id: 'obs-1', projectId: 'p', content: 'Deploy notes', kind: 'discovery', metadata: { title: 'Deploy notes', project: 'repo' }, createdAtEpoch: Date.now() };
    const app = express(); app.use(express.json());
    const workerCalls: string[] = [];
    app.use('/api', (req, res) => { workerCalls.push(req.originalUrl); res.status(500).send('WRONG_LOCAL_WORKER'); });
    app.post('/v1/search', (_req, res) => res.json({ observations: [observation] }));
    app.post('/v1/timeline', (_req, res) => res.json({ observations: [observation] }));
    app.post('/v1/observations/batch', (_req, res) => res.json({ observations: [observation] }));
    app.post('/v1/context', (_req, res) => res.json({ observations: [observation], context: 'Deploy notes' }));
    app.post('/v1/memories', (_req, res) => res.status(201).json({ memory: observation }));
    app.post('/v1/events', (_req, res) => res.status(201).json({ event: { id: 'e-1' } }));
    app.get('/v1/jobs/:id', (_req, res) => res.json({ generationJob: { id: 'job-1', status: 'completed' } }));
    app.post('/v1/work-state/entries', (req, res) => res.status(201).json({
      entry: { id: 1, projectId: 'p', list: req.body.list, fields: req.body.fields, createdAtEpoch: Date.now() },
      entries: [{ id: 1, projectId: 'p', list: req.body.list, fields: req.body.fields, createdAtEpoch: Date.now() }],
    }));
    app.post('/v1/work-state/read', (_req, res) => res.json({ entries: [] }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const { port } = server.address() as { port: number };
    const dataDir = mkdtempSync(join(tmpdir(), 'server-runtime-parity-'));
    const transport = new StdioClientTransport({
      command: 'node', args: [join(process.cwd(), 'plugin/scripts/mcp-server.cjs')], cwd: process.cwd(), stderr: 'pipe',
      env: {
        ...process.env,
        CLAUDE_MEM_DATA_DIR: dataDir,
        CLAUDE_MEM_RUNTIME: 'server',
        CLAUDE_MEM_SERVER_URL: `http://127.0.0.1:${port}`,
        CLAUDE_MEM_SERVER_API_KEY: 'parity-key',
        CLAUDE_MEM_SERVER_PROJECT_ID: '',
        CLAUDE_MEM_WORKER_PORT: String(port),
        CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
        CLAUDE_MEM_TELEMETRY_ENABLED: 'false',
      } as Record<string, string>,
    });
    const client = new Client({ name: 'server-runtime-parity', version: '1' });
    transport.stderr?.on('data', () => {});
    try {
      await client.connect(transport);
      const advertised = (await client.listTools()).tools.map(tool => tool.name);
      const known = new Set<string>(MCP_TOOL_NAMES);
      expect(advertised.filter(name => !known.has(name))).toEqual([]);

      const failures: string[] = [];
      for (const name of advertised as McpToolName[]) {
        if (LOCAL_SOURCE_TOOLS.has(name)) continue;
        const result = await client.callTool({ name, arguments: ARGS[name] ?? {} }) as CallToolResult;
        const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
        const support = MCP_TOOL_SERVER_SUPPORT[name];
        if (support.kind === 'native' && result.isError) failures.push(`${name} (native) failed: ${text.slice(0, 200)}`);
        if (support.kind !== 'native' && !result.isError) failures.push(`${name} (${support.kind}) answered as if available`);
      }
      expect(failures).toEqual([]);
      expect(workerCalls).toEqual([]);
      expect(existsSync(join(dataDir, 'claude-mem.db'))).toBe(false);
      const spoolDir = join(dataDir, 'state', 'hook-spool');
      expect(existsSync(spoolDir) ? readdirSync(spoolDir) : []).toEqual([]);
    } finally {
      await client.close(); await transport.close();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 60_000);
});
