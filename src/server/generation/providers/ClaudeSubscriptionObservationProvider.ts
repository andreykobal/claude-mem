// SPDX-License-Identifier: Apache-2.0

// Server generation through a Claude subscription instead of an API key.
//
// The built-in ClaudeObservationProvider posts to the Messages API with an
// `x-api-key`, so every call is billed per token. This provider runs the same
// hardened, tool-less Agent SDK observer the local worker uses
// (src/sdk/hardened-options.ts) and authenticates the Claude Code child with a
// long-lived `claude setup-token` token (CLAUDE_CODE_OAUTH_TOKEN).
//
// Failure contract (docs/architecture/observer-lifecycle.md, AGENTS.md):
// a spent subscription window is `quota_exhausted` and an expired or revoked
// token is `auth_invalid`; both are definite refusals, so the generator fails
// the job without a resend and nothing revives it after a reset or re-login.
// A lost or unanswered call is `transient` (ambiguous) and is resent only
// within SERVER_MAX_PAID_SENDS_PER_JOB. This module adds no queue, retry or
// buffer of its own.

import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '../../../utils/logger.js';
import { buildHardenedSdkOptions, type ObserverThinkingOption } from '../../../sdk/hardened-options.js';
import { ServerClassifiedProviderError } from './shared/error-classification.js';
import { buildServerGenerationPrompt } from './shared/prompt-builder.js';
import type {
  ServerGenerationContext,
  ServerGenerationProvider,
  ServerGenerationResult,
} from './shared/types.js';

/** Claude Code alias: resolves to the newest Haiku, never a dated pin. */
export const DEFAULT_SERVER_SUBSCRIPTION_MODEL = 'haiku';

/**
 * Variables the Claude Code child may inherit. Everything else the server
 * holds (database URL, Redis URL, provider keys) stays out of the child.
 */
const CHILD_ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'CLAUDE_CONFIG_DIR',
] as const;

/**
 * The env handed to the Claude Code child: the allowlist plus the
 * subscription token. API-key, gateway and cloud-provider variables are never
 * copied, so the child cannot fall back to per-token billing.
 */
export function buildSubscriptionChildEnv(
  oauthToken: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  // A headless one-shot observer has no use for the updater or telemetry.
  env.DISABLE_AUTOUPDATER = '1';
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  return env;
}

type QueryFn = typeof sdkQuery;

export interface ClaudeSubscriptionObservationProviderOptions {
  /** Long-lived token from `claude setup-token`. */
  oauthToken: string;
  /** Absolute path of the Claude Code executable the SDK launches. */
  claudePath: string;
  model?: string;
  thinking?: ObserverThinkingOption;
  /** Observer working directory; defaults to the hardened observer sessions dir. */
  cwd?: string;
  /** Environment the child allowlist is read from. Defaults to process.env. */
  baseEnv?: NodeJS.ProcessEnv;
  /** Test seam for the Agent SDK `query`. */
  queryImpl?: QueryFn;
}

interface RateLimitSnapshot {
  status?: unknown;
  rateLimitType?: unknown;
  resetsAt?: unknown;
}

function rateLimitSnapshotOf(message: unknown): RateLimitSnapshot | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const m = message as { type?: unknown; subtype?: unknown; rate_limit_info?: unknown };
  const isRateLimit = m.type === 'rate_limit_event' || (m.type === 'system' && m.subtype === 'rate_limit');
  if (!isRateLimit || !m.rate_limit_info || typeof m.rate_limit_info !== 'object') return undefined;
  return m.rate_limit_info as RateLimitSnapshot;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: 'text'; text: string } =>
      !!block && typeof block === 'object'
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string')
    .map(block => block.text)
    .join('\n');
}

