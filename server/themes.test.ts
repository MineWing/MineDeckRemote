import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8')
const startup = html.match(/<script>([\s\S]*?)<\/script>/)![1]!

for (const saved of ['light', 'dark', 'dracula', 'tiesen', 'portfolio', '2077', 'nlan', 'discord', 'terminal', '', null]) {
  test(`startup restores ${saved ?? 'no preference'} without a wrong-mode flash`, () => {
    const root = { dataset: {theme: 'dark'}, classList: { toggle: (name: string, enabled: boolean) => {
      assert.equal(name, 'dark')
      assert.equal(enabled, saved !== 'light')
    } } }
    runInNewContext(startup, { document: {documentElement: root}, localStorage: {getItem: () => saved} })
    assert.equal(root.dataset.theme, saved === 'light' ? 'light' : 'dark')
  })
}

test('startup tolerates unavailable storage and retains default dark mode', () => {
  assert.match(html, /class="dark" data-theme="dark"/)
  assert.doesNotThrow(() => runInNewContext(startup, { localStorage: {getItem: () => { throw new Error('Storage blocked') }} }))
})
