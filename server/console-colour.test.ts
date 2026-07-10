import assert from 'node:assert/strict'
import test from 'node:test'
import { consoleLineTokens } from '../src/lib/console.ts'

test('Minecraft log metadata and severity levels receive console colours', () => {
  const tokens = consoleLineTokens('[12:34:56] [Server thread/WARN]: Can\'t keep up!')
  assert.equal(tokens.map(({ text }) => text).join(''), '[12:34:56] [Server thread/WARN]: Can\'t keep up!')
  assert.equal(tokens.find(({ text }) => text === 'WARN')?.className, 'text-chart-3')
  assert.equal(tokens.at(-1)?.className, 'text-chart-3')
})

test('Minecraft formatting codes become styled spans instead of visible text', () => {
  const tokens = consoleLineTokens('Player: \u00a7aHello \u00a7lworld\u00a7r!')
  assert.equal(tokens.map(({ text }) => text).join(''), 'Player: Hello world!')
  assert.equal(tokens.find(({ text }) => text === 'Hello ')?.className, 'text-[#55ff55]')
  assert.match(tokens.find(({ text }) => text === 'world')?.className ?? '', /font-bold/)
})

test('important unstructured console events are highlighted', () => {
  assert.equal(consoleLineTokens('MineDeck: starting Survival (PID 123)').at(0)?.className, 'text-primary')
  assert.equal(consoleLineTokens('Steve joined the game').at(0)?.className, 'text-chart-4')
  assert.equal(consoleLineTokens('stderr: java.lang.Exception').at(0)?.className, 'text-destructive')
})
