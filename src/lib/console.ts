export interface ConsoleToken {
  text: string
  className?: string
}

const minecraftColours: Record<string, string> = {
  '0': 'text-[#000000]',
  '1': 'text-[#0000aa]',
  '2': 'text-[#00aa00]',
  '3': 'text-[#00aaaa]',
  '4': 'text-[#aa0000]',
  '5': 'text-[#aa00aa]',
  '6': 'text-[#ffaa00]',
  '7': 'text-[#aaaaaa]',
  '8': 'text-[#555555]',
  '9': 'text-[#5555ff]',
  a: 'text-[#55ff55]',
  b: 'text-[#55ffff]',
  c: 'text-[#ff5555]',
  d: 'text-[#ff55ff]',
  e: 'text-[#ffff55]',
  f: 'text-[#ffffff]',
}

const levelClass: Record<string, string> = {
  INFO: 'text-chart-5',
  WARN: 'text-chart-3',
  ERROR: 'text-destructive',
  FATAL: 'text-destructive font-bold',
  DEBUG: 'text-muted-foreground',
  TRACE: 'text-muted-foreground',
}

const messageClass = (line: string) => {
  if (line.startsWith('MineDeck:')) return 'text-primary'
  if (line.startsWith('>')) return 'text-chart-5'
  if (/^stderr:|\b(?:error|fatal|exception|crash(?:ed)?)\b|^\s*at\s+[\w.$]+\(/i.test(line)) return 'text-destructive'
  if (/\bwarn(?:ing)?\b/i.test(line)) return 'text-chart-3'
  if (/Done \([\d.]+s\)!|For help, type|Listening on|Server started/i.test(line)) return 'text-chart-2'
  if (/\b(?:joined|left) the game\b|<[^>]+>/.test(line)) return 'text-chart-4'
  return undefined
}

function formattedTokens(text: string, baseClass?: string): ConsoleToken[] {
  if (!/\u00a7[0-9a-fk-or]/i.test(text)) return [{ text, className: baseClass }]

  const tokens: ConsoleToken[] = []
  let colour = ''
  const formats = new Set<string>()
  let start = 0
  const code = /\u00a7([0-9a-fk-or])/gi
  const classes = () => [colour || baseClass, ...formats].filter(Boolean).join(' ') || undefined
  const push = (end: number) => {
    if (end > start) tokens.push({ text: text.slice(start, end), className: classes() })
  }

  for (let match = code.exec(text); match; match = code.exec(text)) {
    push(match.index)
    const value = match[1]!.toLowerCase()
    if (minecraftColours[value]) {
      colour = minecraftColours[value]!
      formats.clear()
    } else if (value === 'r') {
      colour = ''
      formats.clear()
    } else if (value === 'l') formats.add('font-bold')
    else if (value === 'm') formats.add('line-through')
    else if (value === 'n') formats.add('underline')
    else if (value === 'o') formats.add('italic')
    // Obfuscated text (section-k) is left readable in the remote console.
    start = code.lastIndex
  }
  push(text.length)
  return tokens
}

/** Turns a raw Minecraft log line into safe, styled text fragments for React. */
export function consoleLineTokens(line: string): ConsoleToken[] {
  const standard = line.match(/^(\[[^\]]+\])(\s+)(\[[^\]]+\/(INFO|WARN|ERROR|FATAL|DEBUG|TRACE)\])(:?\s*)(.*)$/i)
  if (standard) {
    const time = standard[1]!
    const spacing = standard[2]!
    const logger = standard[3]!
    const level = standard[4]!
    const separator = standard[5]!
    const message = standard[6]!
    return [
      { text: time, className: 'text-muted-foreground' },
      { text: spacing },
      { text: logger.slice(0, -(level.length + 1)), className: 'text-chart-1' },
      { text: level, className: levelClass[level.toUpperCase()] },
      { text: ']', className: 'text-chart-1' },
      { text: separator },
      ...formattedTokens(message, messageClass(message) ?? (['WARN', 'ERROR', 'FATAL'].includes(level.toUpperCase()) ? levelClass[level.toUpperCase()] : undefined)),
    ]
  }

  const compact = line.match(/^(\[[^\]]*\b(INFO|WARN|ERROR|FATAL|DEBUG|TRACE)\])(:?\s*)(.*)$/i)
  if (compact) {
    const prefix = compact[1]!
    const level = compact[2]!
    const separator = compact[3]!
    const message = compact[4]!
    const levelAt = prefix.toUpperCase().lastIndexOf(level.toUpperCase())
    return [
      { text: prefix.slice(0, levelAt), className: 'text-muted-foreground' },
      { text: prefix.slice(levelAt, levelAt + level.length), className: levelClass[level.toUpperCase()] },
      { text: prefix.slice(levelAt + level.length), className: 'text-muted-foreground' },
      { text: separator },
      ...formattedTokens(message, messageClass(message) ?? (['WARN', 'ERROR', 'FATAL'].includes(level.toUpperCase()) ? levelClass[level.toUpperCase()] : undefined)),
    ]
  }

  return formattedTokens(line, messageClass(line))
}
