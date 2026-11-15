import { describe, expect, it } from 'bun:test';
import { generationProviderLabel } from '../../src/server/runtime/ServerService.js';

// /api/health `ai.provider` names the provider generating in this process.
// It used to say 'disabled' always, even while a combined container generated.
describe('generationProviderLabel', () => {
  it('names the provider while generation runs here', () => {
    expect(generationProviderLabel({ status: 'active', reason: 'r', details: { provider: 'claude' } })).toBe('claude');
  });

  it("says 'disabled' when generation is not running here", () => {
    expect(generationProviderLabel({ status: 'disabled', reason: 'wired but not started', details: { provider: 'claude' } })).toBe('disabled');
    expect(generationProviderLabel({ status: 'errored', reason: 'closed' })).toBe('disabled');
    expect(generationProviderLabel({ status: 'active', reason: 'r', details: {} })).toBe('disabled');
  });
});
