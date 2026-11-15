import { describe, expect, it } from 'bun:test';
import express from 'express';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Knowledge corpora in server runtime: `worker-service corpus-server` reads the
 * observations from the server and keeps the corpus on this machine under
 * corpora/server/<project>, apart from local-worker corpora; it opens no
 * local store and starts no worker. prime and query are not run here: they
 * start the paid corpus agent.
 */
describe('server-runtime corpora', () => {
  it('builds, lists and guards a rebuild from the server, with no local store', async () => {
    let rows = Array.from({ length: 6 }, (_, index) => ({
      id: `obs-${index}`, projectId: 'p', kind: 'decision', content: `Decision ${index}`,
      metadata: { title: `Decision ${index}`, facts: ['f'], concepts: ['how-it-works'], project: 'repo' },
      createdAtEpoch: 1_760_000_000_000 + index,
    }));
    const selects: any[] = [];
    const workerCalls: string[] = [];
    const app = express(); app.use(express.json());
    app.use('/api', (req, res) => { workerCalls.push(req.originalUrl); res.status(500).end(); });
    app.post('/v1/observations/select', (req, res) => { selects.push(req.body); res.json({ observations: rows }); });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const { port } = server.address() as { port: number };
    const dataDir = mkdtempSync(join(tmpdir(), 'server-corpus-'));
    const env = {
      ...process.env,
      CLAUDE_MEM_DATA_DIR: dataDir,
      CLAUDE_MEM_RUNTIME: 'server',
      CLAUDE_MEM_SERVER_URL: `http://127.0.0.1:${port}`,
      CLAUDE_MEM_SERVER_API_KEY: 'k',
      CLAUDE_MEM_SERVER_PROJECT_ID: '',
      CLAUDE_MEM_WORKER_PORT: String(port),
    };
    // Each op runs asynchronously, so this process's fixture can answer the child.
    const run = async (op: string, args: Record<string, unknown>) => {
      return new Promise<any>((resolve, reject) => {
        const child = spawn('bun', [join(process.cwd(), 'plugin/scripts/worker-service.cjs'), 'corpus-server'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
        let out = '';
        child.stdout.on('data', chunk => { out += String(chunk); });
        child.on('error', reject);
        child.on('close', () => resolve(JSON.parse(out.trim().split('\n').pop()!)));
        child.stdin.end(JSON.stringify({ op, cwd: process.cwd(), args }));
      });
    };
    try {
      const built = await run('build', { name: 'decisions', types: ['decision'], dateStart: '2025-01-01' });
      expect(built.status).toBe(200);
      expect(built.body.stats.observation_count).toBe(6);
      expect(selects[0]).toMatchObject({ projectId: 'name:claude-mem', types: ['decision'], dateStart: '2025-01-01', limit: 500 });

      const listed = await run('list', {});
      expect(listed.body.corpora.map((c: any) => c.name)).toEqual(['decisions']);
      expect(readdirSync(join(dataDir, 'corpora', 'server', 'name_claude-mem'))).toContain('decisions.corpus.json');

      rows = rows.slice(0, 2);
      const shrunk = await run('rebuild', { name: 'decisions' });
      expect(shrunk.status).toBe(409);
      const forced = await run('rebuild', { name: 'decisions', force: true });
      expect(forced.body.stats.observation_count).toBe(2);

      expect((await run('prime', { name: 'missing' })).status).toBe(404);
      expect((await run('build', { name: '../escape' })).status).toBe(400);
      expect(workerCalls).toEqual([]);
      expect(existsSync(join(dataDir, 'claude-mem.db'))).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 60_000);
});
