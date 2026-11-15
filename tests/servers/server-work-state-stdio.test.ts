import { describe, expect, it } from 'bun:test';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

/**
 * In server runtime there is no local worker, so work_state_write,
 * work_state_read and session_start_context must answer from the server
 * (/v1/work-state, /v1/context). Drives the built plugin/scripts/mcp-server.cjs
 * over stdio against a fixture server that also answers the worker's routes,
 * so any request that still went to the worker is counted.
 */

function text(result: CallToolResult): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
}

describe('server-runtime work state over MCP stdio', () => {
  it('writes, reads and renders work state through the server, never the local worker', async () => {
    const app = express(); app.use(express.json());
    let workerCalls = 0;
    app.use('/api', (_req, res) => { workerCalls++; res.status(500).send('WRONG_LOCAL_WORKER'); });
    const stored: Array<{ id: number; projectId: string; list: string; fields: Record<string, unknown>; createdAtEpoch: number }> = [];
    const projectRefs: string[] = [];
    app.post('/v1/work-state/entries', (req, res) => {
      projectRefs.push(req.body.projectId);
      if (req.body.list === 'server-refuses') {
        res.status(400).json({ error: 'BadRequest', message: 'Not saved: SERVER_REFUSAL' });
        return;
      }
      const entry = { id: stored.length + 1, projectId: 'p-uuid', list: req.body.list, fields: req.body.fields, createdAtEpoch: Date.now() };
      stored.push(entry);
      res.status(201).json({ entry, entries: stored.filter(row => row.list === entry.list) });
    });
    app.post('/v1/work-state/read', (req, res) => {
      projectRefs.push(req.body.projectId);
      res.json({ entries: stored.filter(row => !req.body.list || row.list === req.body.list) });
    });
    app.post('/v1/context', (req, res) => {
      projectRefs.push(req.body.projectId);
      res.json({ observations: [{ id: 'obs-1', projectId: 'p-uuid', content: 'Recent server observation', metadata: { title: 'Recent server observation' } }], context: 'Recent server observation' });
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address() as { port: number };
    const dataDir = mkdtempSync(join(tmpdir(), 'server-work-state-stdio-'));
    const transport = new StdioClientTransport({
      command: 'node', args: [join(process.cwd(), 'plugin/scripts/mcp-server.cjs')], cwd: process.cwd(), stderr: 'pipe',
      env: {
        ...process.env,
        CLAUDE_MEM_DATA_DIR: dataDir,
        CLAUDE_MEM_RUNTIME: 'server',
        CLAUDE_MEM_SERVER_URL: `http://127.0.0.1:${address.port}`,
        CLAUDE_MEM_SERVER_API_KEY: 'fixture-key',
        CLAUDE_MEM_SERVER_PROJECT_ID: '',
        CLAUDE_MEM_WORKER_PORT: String(address.port),
        CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
        CLAUDE_MEM_WORKER_AUTOSTART: 'false',
      } as Record<string, string>,
    });
    const client = new Client({ name: 'server-work-state-fixture', version: '1' });
    transport.stderr?.on('data', () => {});
    try {
      await client.connect(transport);

      const write = await client.callTool({ name: 'work_state_write', arguments: { list: 'release', fields: { task: 'Tag the build', status: 'doing' } } }) as CallToolResult;
      expect(write.isError).toBeFalsy();
      expect(text(write)).toContain('Saved to "release"');
      expect(text(write)).toContain('Tag the build');
      // No configured project id: the checkout's name, as the hooks send it.
      expect(projectRefs[0]).toStartWith('name:');

      const read = await client.callTool({ name: 'work_state_read', arguments: {} }) as CallToolResult;
      expect(read.isError).toBeFalsy();
      expect(text(read)).toContain('Tag the build');

      await client.callTool({ name: 'work_state_write', arguments: { list: 'release', fields: { task: 'Tag the build', status: 'done' } } });
      const open = await client.callTool({ name: 'work_state_read', arguments: { list: 'release' } }) as CallToolResult;
      expect(text(open)).toContain('Nothing open in "release"');

      // Viewer-only lists are refused before any request.
      const before = projectRefs.length;
      const rules = await client.callTool({ name: 'work_state_write', arguments: { list: 'my-rules', fields: { task: 'x' } } }) as CallToolResult;
      expect(rules.isError).toBe(true);
      expect(text(rules)).toContain('My Rules');
      expect(projectRefs.length).toBe(before);

      // A server refusal reads as the server's own words.
      const refused = await client.callTool({ name: 'work_state_write', arguments: { list: 'server-refuses', fields: { a: 1 } } }) as CallToolResult;
      expect(refused.isError).toBe(true);
      expect(text(refused)).toContain('SERVER_REFUSAL');

      await client.callTool({ name: 'work_state_write', arguments: { list: 'next', fields: { task: 'Import history', status: 'todo' } } });
      const context = await client.callTool({ name: 'session_start_context', arguments: { project: 'demo-repo' } }) as CallToolResult;
      expect(context.isError).toBeFalsy();
      expect(text(context)).toContain('Work state, still open:');
      expect(text(context)).toContain('Import history');
      expect(text(context)).toContain('Recent server observation');
      // The named project, not the cwd's.
      expect(projectRefs.slice(-2)).toEqual(['name:demo-repo', 'name:demo-repo']);

      expect(workerCalls).toBe(0);
    } finally {
      await client.close(); await transport.close();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 20_000);
});