const QUOTA_TEXT = /usage limit|limit reached|limit will reset|out of (?:extra )?usage|credit balance is too low|quota exceeded/i;
const AUTH_TEXT = /invalid api key|authentication[_ ]failed|oauth token (?:has )?expired|token (?:has been )?revoked|please run \/login|not logged in|unauthorized|\b401\b|\b403\b/i;
const OVERFLOW_TEXT = /prompt is too long|context window/i;
const MODEL_TEXT = /issue with the selected model|model_not_found|may not exist or you may not have access/i;

/**
 * Classify a failed Claude Code turn from its structured error code, the
 * subscription snapshot seen during the turn, and its text. Unknown failures
 * are transient: the call may have run, so the generator resends it at most
 * within the paid-send budget.
 */
export function classifySubscriptionFailure(input: {
  errorCode?: string;
  text: string;
  rejected?: RateLimitSnapshot;
  cause?: unknown;
}): ServerClassifiedProviderError {
  const { errorCode, text, rejected } = input;
  const cause = input.cause ?? new Error(text || errorCode || 'Claude subscription call failed');
  const window = typeof rejected?.rateLimitType === 'string' ? rejected.rateLimitType : 'unknown';

  if (errorCode === 'authentication_failed' || AUTH_TEXT.test(text)) {
    return new ServerClassifiedProviderError(
      'Claude subscription token rejected; replace CLAUDE_CODE_OAUTH_TOKEN with a new `claude setup-token` token',
      { kind: 'auth_invalid', cause },
    );
  }
  if (rejected || errorCode === 'billing_error' || QUOTA_TEXT.test(text)) {
    return new ServerClassifiedProviderError(
      `Claude subscription usage limit reached (window: ${window})`,
      { kind: 'quota_exhausted', cause },
    );
  }
  if (errorCode === 'rate_limit') {
    return new ServerClassifiedProviderError('Claude subscription rate limit', { kind: 'rate_limit', cause });
  }
  if (errorCode === 'model_not_found' || MODEL_TEXT.test(text)) {
    return new ServerClassifiedProviderError(
      'Claude Code refused the model; set CLAUDE_MEM_SERVER_MODEL to a model this subscription serves',
      { kind: 'unrecoverable', cause },
    );
  }
  if (errorCode === 'invalid_request' || OVERFLOW_TEXT.test(text)) {
    return new ServerClassifiedProviderError('Claude subscription request rejected', { kind: 'unrecoverable', cause });
  }
  return new ServerClassifiedProviderError(
    `Claude subscription call failed${text ? `: ${text.substring(0, 200)}` : ''}`,
    { kind: 'transient', cause },
  );
}

function isSpawnFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'EACCES' || /\bspawn\b.*\b(?:ENOENT|EACCES|EINVAL)\b/.test(message);
}

export class ClaudeSubscriptionObservationProvider implements ServerGenerationProvider {
  readonly providerLabel = 'claude' as const;
  private readonly oauthToken: string;
  private readonly claudePath: string;
  private readonly model: string;
  private readonly thinking: ObserverThinkingOption;
  private readonly cwd?: string;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly queryImpl: QueryFn;

  constructor(options: ClaudeSubscriptionObservationProviderOptions) {
    if (!options.oauthToken) {
      throw new ServerClassifiedProviderError('Claude subscription token not configured', {
        kind: 'auth_invalid',
        cause: new Error('oauthToken is required'),
      });
    }
    if (!options.claudePath) {
      throw new ServerClassifiedProviderError('Claude Code executable not configured', {
        kind: 'unrecoverable',
        cause: new Error('claudePath is required'),
      });
    }
    this.oauthToken = options.oauthToken;
    this.claudePath = options.claudePath;
    this.model = options.model?.trim() || DEFAULT_SERVER_SUBSCRIPTION_MODEL;
    this.thinking = options.thinking ?? { type: 'disabled' };
    this.cwd = options.cwd;
    this.baseEnv = options.baseEnv ?? process.env;
    this.queryImpl = options.queryImpl ?? sdkQuery;
  }

