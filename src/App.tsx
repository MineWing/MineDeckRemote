import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { FileEntry, ServerStatus, ServerView, SocketEvent } from '../shared.ts'

class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers,
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new ApiError(body.error ?? `Request failed (${response.status})`, response.status)
  return body as T
}

const statusStyle: Record<ServerStatus, string> = {
  running: 'bg-lime-400', starting: 'bg-amber-400', stopping: 'bg-amber-400', crashed: 'bg-red-400', stopped: 'bg-zinc-500',
}

type ToastTone = 'success' | 'info' | 'warning' | 'error'
interface Toast { id: number; group?: string; tone: ToastTone; title: string; message: string }
type ToastContent = Omit<Toast, 'id' | 'group'>

export function statusNotification(server: Pick<ServerView, 'name' | 'status' | 'autoRestart'>, previous: ServerStatus, restarting = false): ToastContent | undefined {
  if (server.status === previous) return
  if (server.status === 'starting') return { tone: 'info', title: restarting || previous === 'crashed' ? 'Restarting server' : 'Starting server', message: `${server.name} is warming up…` }
  if (server.status === 'running') return { tone: 'success', title: 'Server online', message: `${server.name} is ready for players.` }
  if (server.status === 'stopping') return { tone: 'warning', title: restarting ? 'Restarting server' : 'Stopping server', message: `${server.name} is saving the world…` }
  if (server.status === 'stopped') return restarting
    ? { tone: 'info', title: 'Restarting server', message: `${server.name} is starting again…` }
    : { tone: 'success', title: 'Server stopped', message: `${server.name} is safely offline.` }
  return { tone: 'error', title: 'Server crashed', message: `${server.name} exited unexpectedly.${server.autoRestart ? ' Restarting in 5 seconds…' : ''}` }
}

