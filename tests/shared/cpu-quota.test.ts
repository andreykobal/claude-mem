import { describe, expect, it } from 'bun:test';
import { availableParallelism } from 'os';
import { cgroupCpuQuota, effectiveCpuCount } from '../../src/shared/cpu-quota.js';

// A Railway container with 1 vCPU reports the host's 48 threads through
// availableParallelism(); the embedder sized its thread pool from that and
// kept the container throttled. The quota is what the process may use.
const files = (map: Record<string, string>) => (path: string) => {
  if (path in map) return map[path]!;
  throw new Error('ENOENT');
};

describe('effectiveCpuCount', () => {
  it('takes the cgroup v2 quota, rounded up', () => {
    expect(cgroupCpuQuota(files({ '/sys/fs/cgroup/cpu.max': '100000 100000\n' }))).toBe(1);
    expect(effectiveCpuCount(files({ '/sys/fs/cgroup/cpu.max': '100000 100000\n' }))).toBe(1);
    expect(effectiveCpuCount(files({ '/sys/fs/cgroup/cpu.max': '50000 100000' }))).toBe(1);
    expect(cgroupCpuQuota(files({ '/sys/fs/cgroup/cpu.max': '250000 100000' }))).toBe(2.5);
  });

  it('takes the cgroup v1 quota', () => {
    expect(cgroupCpuQuota(files({
      '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '200000',
      '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000',
    }))).toBe(2);
  });

  it('uses every thread when there is no quota or no cgroup', () => {
    expect(cgroupCpuQuota(files({ '/sys/fs/cgroup/cpu.max': 'max 100000' }))).toBeNull();
    expect(cgroupCpuQuota(files({ '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '-1', '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000' }))).toBeNull();
    expect(effectiveCpuCount(files({}))).toBe(Math.max(1, availableParallelism()));
  });

  it('never exceeds the host threads', () => {
    expect(effectiveCpuCount(files({ '/sys/fs/cgroup/cpu.max': `${1_000_000 * 100_000} 100000` }))).toBe(Math.max(1, availableParallelism()));
  });
});