  async generate(context: ServerGenerationContext, signal?: AbortSignal): Promise<ServerGenerationResult> {
    const { prompt, skippedAll, noEvents } = buildServerGenerationPrompt(context);
    // Same no-call skips as the API-key provider: nothing loaded, or every
    // event scrubbed by privacy stripping, never reaches the model.
    if (noEvents) {
      return { rawText: '<skip_summary reason="no_events_loaded" />', providerLabel: this.providerLabel, modelId: this.model };
    }
    if (skippedAll) {
      return { rawText: '<skip_summary reason="all_events_private" />', providerLabel: this.providerLabel, modelId: this.model };
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();

    let rawText = '';
    let servedModel = this.model;
    let completed = false;
    let rejected: RateLimitSnapshot | undefined;
    let tokensUsed: number | undefined;

    try {
      const stream = this.queryImpl({
        prompt,
        options: {
          ...buildHardenedSdkOptions({
            source: 'Observer',
            project: context.project.projectName ?? context.project.projectId,
            model: this.model,
            env: buildSubscriptionChildEnv(this.oauthToken, this.baseEnv),
            pathToClaudeCodeExecutable: this.claudePath,
            abortController: controller,
            thinking: this.thinking,
            ...(this.cwd ? { cwd: this.cwd } : {}),
          }),
          maxTurns: 1,
          persistSession: false,
        },
      });

      for await (const message of stream) {
        const snapshot = rateLimitSnapshotOf(message);
        if (snapshot?.status === 'rejected') rejected = snapshot;

        if (message.type === 'assistant') {
          const text = textOf(message.message.content);
          const errorCode = typeof message.error === 'string' ? message.error : undefined;
          // A frame with an error carries the CLI's status line, not an answer.
          if (errorCode) {
            throw classifySubscriptionFailure({ errorCode, text, rejected });
          }
          if (text) rawText = rawText ? `${rawText}\n${text}` : text;
          const reported = message.message.model;
          if (typeof reported === 'string' && reported) servedModel = reported;
        }

        if (message.type === 'result') {
          if (message.subtype !== 'success' || message.is_error) {
            const details = message.subtype === 'success' ? message.result : message.errors.join('\n');
            throw classifySubscriptionFailure({ text: details ?? '', rejected });
          }
          const usage = message.usage as { input_tokens?: number; output_tokens?: number } | undefined;
          if (usage && (typeof usage.input_tokens === 'number' || typeof usage.output_tokens === 'number')) {
            tokensUsed = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
          }
          completed = true;
        }
      }
    } catch (error) {
      if (error instanceof ServerClassifiedProviderError) throw error;
      // The generator turns an abort into an ambiguous timeout itself.
      if (controller.signal.aborted) throw error;
      if (isSpawnFailure(error)) {
        throw new ServerClassifiedProviderError(
          `Claude Code executable could not start (${this.claudePath}); check CLAUDE_MEM_SERVER_CLAUDE_PATH`,
          { kind: 'unrecoverable', cause: error },
        );
      }
      const text = error instanceof Error ? error.message : String(error);
      throw classifySubscriptionFailure({ text, rejected, cause: error });
    } finally {
      signal?.removeEventListener('abort', abort);
    }

    if (!completed) {
      throw classifySubscriptionFailure({ text: 'Claude Code ended without a result', rejected });
    }
    // A served turn with no text but a rejected window was refused, not answered.
    if (!rawText && rejected) {
      throw classifySubscriptionFailure({ text: '', rejected });
    }
    rawText = rawText.trim();
    if (!rawText) {
      logger.warn('SDK', 'Claude subscription observer returned no text', { provider: 'claude-subscription', model: servedModel });
    }

    return {
      rawText,
      ...(tokensUsed !== undefined ? { tokensUsed } : {}),
      providerLabel: this.providerLabel,
      modelId: servedModel,
    };
  }
}
