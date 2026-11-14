// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  ClaudeSubscriptionObservationProvider,
  buildSubscriptionChildEnv,
  classifySubscriptionFailure,
  DEFAULT_SERVER_SUBSCRIPTION_MODEL,
} from '../../../src/server/generation/providers/ClaudeSubscriptionObservationProvider.js';
import {
  ServerClassifiedProviderError,
  serverPaidSendOutcomeOf,
} from '../../../src/server/generation/providers/shared/error-classification.js';
import type { ServerGenerationContext } from '../../../src/server/generation/providers/shared/types.js';
import { instantiateServerGenerationProvider } from '../../../src/server/runtime/create-server-service.js';

function makeContext(payload: unknown = { tool: 'bash', input: 'ls' }): ServerGenerationContext {
  return {
    job: {
      id: 'job-1', projectId: 'proj-1', teamId: 'team-1', agentEventId: 'evt-1',
      sourceType: 'agent_event', sourceId: 'evt-1', serverSessionId: null,
      jobType: 'observation_generate_for_event', status: 'processing', idempotencyKey: 'k',
      bullmqJobId: null, attempts: 1, maxAttempts: 3, nextAttemptAtEpoch: null,
      lockedAtEpoch: null, lockedBy: null, completedAtEpoch: null, failedAtEpoch: null,
      cancelledAtEpoch: null, lastError: null, payload: {}, createdAtEpoch: 0, updatedAtEpoch: 0,
    },
    events: [{
      id: 'evt-1', projectId: 'proj-1', teamId: 'team-1', serverSessionId: null,
      sourceAdapter: 'api', sourceEventId: null, idempotencyKey: 'k', eventType: 'tool_use',
      payload, metadata: {}, occurredAtEpoch: 0, receivedAtEpoch: 0, createdAtEpoch: 0,
    }],
    project: { projectId: 'proj-1', teamId: 'team-1', serverSessionId: null, projectName: 'demo' },
  };
}

interface QueryCall { prompt: unknown; options: Record<string, any> }

/** A fake Agent SDK `query` that records its call and replays scripted messages. */
function fakeQuery(messages: unknown[], opts: { throwAfter?: unknown } = {}) {
  const calls: QueryCall[] = [];
  const impl = ((args: QueryCall) => {
    calls.push(args);
    return (async function* () {
      for (const message of messages) yield message;
      if (opts.throwAfter !== undefined) throw opts.throwAfter;
    })();
  }) as any;
  return { impl, calls };
}

const assistant = (text: string, extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  message: { model: 'claude-haiku-5-5', content: [{ type: 'text', text }] },
  ...extra,
});
const success = (usage = { input_tokens: 100, output_tokens: 20 }) => ({
  type: 'result', subtype: 'success', is_error: false, result: '', usage,
});

let cwd: string;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'cm-sub-provider-')); });
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

function provider(impl: unknown, baseEnv: NodeJS.ProcessEnv = { PATH: '/usr/bin', HOME: '/home/node' }) {
  return new ClaudeSubscriptionObservationProvider({
    oauthToken: 'sk-ant-oat-test',
    claudePath: '/usr/local/bin/claude',
    cwd,
    baseEnv,
    queryImpl: impl as any,
  });
}

async function generationError(p: ClaudeSubscriptionObservationProvider): Promise<ServerClassifiedProviderError> {
  try {
    await p.generate(makeContext());
  } catch (error) {
    expect(error).toBeInstanceOf(ServerClassifiedProviderError);
    return error as ServerClassifiedProviderError;
  }
  throw new Error('expected generate() to throw');
}

