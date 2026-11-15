import { describe, expect, it } from 'bun:test';
import { isLocalWorkerLaunchDisabled, isServerRuntimeConfigured } from '../../src/shared/worker-autostart.js';

// In a configured server runtime no hook or MCP call may start a local worker:
// a slow server reply used to lazy-spawn one, which then ran scheduled agents
// on the user's plan and captured into a database no session reads.
describe('isLocalWorkerLaunchDisabled', () => {
  const server = { CLAUDE_MEM_RUNTIME: 'server', CLAUDE_MEM_SERVER_URL: 'https://memory.example', CLAUDE_MEM_SERVER_API_KEY: 'cmem_x' };

  it('blocks launching in a configured server runtime, legacy names included', () => {
    expect(isLocalWorkerLaunchDisabled(server)).toBe(true);
    expect(isLocalWorkerLaunchDisabled({ CLAUDE_MEM_RUNTIME: ' Server-Beta ', CLAUDE_MEM_SERVER_BETA_URL: 'https://m', CLAUDE_MEM_SERVER_BETA_API_KEY: 'k' })).toBe(true);
  });

  it('allows launching when server settings are incomplete, as those resolve to the worker runtime', () => {
    expect(isServerRuntimeConfigured({ ...server, CLAUDE_MEM_SERVER_API_KEY: '' })).toBe(false);
    expect(isLocalWorkerLaunchDisabled({ ...server, CLAUDE_MEM_SERVER_URL: ' ' })).toBe(false);
  });

  it('keeps the worker runtime and the external-manager setting as they were', () => {
    expect(isLocalWorkerLaunchDisabled({ CLAUDE_MEM_RUNTIME: 'worker' })).toBe(false);
    expect(isLocalWorkerLaunchDisabled({})).toBe(false);
    expect(isLocalWorkerLaunchDisabled({ CLAUDE_MEM_WORKER_AUTOSTART: 'false' })).toBe(true);
  });
});
