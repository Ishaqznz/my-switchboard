/**
 * Forward-only status merge for outbound message display status.
 * Rank: queued(0) < sent(1) < delivered(2) = failed(2)
 * delivered and failed are both terminal and equal rank.
 * Never regress: if current is delivered/failed, ignore anything.
 */
export type DisplayStatus = 'queued' | 'sent' | 'delivered' | 'failed';

const RANK: Record<DisplayStatus, number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  failed: 2,
};

export function mergeStatus(current: DisplayStatus, incoming: DisplayStatus): DisplayStatus {
  // If current is terminal, never change
  if (current === 'delivered' || current === 'failed') return current;
  if (RANK[incoming] > RANK[current]) return incoming;
  return current;
}

export function isValidDisplayStatus(s: string): s is DisplayStatus {
  return s === 'queued' || s === 'sent' || s === 'delivered' || s === 'failed';
}