describe('ClaudeSubscriptionObservationProvider', () => {
  it('returns the observer reply with the served model and token usage', async () => {
    const { impl } = fakeQuery([assistant('<observation><type>x</type></observation>'), success()]);
    const result = await provider(impl).generate(makeContext());
    expect(result.rawText).toBe('<observation><type>x</type></observation>');
    expect(result.modelId).toBe('claude-haiku-5-5');
    expect(result.tokensUsed).toBe(120);
    expect(result.providerLabel).toBe('claude');
  });

  it('runs the hardened, tool-less observer for one turn on the haiku alias', async () => {
    const { impl, calls } = fakeQuery([assistant('<observation/>'), success()]);
    await provider(impl).generate(makeContext());
    expect(calls).toHaveLength(1);
    const options = calls[0]!.options;
    expect(options.model).toBe(DEFAULT_SERVER_SUBSCRIPTION_MODEL);
    expect(options.tools).toEqual([]);
    expect(options.allowedTools).toEqual([]);
    expect(options.permissionMode).toBe('dontAsk');
    expect(options.settingSources).toEqual([]);
    expect(options.mcpServers).toEqual({});
    expect(options.maxTurns).toBe(1);
    expect(options.persistSession).toBe(false);
    expect(options.pathToClaudeCodeExecutable).toBe('/usr/local/bin/claude');
    expect(options.cwd).toBe(cwd);
  });

  it('gives the child the subscription token and none of the server secrets or API keys', async () => {
    const { impl, calls } = fakeQuery([assistant('<observation/>'), success()]);
    await provider(impl, {
      PATH: '/usr/bin',
      HOME: '/home/node',
      ANTHROPIC_API_KEY: 'sk-ant-api-should-not-leak',
      ANTHROPIC_AUTH_TOKEN: 'should-not-leak',
      ANTHROPIC_BASE_URL: 'https://gateway.example.com',
      CLAUDE_MEM_SERVER_DATABASE_URL: 'postgres://secret',
      CLAUDE_MEM_REDIS_URL: 'redis://secret',
    }).generate(makeContext());
    const env = calls[0]!.options.env as NodeJS.ProcessEnv;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat-test');
    expect(env.PATH).toBe('/usr/bin');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.CLAUDE_MEM_SERVER_DATABASE_URL).toBeUndefined();
    expect(env.CLAUDE_MEM_REDIS_URL).toBeUndefined();
  });

  it('never calls the model for privacy-scrubbed input', async () => {
    const { impl, calls } = fakeQuery([]);
    const result = await new ClaudeSubscriptionObservationProvider({
      oauthToken: 't', claudePath: '/c', cwd, queryImpl: impl,
    }).generate(makeContext('<private>secret</private>'));
    expect(result.rawText).toContain('<skip_summary');
    expect(calls).toHaveLength(0);
  });

  it('treats an authentication failure as auth_invalid, never resent', async () => {
    const { impl } = fakeQuery([assistant('Invalid API key · Please run /login', { error: 'authentication_failed' })]);
    const error = await generationError(provider(impl));
    expect(error.kind).toBe('auth_invalid');
    expect(serverPaidSendOutcomeOf(error)).toBe('rejected');
  });

  it('treats a rejected subscription window as quota_exhausted, never resent', async () => {
    const { impl } = fakeQuery([
      { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } },
      { type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached', usage: {} },
    ]);
    const error = await generationError(provider(impl));
    expect(error.kind).toBe('quota_exhausted');
    expect(error.message).toContain('five_hour');
    expect(serverPaidSendOutcomeOf(error)).toBe('rejected');
  });

  it('does not mistake an allowed snapshot for a refusal', async () => {
    const { impl } = fakeQuery([
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' } },
      assistant('<observation/>'),
      success(),
    ]);
    const result = await provider(impl).generate(makeContext());
    expect(result.rawText).toBe('<observation/>');
  });

  it('treats a turn that ends without a result as ambiguous (transient)', async () => {
    const { impl } = fakeQuery([assistant('<observation/>')]);
    const error = await generationError(provider(impl));
    expect(error.kind).toBe('transient');
    expect(serverPaidSendOutcomeOf(error)).toBe('ambiguous');
  });

  it('treats a missing Claude Code executable as unrecoverable', async () => {
    const spawnError = Object.assign(new Error('spawn /usr/local/bin/claude ENOENT'), { code: 'ENOENT' });
    const { impl } = fakeQuery([], { throwAfter: spawnError });
    const error = await generationError(provider(impl));
    expect(error.kind).toBe('unrecoverable');
    expect(error.message).toContain('CLAUDE_MEM_SERVER_CLAUDE_PATH');
  });

  it('rethrows an abort unclassified so the generator records the timeout', async () => {
    const controller = new AbortController();
    const impl = ((args: QueryCall) => (async function* () {
      controller.abort();
      if (args.options.abortController.signal.aborted) throw new Error('aborted by caller');
      yield success();
    })()) as any;
    const p = provider(impl);
    await expect(p.generate(makeContext(), controller.signal)).rejects.toThrow('aborted by caller');
  });

  it('refuses to construct without a token', () => {
    expect(() => new ClaudeSubscriptionObservationProvider({ oauthToken: '', claudePath: '/c' })).toThrow(ServerClassifiedProviderError);
  });
});

