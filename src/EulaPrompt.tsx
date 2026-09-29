import { useState } from 'react'
import { Dialog } from 'radix-ui'
import type { ServerView } from '../shared.ts'

export function EulaPrompt({ servers, accept }: { servers: ServerView[]; accept: (id: string) => Promise<unknown> }) {
  const [dismissed, setDismissed] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const server = servers.find((item) => item.eulaRequired && !dismissed.includes(item.id))
  if (!server) return null
  const dismiss = () => {
    if (busy) return
    setDismissed((ids) => [...ids, server.id])
    setError('')
  }
  const confirm = async () => {
    setBusy(true)
    setError('')
    try {
      await accept(server.id)
      setDismissed((ids) => [...ids, server.id])
    } catch (reason) { setError((reason as Error).message) }
    finally { setBusy(false) }
  }
  const button = 'px-5 py-2 font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50'
  return <Dialog.Root open onOpenChange={(open) => { if (!open) dismiss() }}><Dialog.Portal>
    <Dialog.Overlay className="fixed inset-0 z-50 bg-black/75" />
    <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 border border-border bg-popover p-6 text-popover-foreground">
      <Dialog.Title className="text-xl font-bold">Do you accept the Minecraft EULA?</Dialog.Title>
      <Dialog.Description className="mt-3 text-sm leading-6">
        {server.name} requires your acceptance of the <a className="underline" href="https://www.minecraft.net/eula" target="_blank" rel="noreferrer">Minecraft End User License Agreement</a>.
        {' '}Yes saves eula=true in this server's eula.txt. You can then press Start. No leaves the file unchanged and the server stopped.
      </Dialog.Description>
      {server.pid !== null && <p role="status" className="mt-4 text-sm">Waiting for the server to stop before saving acceptance.</p>}
      {error && <p role="alert" className="mt-4 text-destructive">{error}</p>}
      <div className="mt-6 flex justify-end gap-3" aria-busy={busy}>
        <button className={`${button} bg-[#b42332]`} disabled={busy} onClick={dismiss}>No</button>
        <button className={`${button} bg-[#18733b]`} disabled={busy || server.pid !== null} onClick={() => void confirm()}>{busy ? 'Saving…' : 'Yes'}</button>
      </div>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>
}
