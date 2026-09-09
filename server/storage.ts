import { constants } from 'node:fs'
import { open, realpath, rename } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { InputError } from './core.ts'

export function createSaveQueue() {
  let tail = Promise.resolve()
  return (operation: () => Promise<void>) => {
    const result = tail.then(operation)
    tail = result.catch(() => undefined)
    return result
  }
}

export const fileVersion = (content: Buffer | string) => createHash('sha256').update(content).digest('hex')

export async function readEditableFile(path: string, maxBytes: number) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const details = await handle.stat()
    if (!details.isFile()) throw new InputError('Path is not a file')
    if (details.size > maxBytes) throw new InputError('File is larger than 2 MB', 413)
    const content = await handle.readFile()
    if (content.length > maxBytes) throw new InputError('File is larger than 2 MB', 413)
    if (content.includes(0)) throw new InputError('Binary files cannot be edited')
    return { content, details, version: fileVersion(content) }
  } finally { await handle.close() }
}

const pendingFiles = new Map<string, Promise<unknown>>()
export async function saveEditableFile(path: string, content: string, version: string | null, maxBytes: number) {
  path = join(await realpath(dirname(path)), basename(path))
  const previous = pendingFiles.get(path) ?? Promise.resolve()
  const operation = previous.catch(() => undefined).then(async () => {
    const original = await readEditableFile(path, maxBytes).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if ((original?.version ?? null) !== version) throw new InputError('File changed since it was opened. Reload before saving.', 409)
    const temporary = join(dirname(path), `.minedeck-save-${randomBytes(12).toString('hex')}.tmp`)
    const handle = await open(temporary, 'wx', original ? original.details.mode & 0o777 : 0o600)
    try {
      await handle.writeFile(content, 'utf8')
      if (original) await handle.chmod(original.details.mode & 0o777)
      await handle.sync()
    } finally { await handle.close() }
    // Recheck after writing: external writers are not governed by our per-file queue.
    const current = await readEditableFile(path, maxBytes).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if ((current?.version ?? null) !== version) throw new InputError('File changed while saving. Reload before saving.', 409)
    // Failed writes/conflicts retain the sibling temporary file for recovery.
    await rename(temporary, path)
    return fileVersion(content)
  })
  pendingFiles.set(path, operation)
  try { return await operation } finally { if (pendingFiles.get(path) === operation) pendingFiles.delete(path) }
}