describe('classifySubscriptionFailure', () => {
  it('maps the structured error codes', () => {
    expect(classifySubscriptionFailure({ errorCode: 'authentication_failed', text: '' }).kind).toBe('auth_invalid');
    expect(classifySubscriptionFailure({ errorCode: 'billing_error', text: '' }).kind).toBe('quota_exhausted');
    expect(classifySubscriptionFailure({ errorCode: 'rate_limit', text: '' }).kind).toBe('rate_limit');
    expect(classifySubscriptionFailure({ errorCode: 'model_not_found', text: '' }).kind).toBe('unrecoverable');
    expect(classifySubscriptionFailure({ errorCode: 'invalid_request', text: '' }).kind).toBe('unrecoverable');
    expect(classifySubscriptionFailure({ errorCode: 'server_error', text: '' }).kind).toBe('transient');
  });

  it('reads expired tokens and spent windows from the text', () => {
    expect(classifySubscriptionFailure({ text: 'OAuth token has expired' }).kind).toBe('auth_invalid');
    expect(classifySubscriptionFailure({ text: "You've hit your usage limit · resets 3pm" }).kind).toBe('quota_exhausted');
    expect(classifySubscriptionFailure({ text: 'Prompt is too long' }).kind).toBe('unrecoverable');
    expect(classifySubscriptionFailure({ text: 'socket hang up' }).kind).toBe('transient');
  });
});

describe('buildSubscriptionChildEnv', () => {
  it('copies only the allowlist and sets the token', () => {
    const env = buildSubscriptionChildEnv('tok', { PATH: '/bin', HOME: '/h', SECRET: 'x', ANTHROPIC_API_KEY: 'k' });
    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/h',
      CLAUDE_CODE_OAUTH_TOKEN: 'tok',
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });
  });
});

describe('CLAUDE_MEM_SERVER_PROVIDER=claude-subscription', () => {
  const KEYS = ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_MEM_SERVER_CLAUDE_PATH', 'CLAUDE_MEM_SERVER_MODEL', 'ANTHROPIC_API_KEY'];
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('is disabled without a subscription token', async () => {
    process.env.CLAUDE_MEM_SERVER_CLAUDE_PATH = '/usr/local/bin/claude';
    expect(await instantiateServerGenerationProvider('claude-subscription')).toBeNull();
  });

  it('builds the subscription provider with the haiku alias by default', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-test';
    process.env.CLAUDE_MEM_SERVER_CLAUDE_PATH = '/usr/local/bin/claude';
    const built = await instantiateServerGenerationProvider('claude-subscription');
    expect(built).toBeInstanceOf(ClaudeSubscriptionObservationProvider);
    expect((built as unknown as { model: string }).model).toBe('haiku');
  });

  it('honors CLAUDE_MEM_SERVER_MODEL', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-test';
    process.env.CLAUDE_MEM_SERVER_CLAUDE_PATH = '/usr/local/bin/claude';
    process.env.CLAUDE_MEM_SERVER_MODEL = 'sonnet';
    const built = await instantiateServerGenerationProvider('claude-subscription');
    expect((built as unknown as { model: string }).model).toBe('sonnet');
  });
});
