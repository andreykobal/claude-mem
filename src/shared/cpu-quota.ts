import { readFileSync } from 'fs';
import { availableParallelism } from 'os';

/**
 * CPUs this process may actually use: the cgroup CPU quota when one is set
 * (containers such as Railway or Docker with --cpus), else every CPU thread.
 * availableParallelism() reports the host's threads, 48 on a Railway host
 * whose container gets 1 vCPU; a thread pool sized from it keeps the
 * container throttled.
 */
export function effectiveCpuCount(readFile: (path: string) => string = path => readFileSync(path, 'utf8')): number {
  const host = Math.max(1, availableParallelism());
  const quota = cgroupCpuQuota(readFile);
  return quota === null ? host : Math.max(1, Math.min(host, Math.ceil(quota)));
}

/** The cgroup CPU quota in CPUs, or null when none is set or none is readable. */
export function cgroupCpuQuota(readFile: (path: string) => string): number | null {
  // cgroup v2: "<quota> <period>", or "max <period>" for no limit.
  const v2 = tryRead(readFile, '/sys/fs/cgroup/cpu.max');
  if (v2 !== null) {
    const [quota, period] = v2.trim().split(/\s+/);
    return ratio(quota, period);
  }
  // cgroup v1: a quota of -1 means no limit.
  const quota = tryRead(readFile, '/sys/fs/cgroup/cpu/cpu.cfs_quota_us');
  const period = tryRead(readFile, '/sys/fs/cgroup/cpu/cpu.cfs_period_us');
  return quota === null || period === null ? null : ratio(quota.trim(), period.trim());
}

function ratio(quota: string | undefined, period: string | undefined): number | null {
  const q = Number(quota);
  const p = Number(period);
  return Number.isFinite(q) && Number.isFinite(p) && q > 0 && p > 0 ? q / p : null;
}

function tryRead(readFile: (path: string) => string, path: string): string | null {
  try {
    return readFile(path);
  } catch {
    return null;
  }
}
