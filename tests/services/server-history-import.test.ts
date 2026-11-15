import { describe, expect, it } from 'bun:test';
import { observationItem, parseImportArgs, summaryItem } from '../../src/services/import/ServerHistoryImport.js';

// A machine's local rows become server rows shaped as the server's own
// generator writes them, keyed so a rerun adds nothing twice.
describe('server history import rows', () => {
  it('renders an observation as the server generator does, with its original time', () => {
    const item = observationItem({
      id: 42, type: 'bugfix', title: 'Fixed the parser', subtitle: 'Edge case', narrative: 'It broke on tabs.',
      facts: '["tabs were split","now trimmed"]', concepts: '["gotcha"]', files_read: '["src/a.ts"]', files_modified: '["src/b.ts"]',
      created_at_epoch: 1_778_430_786_769, target_project: 'witch-match', platform_source: 'claude',
    }, 'db1');
    expect(item).toMatchObject({
      key: 'db1:observations:42',
      kind: 'bugfix',
      content: 'Fixed the parser\n\nEdge case\n\nIt broke on tabs.\n\n- tabs were split\n- now trimmed',
      createdAtEpoch: 1_778_430_786_769,
      metadata: { title: 'Fixed the parser', facts: ['tabs were split', 'now trimmed'], files_modified: ['src/b.ts'], project: 'witch-match', platformSource: 'claude' },
    });
  });

  it('reads seconds as seconds, keeps a legacy text body, and never calls an observation a summary', () => {
    const item = observationItem({ id: 1, type: 'summary', text: 'Old body', created_at_epoch: 1_700_000_000, target_project: 'p' }, 'db');
    expect(item?.kind).toBe('discovery');
    expect(item?.content).toBe('Old body');
    expect(item?.createdAtEpoch).toBe(1_700_000_000_000);
  });

  it('skips a row with nothing to say', () => {
    expect(observationItem({ id: 2, type: 'change', created_at_epoch: 1, target_project: 'p' }, 'db')).toBeNull();
    expect(summaryItem({ id: 3, created_at_epoch: 1, target_project: 'p' }, 'db')).toBeNull();
  });

  it('renders a session summary as the server generator does', () => {
    const item = summaryItem({
      id: 7, request: 'Ship it', learned: 'Tests matter', next_steps: 'Deploy',
      created_at_epoch: 1_778_430_786_769, target_project: 'reels', platform_source: null,
    }, 'db1');
    expect(item).toMatchObject({
      key: 'db1:session_summaries:7',
      kind: 'summary',
      content: 'Request: Ship it\n\nLearned: Tests matter\n\nNext steps: Deploy',
      metadata: { request: 'Ship it', investigated: null, project: 'reels', platformSource: 'claude' },
    });
  });

  it('reads its flags', () => {
    expect(parseImportArgs(['--dry-run', '--db', '/x.db', '--project', 'reels', '--batch', '999']))
      .toEqual({ dbPath: '/x.db', dryRun: true, project: 'reels', batchSize: 200 });
  });
});
