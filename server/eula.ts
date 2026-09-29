import { resolveInside, InputError } from './core.ts'
import { readEditableFile, saveEditableFile } from './storage.ts'

const MAX_EULA_BYTES = 64 * 1024
const declaration = /^[\t ]*eula[\t ]*[=:][\t ]*(true|false)[\t ]*\r?$/gmi

export async function readEula(directory: string) {
  try {
    const path = await resolveInside(directory, 'eula.txt', true)
    const file = await readEditableFile(path, MAX_EULA_BYTES)
    const content = file.content.toString('utf8')
    const entries = [...content.matchAll(declaration)]
    return { path, content, version: file.version, required: entries.at(-1)?.[1]?.toLowerCase() === 'false' }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export async function acceptEula(directory: string) {
  const file = await readEula(directory)
  if (!file) throw new InputError('Start the server first to generate eula.txt', 409)
  if (!file.required) return
  const content = file.content.replace(declaration, (line) => line.replace(/false/i, 'true'))
  await saveEditableFile(file.path, content, file.version, MAX_EULA_BYTES)
}
