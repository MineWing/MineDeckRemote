import type { ConsoleLine } from '../../shared.ts'
export interface LogHistory { epoch: string; entries: ConsoleLine[] }
/** Sequence IDs preserve identical repeated messages and deduplicate snapshot overlap. */
export function mergeLogHistory(current: LogHistory | undefined, incoming: LogHistory): LogHistory {
  const entries = new Map<number, ConsoleLine>()
  if (current?.epoch === incoming.epoch) for (const entry of current.entries) entries.set(entry.sequence, entry)
  for (const entry of incoming.entries) entries.set(entry.sequence, entry)
  return { epoch: incoming.epoch, entries: [...entries.values()].sort((a,b) => a.sequence-b.sequence).slice(-800) }
}
