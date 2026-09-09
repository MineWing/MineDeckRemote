import type { ConsoleLine } from '../../shared.ts'

export interface LogHistory { epoch: string | null; entries: ConsoleLine[] }
export interface LegacyLogSnapshot { lines: string[] }

/** Sequence IDs preserve identical repeated messages and deduplicate snapshot overlap. */
export function mergeLogHistory(current: LogHistory | undefined, incoming: LogHistory | LegacyLogSnapshot): LogHistory {
  // Older hosts have no sequence IDs. Retain their snapshot replacement behavior.
  if (!('entries' in incoming)) {
    return { epoch: null, entries: incoming.lines.slice(-800).map((line, sequence) => ({ sequence, line })) }
  }
  const entries = new Map<number, ConsoleLine>()
  if (current && current.epoch === incoming.epoch) for (const entry of current.entries) entries.set(entry.sequence, entry)
  for (const entry of incoming.entries) entries.set(entry.sequence, entry)
  return { epoch: incoming.epoch, entries: [...entries.values()].sort((a,b) => a.sequence-b.sequence).slice(-800) }
}

export function appendLogLine(current: LogHistory | undefined, event: { line: string; epoch?: string; sequence?: number }): LogHistory {
  if (typeof event.epoch === 'string' && typeof event.sequence === 'number') {
    return mergeLogHistory(current, { epoch: event.epoch, entries: [{ sequence: event.sequence, line: event.line }] })
  }
  const entries = current?.epoch === null ? current.entries : []
  const sequence = (entries.at(-1)?.sequence ?? -1) + 1
  return { epoch: null, entries: [...entries, { sequence, line: event.line }].slice(-800) }
}
