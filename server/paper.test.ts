import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { InputError } from './core.ts'
import { downloadPaperJar, listPaperBuilds, listPaperVersions } from './paper.ts'

const response = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
})

test('Paper versions exclude previews and malformed API values', async () => {
  const versions = await listPaperVersions(async () => response({
    versions: {
      '1.21': ['1.21.11', '1.21.11-rc1', '1.21.10'],
      invalid: [null, '../escape'],
    },
  }))
  assert.deepEqual(versions, ['1.21.11', '1.21.10'])
})

test('Paper builds include only stable, complete, trusted downloads in newest-first order', async () => {
  const download = (id: number) => ({
    id,
    time: '2026-08-20T12:00:00Z',
    channel: 'STABLE',
    downloads: {
      'server:default': {
        name: `paper-1.21.11-${id}.jar`,
        size: 1234,
        url: `https://fill-data.papermc.io/v1/objects/${'a'.repeat(64)}/paper.jar`,
        checksums: { sha256: 'a'.repeat(64) },
      },
    },
  })
  const builds = await listPaperBuilds('1.21.11', async () => response([
    download(10),
    { ...download(12), channel: 'BETA' },
    download(11),
    { ...download(13), downloads: { 'server:default': { ...download(13).downloads['server:default'], url: 'https://example.com/paper.jar' } } },
  ]))
  assert.deepEqual(builds.map((build) => build.id), [11, 10])
})

test('Paper API inputs cannot alter the requested project path', async () => {
  await assert.rejects(listPaperBuilds('../velocity', async () => response([])), /Invalid Paper version/)
})

test('Paper JAR downloads are streamed and checksum verified', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'minedeck-paper-'))
  const contents = Buffer.from('mock Paper JAR')
  const sha256 = createHash('sha256').update(contents).digest('hex')
  let request = 0
  const fetcher: typeof fetch = async () => {
    request++
    return request === 1 ? response([{
      id: 42,
      time: '2026-08-20T12:00:00Z',
      channel: 'STABLE',
      downloads: {
        'server:default': {
          name: 'paper-1.21.11-42.jar',
          size: contents.length,
          url: `https://fill-data.papermc.io/v1/objects/${sha256}/paper.jar`,
          checksums: { sha256 },
        },
      },
    }]) : new Response(contents)
  }

  await downloadPaperJar(directory, 'paper.jar', '1.21.11', 42, fetcher)
  assert.deepEqual(await readFile(join(directory, 'paper.jar')), contents)
})

test('Paper timeout remains active while the JSON body is stalled', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let bodyStarted!: () => void
  const started = new Promise<void>((resolve) => { bodyStarted = resolve })
  const fetcher: typeof fetch = async (_url, options) => new Response(new ReadableStream({
    start(controller) {
      options!.signal!.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true })
      bodyStarted()
    },
  }))
  const pending = listPaperVersions(fetcher)
  const rejected = assert.rejects(pending, (error: unknown) => error instanceof InputError && error.statusCode === 504 && /timed out/.test(error.message))
  await started
  // Let fetch return its headers and the caller start consuming the body.
  await Promise.resolve()
  await Promise.resolve()
  context.mock.timers.tick(15_000)
  await rejected
})

test('Paper malformed JSON is reported as an invalid upstream response', async () => {
  await assert.rejects(listPaperVersions(async () => new Response('{')), /invalid response/)
})