const prettyStatus = (status: ServerStatus) => status.charAt(0).toUpperCase() + status.slice(1)
const tabs = ['console', 'files', 'configuration'] as const
const formatUptime = (seconds: number) => {
  if (!seconds) return '—'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor(seconds % 86400 / 3600)
  const minutes = Math.floor(seconds % 3600 / 60)
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m ${seconds % 60}s`
}
const formatSize = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`

function Logo({ compact = false }: { compact?: boolean }) {
  return <div className="flex items-center gap-3">
    <svg aria-hidden="true" viewBox="0 0 48 48" className={`${compact ? 'h-8 w-8' : 'h-10 w-10'} shrink-0 text-white drop-shadow-[0_0_12px_rgba(255,15,123,.35)]`}>
      <path d="m27.2 14.1 6.1 4.1-16.9 25.1-6.1-4.1 16.9-25.1Z" fill="currentColor" />
      <path d="M6.8 11.7C15.4 4.1 29.8 3.6 41.3 12l-3.5 5.1c-8.2-5.7-17.5-6-25.9-.2l-5.1-5.2Z" fill="currentColor" />
    </svg>
    <div className="leading-none"><div className={`${compact ? 'text-lg' : 'text-xl'} font-black tracking-tight text-white`}>MINEDECK</div><div className={`${compact ? 'mt-0.5 text-[8px]' : 'mt-1 text-[10px]'} bg-gradient-to-r from-[#ff0f7b] to-[#f89b29] bg-clip-text font-black tracking-[.3em] text-transparent`}>REMOTE</div></div>
  </div>
}

const toastStyle: Record<ToastTone, { icon: string; border: string; glow: string; bar: string }> = {
  success: { icon: '✓', border: 'border-lime-500/40', glow: 'bg-lime-400/15 text-lime-300', bar: 'bg-lime-400' },
  info: { icon: '↻', border: 'border-sky-500/40', glow: 'bg-sky-400/15 text-sky-300', bar: 'bg-sky-400' },
  warning: { icon: '!', border: 'border-amber-500/40', glow: 'bg-amber-400/15 text-amber-300', bar: 'bg-amber-400' },
  error: { icon: '×', border: 'border-red-500/40', glow: 'bg-red-400/15 text-red-300', bar: 'bg-red-400' },
}

function Toasts({ items, onDismiss }: { items: Toast[]; onDismiss: (id: number) => void }) {
  return <div className="pointer-events-none fixed inset-x-3 top-3 z-[60] flex flex-col items-end gap-3 sm:left-auto sm:right-5 sm:top-5 sm:w-96" aria-live="polite" aria-atomic="true">
    {items.map((toast) => {
      const style = toastStyle[toast.tone]
      return <div key={toast.id} role={toast.tone === 'error' ? 'alert' : 'status'} className={`toast pointer-events-auto relative w-full overflow-hidden rounded-2xl border ${style.border} bg-zinc-900/95 p-4 pr-12 shadow-2xl shadow-black/40 backdrop-blur-xl`}>
        <div className="flex gap-3">
          <span aria-hidden="true" className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl text-lg font-black shadow-[0_0_24px_currentColor] ${style.glow}`}>{style.icon}</span>
          <div className="min-w-0 pt-0.5"><div className="font-bold text-white">{toast.title}</div><div className="mt-1 text-sm leading-5 text-zinc-400">{toast.message}</div></div>
        </div>
        <button className="absolute right-2 top-2 grid h-10 w-10 place-items-center rounded-xl text-xl text-zinc-600 transition hover:bg-white/5 hover:text-white" onClick={() => onDismiss(toast.id)} aria-label="Dismiss notification">×</button>
        <span className={`toast-timer absolute inset-x-0 bottom-0 h-0.5 ${style.bar}`} />
      </div>
    })}
  </div>
}

function Login({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('')
    try {
      await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) })
      onLogin()
    } catch (reason) { setError((reason as Error).message) } finally { setBusy(false) }
  }
  return <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-zinc-950 p-5">
    <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_15%,rgba(132,204,22,.12),transparent_35%)]" />
    <div className="panel relative w-full max-w-sm overflow-hidden p-7 sm:p-9">
      <div className="mb-9"><Logo /><h1 className="mt-8 text-2xl font-bold text-white">Welcome back</h1><p className="mt-2 text-sm leading-6 text-zinc-400">Sign in to manage your Minecraft servers.</p></div>
      <form onSubmit={submit}>
        <label className="label" htmlFor="password">Admin password</label>
        <input id="password" className="field" type="password" autoComplete="current-password" autoFocus required value={password} onChange={(event) => setPassword(event.target.value)} />
        {error && <div role="alert" className="mt-3 rounded-xl border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">{error}</div>}
        <button className="btn-primary mt-5 w-full" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
      <p className="mt-6 text-center text-xs text-zinc-600">Private by default · Session protected</p>
    </div>
  </main>
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 p-0 backdrop-blur-sm sm:items-center sm:p-5" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <div role="dialog" aria-modal="true" aria-label={title} className="max-h-[94vh] w-full max-w-2xl overflow-auto rounded-t-2xl border border-zinc-800 bg-zinc-900 shadow-2xl sm:rounded-2xl">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-zinc-800 bg-zinc-900/95 px-5 py-4 backdrop-blur">
        <h2 className="font-bold text-white">{title}</h2><button className="rounded-lg px-3 py-1.5 text-xl text-zinc-500 hover:bg-zinc-800 hover:text-white" onClick={onClose} aria-label="Close">×</button>
      </div>
      {children}
    </div>
  </div>
}

interface ServerFormValue {
  name: string; directory: string; jar: string; javaPath: string; minMemoryMb: number; maxMemoryMb: number; javaArgs: string; autoRestart: boolean; stopTimeoutSeconds: number
}

const formValue = (server?: ServerView): ServerFormValue => ({
  name: server?.name ?? '', directory: server?.directory ?? '', jar: server?.jar ?? 'server.jar', javaPath: server?.javaPath ?? 'java',
  minMemoryMb: server?.minMemoryMb ?? 1024, maxMemoryMb: server?.maxMemoryMb ?? 2048, javaArgs: server?.javaArgs.join('\n') ?? '',
  autoRestart: server?.autoRestart ?? true, stopTimeoutSeconds: server?.stopTimeoutSeconds ?? 30,
})

function ServerForm({ server, onSaved, onCancel, onDelete }: { server?: ServerView; onSaved: (server: ServerView) => void; onCancel?: () => void; onDelete?: () => void }) {
  const [value, setValue] = useState(() => formValue(server))
  const [mode, setMode] = useState<'import' | 'manual'>(server ? 'manual' : 'import')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => setValue(formValue(server)), [server?.id])
  const set = <K extends keyof ServerFormValue>(key: K, next: ServerFormValue[K]) => setValue((current) => ({ ...current, [key]: next }))
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('')
    const importing = !server && mode === 'import'
    const payload = importing ? { name: value.name, directory: value.directory } : { ...value, javaArgs: value.javaArgs.split('\n').map((arg) => arg.trim()).filter(Boolean) }
    try {
      const saved = await api<ServerView>(server ? `/api/servers/${server.id}` : importing ? '/api/servers/import' : '/api/servers', { method: server ? 'PUT' : 'POST', body: JSON.stringify(payload) })
      onSaved(saved)
    } catch (reason) { setError((reason as Error).message) } finally { setBusy(false) }
  }
  return <form onSubmit={submit} className="space-y-5 p-5 sm:p-6">
    {!server && <div className="grid grid-cols-2 gap-2 rounded-xl bg-zinc-950 p-1">
      <button type="button" aria-pressed={mode === 'import'} className={mode === 'import' ? 'btn-primary' : 'btn-muted'} onClick={() => { setMode('import'); setError('') }}>Import existing</button>
      <button type="button" aria-pressed={mode === 'manual'} className={mode === 'manual' ? 'btn-primary' : 'btn-muted'} onClick={() => { setMode('manual'); setError('') }}>Manual setup</button>
    </div>}
    <label><span className="label">Server name</span><input className="field" required maxLength={50} value={value.name} onChange={(event) => set('name', event.target.value)} placeholder="Survival" /></label>
    <label><span className="label">Server directory</span><input className="field font-mono" required value={value.directory} onChange={(event) => set('directory', event.target.value)} placeholder="C:\Minecraft\Survival" /><span className="mt-1.5 block text-xs text-zinc-600">{!server && mode === 'import' ? <>The existing folder containing <code>start.bat</code>.</> : <>An existing folder containing the JAR file. <code>~/…</code> is supported.</>}</span></label>
    {(!server && mode === 'manual' || server) && <>
      <div className="grid gap-4 sm:grid-cols-2">
      <label><span className="label">Server JAR</span><input className="field font-mono" required value={value.jar} onChange={(event) => set('jar', event.target.value)} placeholder="server.jar" /></label>
      </div>
    <div className="grid gap-4 sm:grid-cols-3">
      <label><span className="label">Java command</span><input className="field font-mono" required value={value.javaPath} onChange={(event) => set('javaPath', event.target.value)} /></label>
      <label><span className="label">Minimum RAM (MB)</span><input className="field" type="number" min={256} max={65536} required value={value.minMemoryMb} onChange={(event) => set('minMemoryMb', event.target.valueAsNumber)} /></label>
      <label><span className="label">Maximum RAM (MB)</span><input className="field" type="number" min={256} max={65536} required value={value.maxMemoryMb} onChange={(event) => set('maxMemoryMb', event.target.valueAsNumber)} /></label>
    </div>
    <label><span className="label">Extra Java arguments <span className="font-normal text-zinc-600">(one per line)</span></span><textarea className="field min-h-20 resize-y font-mono" value={value.javaArgs} onChange={(event) => set('javaArgs', event.target.value)} placeholder="-XX:+UseG1GC" /></label>
    <div className="grid gap-4 sm:grid-cols-2">
      <label><span className="label">Graceful stop timeout (seconds)</span><input className="field" type="number" min={5} max={120} required value={value.stopTimeoutSeconds} onChange={(event) => set('stopTimeoutSeconds', event.target.valueAsNumber)} /></label>
      <label className="flex min-h-[68px] items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950/50 px-4 py-3">
        <input className="h-4 w-4 accent-lime-500" type="checkbox" checked={value.autoRestart} onChange={(event) => set('autoRestart', event.target.checked)} />
        <span><span className="block text-sm font-semibold text-zinc-200">Automatic restart</span><span className="text-xs text-zinc-500">Restart five seconds after a crash</span></span>
      </label>
    </div>
    </>}
    {error && <div role="alert" className="rounded-xl border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">{error}</div>}
    <div className="flex flex-wrap justify-between gap-3 border-t border-zinc-800 pt-5">
      <div>{server && onDelete && <button type="button" className="btn-danger" onClick={onDelete}>Remove server</button>}</div>
      <div className="flex gap-2">{onCancel && <button type="button" className="btn-muted" onClick={onCancel}>Cancel</button>}<button className="btn-primary" disabled={busy || Boolean(server?.status !== 'stopped' && server?.status !== 'crashed')}>{busy ? 'Saving…' : server ? 'Save changes' : mode === 'import' ? 'Import server' : 'Add server'}</button></div>
    </div>
  </form>
}

function Console({ server, lines, onCommand }: { server: ServerView; lines: string[]; onCommand: (command: string) => Promise<void> }) {
  const [command, setCommand] = useState('')
  const [error, setError] = useState('')
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [lines.length])
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!command.trim()) return
    const value = command; setCommand(''); setError('')
    try { await onCommand(value) } catch (reason) { setError((reason as Error).message); setCommand(value) }
  }
  const running = server.status === 'running' || server.status === 'starting'
  return <section className="panel overflow-hidden">
    <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3"><span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-zinc-400"><span className={`h-2 w-2 rounded-full ${running ? 'bg-deck-400 shadow-[0_0_8px_#a3e635]' : 'bg-zinc-600'}`} />Live console</span><button className="text-xs text-zinc-500 hover:text-white" onClick={() => navigator.clipboard.writeText(lines.join('\n'))}>Copy output</button></div>
    <div className="console-lines h-[48vh] min-h-80 overflow-auto bg-[#070708] py-3 font-mono text-[12px] leading-5 text-zinc-300 sm:text-[13px]">
      {!lines.length && <div data-line="" className="px-3 text-zinc-600">Console output will appear here.</div>}
      {lines.map((line, index) => <div key={`${index}-${line}`} data-line={index + 1} className={`whitespace-pre-wrap break-all px-3 hover:bg-white/[.025] ${line.startsWith('MineDeck:') ? 'text-deck-400' : line.startsWith('>') ? 'text-sky-300' : ''}`}>{line}</div>)}
      <div ref={end} />
    </div>
    <form onSubmit={submit} className="border-t border-zinc-800 bg-zinc-900 p-3">
      <div className="flex gap-2"><span className="flex items-center font-mono font-bold text-deck-400">›</span><input className="field flex-1 font-mono" aria-label="Console command" placeholder={running ? 'Enter a Minecraft command…' : 'Start the server to send commands'} disabled={!running} value={command} onChange={(event) => setCommand(event.target.value)} /><button className="btn-primary px-5" disabled={!running}>Send</button></div>
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </form>
  </section>
}

function Files({ server }: { server: ServerView }) {
  const [path, setPath] = useState('')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [file, setFile] = useState('')
  const [content, setContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const dirty = content !== savedContent

  const loadDirectory = async (next: string) => {
    if (dirty && !confirm('Discard unsaved file changes?')) return
    setBusy(true); setError(''); setFile('')
    try {
      const result = await api<{ path: string; entries: FileEntry[] }>(`/api/servers/${server.id}/files?path=${encodeURIComponent(next)}`)
      setPath(next); setEntries(result.entries); setContent(''); setSavedContent('')
    } catch (reason) { setError((reason as Error).message) } finally { setBusy(false) }
  }
  const loadFile = async (name: string) => {
    if (dirty && !confirm('Discard unsaved file changes?')) return
    const target = path ? `${path}/${name}` : name
    setBusy(true); setError('')
    try {
      const result = await api<{ content: string }>(`/api/servers/${server.id}/file?path=${encodeURIComponent(target)}`)
      setFile(target); setContent(result.content); setSavedContent(result.content)
    } catch (reason) { setError((reason as Error).message) } finally { setBusy(false) }
  }
  const save = async () => {
    setBusy(true); setError('')
    try { await api(`/api/servers/${server.id}/file`, { method: 'PUT', body: JSON.stringify({ path: file, content }) }); setSavedContent(content) }
    catch (reason) { setError((reason as Error).message) } finally { setBusy(false) }
  }
  useEffect(() => { setPath(''); setFile(''); setContent(''); setSavedContent(''); void loadDirectory('') }, [server.id])
  const parts = path ? path.split('/') : []
  const parent = parts.slice(0, -1).join('/')
  return <section className="panel overflow-hidden">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 px-4 py-3">
      <div className="flex min-w-0 items-center gap-1 text-sm"><button className="font-semibold text-deck-400 hover:text-deck-300" onClick={() => void loadDirectory('')}>root</button>{parts.map((part, index) => <span key={`${part}-${index}`} className="flex min-w-0 items-center gap-1"><span className="text-zinc-700">/</span><button className="max-w-36 truncate text-zinc-300 hover:text-white" onClick={() => void loadDirectory(parts.slice(0, index + 1).join('/'))}>{part}</button></span>)}</div>
      <span className="text-xs text-zinc-600">Text files up to 2 MB</span>
    </div>
    {error && <div role="alert" className="border-b border-red-900/50 bg-red-950/40 px-4 py-2 text-sm text-red-300">{error}</div>}
    <div className="grid min-h-[56vh] md:grid-cols-[300px_1fr]">
      <div className="max-h-[35vh] overflow-auto border-b border-zinc-800 bg-zinc-950/30 md:max-h-none md:border-b-0 md:border-r">
        {path && <button className="flex w-full items-center gap-3 border-b border-zinc-800/70 px-4 py-3 text-left text-sm text-zinc-400 hover:bg-zinc-800/50 hover:text-white" onClick={() => void loadDirectory(parent)}><span className="text-lg">↰</span><span>Parent folder</span></button>}
        {!busy && !entries.length && <p className="p-5 text-sm text-zinc-600">This folder is empty.</p>}
        {entries.map((entry) => <button key={entry.name} disabled={entry.type === 'link'} className="group flex w-full items-center gap-3 border-b border-zinc-800/60 px-4 py-3 text-left hover:bg-zinc-800/50 disabled:opacity-50" onClick={() => entry.type === 'directory' ? void loadDirectory(path ? `${path}/${entry.name}` : entry.name) : void loadFile(entry.name)}>
          <span className="text-lg">{entry.type === 'directory' ? '▰' : entry.type === 'link' ? '↗' : '▤'}</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-zinc-300 group-hover:text-white">{entry.name}</span><span className="text-[11px] text-zinc-600">{entry.type === 'file' ? formatSize(entry.size) : entry.type}</span></span>
        </button>)}
      </div>
      <div className="flex min-h-96 min-w-0 flex-col bg-[#0b0b0d]">
        {file ? <><div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-4 py-2.5"><span className="min-w-0 truncate font-mono text-xs text-zinc-400">{file}{dirty && <span className="ml-2 text-amber-400">● unsaved</span>}</span><button className="btn-primary min-h-8 px-3 py-1 text-xs" disabled={!dirty || busy} onClick={() => void save()}>Save</button></div><textarea aria-label={`Editing ${file}`} spellCheck={false} className="min-h-96 flex-1 resize-none bg-transparent p-4 font-mono text-[13px] leading-6 text-zinc-200 outline-none" value={content} onChange={(event) => setContent(event.target.value)} /></> : <div className="flex flex-1 items-center justify-center p-10 text-center"><div><div className="text-3xl text-zinc-700">▤</div><p className="mt-3 text-sm text-zinc-500">Select a text file to view and edit it.</p></div></div>}
      </div>
    </div>
  </section>
}

function PasswordForm({ onClose }: { onClose: () => void }) {
  const [currentPassword, setCurrent] = useState('')
  const [newPassword, setNext] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('')
    try { await api('/api/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }); onClose() }
    catch (reason) { setError((reason as Error).message) } finally { setBusy(false) }
  }
  return <form className="space-y-4 p-5 sm:p-6" onSubmit={submit}>
    <label><span className="label">Current password</span><input className="field" type="password" autoComplete="current-password" required value={currentPassword} onChange={(event) => setCurrent(event.target.value)} /></label>
    <label><span className="label">New password</span><input className="field" type="password" autoComplete="new-password" minLength={12} required value={newPassword} onChange={(event) => setNext(event.target.value)} /><span className="mt-1.5 block text-xs text-zinc-600">At least 12 characters.</span></label>
    {error && <div className="rounded-xl bg-red-950/40 p-3 text-sm text-red-300">{error}</div>}
    <div className="flex justify-end gap-2 pt-2"><button type="button" className="btn-muted" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={busy}>{busy ? 'Changing…' : 'Change password'}</button></div>
  </form>
}

function Dashboard({ onLogout }: { onLogout: () => void }) {
  const [servers, setServers] = useState<ServerView[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [tab, setTab] = useState<(typeof tabs)[number]>('console')
  const [logs, setLogs] = useState<Record<string, string[]>>({})
  const [connected, setConnected] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [error, setError] = useState('')
  const [toasts, setToasts] = useState<Toast[]>([])
  const statuses = useRef(new Map<string, ServerStatus>())
  const restarting = useRef(new Set<string>())
  const nextToastId = useRef(0)
  const selected = servers.find((server) => server.id === selectedId)
  const notify = (content: ToastContent, group?: string) => {
    const id = ++nextToastId.current
    setToasts((items) => [...items.filter((item) => !group || item.group !== group), { ...content, id, group }].slice(-4))
    window.setTimeout(() => setToasts((items) => items.filter((item) => item.id !== id)), 5_000)
  }

  useEffect(() => {
    void api<ServerView[]>('/api/servers').then((items) => { statuses.current = new Map(items.map((server) => [server.id, server.status])); setServers(items) }).catch((reason) => setError(reason.message))
  }, [])
  useEffect(() => {
    if (!selectedId || logs[selectedId]) return
    void api<{ lines: string[] }>(`/api/servers/${selectedId}/console`).then(({ lines }) => setLogs((current) => ({ ...current, [selectedId]: lines }))).catch(() => undefined)
  }, [selectedId, logs])
  useEffect(() => {
    let socket: WebSocket | undefined
    let retry: number | undefined
    let active = true
    const connect = () => {
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
      socket.onopen = () => setConnected(true)
      socket.onmessage = ({ data }) => {
        const event = JSON.parse(data) as SocketEvent
        if (event.type === 'servers') {
          for (const server of event.servers) {
            const previous = statuses.current.get(server.id)
            if (previous && previous !== server.status) {
              const notice = statusNotification(server, previous, restarting.current.has(server.id))
              if (notice) notify(notice, `server:${server.id}`)
              if (server.status === 'running' || server.status === 'crashed') restarting.current.delete(server.id)
            }
          }
          statuses.current = new Map(event.servers.map((server) => [server.id, server.status]))
          setServers(event.servers)
        } else setLogs((current) => ({ ...current, [event.serverId]: [...(current[event.serverId] ?? []), event.line].slice(-800) }))
      }
      socket.onclose = () => { setConnected(false); if (active) retry = window.setTimeout(connect, 2_000) }
    }
    connect()
    return () => { active = false; if (retry) clearTimeout(retry); socket?.close() }
  }, [])

  const action = async (name: 'start' | 'stop' | 'restart' | 'kill') => {
    if (!selected) return
    setError('')
    if (name === 'restart') restarting.current.add(selected.id)
    try { await api(`/api/servers/${selected.id}/actions/${name}`, { method: 'POST' }) }
    catch (reason) {
      restarting.current.delete(selected.id)
      const message = (reason as Error).message
      setError(message)
      notify({ tone: 'error', title: 'Action failed', message }, `server:${selected.id}`)
    }
  }
  const logout = async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined); onLogout() }
  const remove = async () => {
    if (!selected || !confirm(`Remove ${selected.name} from MineDeck? Server files will not be deleted.`)) return
    try { await api(`/api/servers/${selected.id}`, { method: 'DELETE' }); setSelectedId('') }
    catch (reason) { setError((reason as Error).message) }
  }
  const select = (id: string) => { setSelectedId(id); setTab('console'); setError('') }

  return <div className="min-h-screen bg-zinc-950 text-zinc-200">
    <Toasts items={toasts} onDismiss={(id) => setToasts((items) => items.filter((item) => item.id !== id))} />
    <aside className="fixed inset-y-0 left-0 z-20 hidden w-72 flex-col border-r border-zinc-800/80 bg-zinc-950 lg:flex">
      <div className="border-b border-zinc-800/80 p-5"><Logo /></div>
      <div className="border-b border-zinc-800/80 p-4">
        {selected ? <div className="rounded-xl bg-zinc-900 p-3"><div className="flex items-center gap-3"><span className={`h-2.5 w-2.5 shrink-0 rounded-full ${statusStyle[selected.status]}`} /><div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold text-white">{selected.name}</div><div className="text-xs text-zinc-500">{prettyStatus(selected.status)}</div></div></div><button className="mt-3 w-full rounded-lg py-2 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-white" onClick={() => select('')}>Change server</button></div> : <div className="rounded-xl border border-dashed border-zinc-800 px-3 py-4 text-center text-sm text-zinc-600">Select a server to continue</div>}
      </div>
      <nav className="flex-1 p-3">
        <div className="flex items-center justify-between px-3 pb-2 pt-1"><span className="text-[11px] font-bold uppercase tracking-[.18em] text-zinc-600">Server</span><span className={`flex items-center gap-1.5 text-[11px] ${connected ? 'text-zinc-600' : 'text-amber-400'}`}><span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-deck-500' : 'bg-amber-400'}`} />{connected ? 'Live' : 'Reconnecting'}</span></div>
        {tabs.map((item) => <button key={item} disabled={!selected} onClick={() => setTab(item)} className={`mb-1 flex w-full items-center rounded-xl border px-4 py-3 text-left text-sm font-semibold capitalize transition ${tab === item && selected ? 'border-zinc-700 bg-zinc-800/80 text-white' : 'border-transparent text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300'}`}>{item}</button>)}
      </nav>
      <div className="space-y-2 border-t border-zinc-800/80 p-3"><button className="btn-primary w-full" onClick={() => setAddOpen(true)}>＋ Add server</button><div className="grid grid-cols-2 gap-2"><button className="rounded-lg py-2 text-xs text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300" onClick={() => setPasswordOpen(true)}>Password</button><button className="rounded-lg py-2 text-xs text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300" onClick={() => void logout()}>Sign out</button></div></div>
    </aside>

    <header className="sticky top-0 z-20 border-b border-zinc-800/80 bg-zinc-950/90 px-4 py-3 backdrop-blur lg:hidden">
      <div className="flex items-center gap-3"><Logo compact /><select aria-label="Select server" className="field min-w-0 flex-1 py-2" value={selectedId} onChange={(event) => select(event.target.value)}><option value="">Select a server</option>{servers.map((server) => <option key={server.id} value={server.id}>{server.name} · {prettyStatus(server.status)}</option>)}</select><button className="h-10 w-10 shrink-0 rounded-xl bg-deck-500 text-xl font-bold text-zinc-950" onClick={() => setAddOpen(true)} aria-label="Add server">＋</button><button className="h-10 w-10 shrink-0 rounded-xl bg-zinc-800 text-lg text-zinc-300" onClick={() => setPasswordOpen(true)} aria-label="Account settings">⚙</button></div>
    </header>

    <main className="min-h-screen lg:ml-72">
      {selected ? <div className="mx-auto max-w-7xl p-4 sm:p-6 lg:p-8">
        <div className="mb-6 flex flex-col justify-between gap-4 xl:flex-row xl:items-start">
          <div className="min-w-0"><div className="flex flex-wrap items-center gap-3"><h1 className="truncate text-2xl font-black tracking-tight text-white sm:text-3xl">{selected.name}</h1><span className="inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1 text-xs font-semibold text-zinc-300"><span className={`h-2 w-2 rounded-full ${statusStyle[selected.status]}`} />{prettyStatus(selected.status)}</span></div><p className="mt-2 truncate font-mono text-xs text-zinc-600">{selected.directory}</p></div>
          <div className="flex flex-wrap gap-2">
            {selected.status === 'stopped' || selected.status === 'crashed' ? <button className="btn-primary" onClick={() => void action('start')}>▶ Start</button> : <><button className="btn-muted" onClick={() => void action('restart')} disabled={selected.status === 'stopping'}>↻ Restart</button><button className="btn-muted" onClick={() => void action('stop')} disabled={selected.status === 'stopping'}>■ Stop</button><button className="btn-danger" onClick={() => confirm('Force-kill this Java process? Unsaved world data may be lost.') && void action('kill')}>Force kill</button></>}
          </div>
        </div>
        {error && <div role="alert" className="mb-5 flex items-center justify-between rounded-xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-300"><span>{error}</span><button className="px-2 text-lg" onClick={() => setError('')}>×</button></div>}
        <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-5">
          <Metric label="Uptime" value={formatUptime(selected.uptimeSeconds)} detail={selected.pid ? `PID ${selected.pid}` : 'Not running'} />
          <Metric label="CPU" value={`${selected.cpuPercent.toFixed(1)}%`} detail="Java process" />
          <Metric label="Memory" value={`${selected.memoryMb.toLocaleString()} MB`} detail={`of ${selected.maxMemoryMb.toLocaleString()} MB`} />
          <Metric label="Players" value={String(selected.onlinePlayers)} detail="Currently online" />
          <Metric label="Crashes" value={String(selected.crashCount)} detail={selected.lastCrashAt ? new Date(selected.lastCrashAt).toLocaleDateString() : 'None recorded'} className="col-span-2 md:col-span-1" />
        </div>
        <div className="mb-4 flex items-center justify-between border-b border-zinc-800 lg:hidden">
          <div className="flex overflow-auto">{tabs.map((item) => <button key={item} className={`border-b-2 px-4 py-3 text-sm font-semibold capitalize transition ${tab === item ? 'border-deck-400 text-white' : 'border-transparent text-zinc-500 hover:text-zinc-300'}`} onClick={() => setTab(item)}>{item}</button>)}</div>
          <span className={`hidden items-center gap-1.5 text-xs sm:flex ${connected ? 'text-zinc-600' : 'text-amber-400'}`}><span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-deck-500' : 'bg-amber-400'}`} />{connected ? 'Live' : 'Reconnecting'}</span>
        </div>
        {tab === 'console' && <Console server={selected} lines={logs[selected.id] ?? []} onCommand={(command) => api(`/api/servers/${selected.id}/command`, { method: 'POST', body: JSON.stringify({ command }) })} />}
        {tab === 'files' && <Files server={selected} />}
        {tab === 'configuration' && <div className="panel overflow-hidden"><div className="border-b border-zinc-800 px-5 py-4"><h2 className="font-bold text-white">Server configuration</h2><p className="mt-1 text-xs text-zinc-500">Stop the server before changing launch settings.</p></div><ServerForm server={selected} onSaved={(saved) => setServers((items) => items.map((item) => item.id === saved.id ? saved : item))} onDelete={() => void remove()} /></div>}
      </div> : servers.length ? <div className="mx-auto max-w-5xl p-6 sm:p-10 lg:p-14"><div className="flex flex-wrap items-end justify-between gap-4"><div><h1 className="text-3xl font-black tracking-tight text-white">Select a server</h1><p className="mt-2 text-sm text-zinc-500">Choose a server before opening its console, files, or configuration.</p></div><button className="btn-primary" onClick={() => setAddOpen(true)}>＋ Add server</button></div><div className="mt-8 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{servers.map((server) => <button key={server.id} onClick={() => select(server.id)} className="panel flex items-center gap-4 p-5 text-left transition hover:border-zinc-600 hover:bg-zinc-800/70"><span className={`h-3 w-3 shrink-0 rounded-full ${statusStyle[server.status]} ${server.status === 'running' ? 'shadow-[0_0_10px_#a3e635]' : ''}`} /><span className="min-w-0 flex-1"><span className="block truncate font-bold text-white">{server.name}</span><span className="mt-1 block text-xs text-zinc-500">{prettyStatus(server.status)}</span></span><span className="text-xl text-zinc-600">›</span></button>)}</div></div> : <div className="flex min-h-screen items-center justify-center p-6"><div className="max-w-sm text-center"><div className="brand-cube mx-auto h-16 w-16 rounded-2xl" /><h1 className="mt-6 text-2xl font-bold text-white">Add your first server</h1><p className="mt-2 text-sm leading-6 text-zinc-500">Point MineDeck at an existing Minecraft server folder to manage it from this dashboard.</p><button className="btn-primary mt-6" onClick={() => setAddOpen(true)}>＋ Add server</button><button className="mt-6 block w-full text-xs text-zinc-600 hover:text-zinc-400 lg:hidden" onClick={() => void logout()}>Sign out</button></div></div>}
    </main>
    {addOpen && <Modal title="Add Minecraft server" onClose={() => setAddOpen(false)}><ServerForm onCancel={() => setAddOpen(false)} onSaved={(server) => { setServers((items) => [...items, server]); setSelectedId(server.id); setAddOpen(false) }} /></Modal>}
    {passwordOpen && <Modal title="Change admin password" onClose={() => setPasswordOpen(false)}><PasswordForm onClose={() => setPasswordOpen(false)} /><div className="border-t border-zinc-800 px-5 py-4 text-center lg:hidden"><button className="text-sm text-red-400" onClick={() => void logout()}>Sign out of MineDeck</button></div></Modal>}
  </div>
}

function Metric({ label, value, detail, className = '' }: { label: string; value: string; detail: string; className?: string }) {
  return <div className={`panel p-4 ${className}`}><div className="text-[10px] font-bold uppercase tracking-[.16em] text-zinc-600">{label}</div><div className="mt-2 truncate text-xl font-bold tabular-nums text-zinc-100">{value}</div><div className="mt-1 truncate text-xs text-zinc-600">{detail}</div></div>
}

export default function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null)
  useEffect(() => { void api<{ authenticated: boolean }>('/api/auth/session').then(({ authenticated }) => setAuthenticated(authenticated)).catch(() => setAuthenticated(false)) }, [])
  if (authenticated === null) return <div className="flex min-h-screen items-center justify-center bg-zinc-950"><div className="brand-cube h-10 w-10 animate-pulse rounded-xl" /></div>
  return authenticated ? <Dashboard onLogout={() => setAuthenticated(false)} /> : <Login onLogin={() => setAuthenticated(true)} />
}
