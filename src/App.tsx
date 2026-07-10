import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { json } from '@codemirror/lang-json'
import { xml } from '@codemirror/lang-xml'
import { yaml } from '@codemirror/lang-yaml'
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { properties } from '@codemirror/legacy-modes/mode/properties'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import type { Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { KeyRound, LogOut, Play, Plus, RotateCcw, Save, Send, Settings, Square, Trash2, Upload, X, Zap } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { FileEntry, ServerStatus, ServerView, SocketEvent } from '../shared.ts'

class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const multipart = typeof FormData !== 'undefined' && init?.body instanceof FormData
  const response = await fetch(path, {
    ...init,
    headers: init?.body && !multipart ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers,
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new ApiError(body.error ?? `Request failed (${response.status})`, response.status)
  return body as T
}

const statusStyle: Record<ServerStatus, string> = {
  running: 'bg-chart-2', starting: 'bg-chart-3', stopping: 'bg-chart-3', crashed: 'bg-destructive', stopped: 'bg-muted-foreground',
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

export const serverFormDisabled = (busy: boolean, status?: ServerStatus) =>
  busy || (status !== undefined && status !== 'stopped' && status !== 'crashed')

export const usesAppleShortcutKeys = (platform: string) => /mac|iphone|ipad|ipod/i.test(platform)
export const shortcutLabel = (key: string, platform: string) => `${usesAppleShortcutKeys(platform) ? '⌘' : 'Ctrl+'}${key.toUpperCase()}`

const browserPlatform = () => {
  if (typeof navigator === 'undefined') return ''
  const browser = navigator as Navigator & { userAgentData?: { platform?: string } }
  return browser.userAgentData?.platform || browser.platform || browser.userAgent
}

const prettyStatus = (status: ServerStatus) => status.charAt(0).toUpperCase() + status.slice(1)
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
    <div className={`${compact ? 'h-8 w-8 rounded-lg' : 'h-10 w-10 rounded-xl'} brand-cube shrink-0`} />
    <div><div className={`${compact ? 'text-lg' : 'text-xl'} font-black tracking-tight text-foreground`}>MineDeck</div>{!compact && <div className="text-[10px] font-bold uppercase tracking-[.22em] text-primary">Server control</div>}</div>
  </div>
}

const toastStyle: Record<ToastTone, { icon: string; border: string; glow: string; bar: string }> = {
  success: { icon: '✓', border: 'border-chart-2/40', glow: 'bg-chart-2/15 text-chart-2', bar: 'bg-chart-2' },
  info: { icon: '↻', border: 'border-chart-5/40', glow: 'bg-chart-5/15 text-chart-5', bar: 'bg-chart-5' },
  warning: { icon: '!', border: 'border-chart-3/40', glow: 'bg-chart-3/15 text-chart-3', bar: 'bg-chart-3' },
  error: { icon: '×', border: 'border-destructive/40', glow: 'bg-destructive/15 text-destructive', bar: 'bg-destructive' },
}

function Toasts({ items, onDismiss }: { items: Toast[]; onDismiss: (id: number) => void }) {
  return <div className="pointer-events-none fixed inset-x-3 top-3 z-[60] flex flex-col items-end gap-3 sm:left-auto sm:right-5 sm:top-5 sm:w-96" aria-live="polite" aria-atomic="true">
    {items.map((toast) => {
      const style = toastStyle[toast.tone]
      return <div key={toast.id} role={toast.tone === 'error' ? 'alert' : 'status'} className={`toast pointer-events-auto relative w-full overflow-hidden rounded-xl border ${style.border} bg-popover/95 p-4 pr-12 text-popover-foreground shadow-md backdrop-blur-xl`}>
        <div className="flex gap-3">
          <span aria-hidden="true" className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl text-lg font-black shadow-[0_0_24px_currentColor] ${style.glow}`}>{style.icon}</span>
          <div className="min-w-0 pt-0.5"><div className="font-bold text-popover-foreground">{toast.title}</div><div className="mt-1 text-sm leading-5 text-muted-foreground">{toast.message}</div></div>
        </div>
        <Button variant="ghost" size="icon-sm" className="absolute right-2 top-2 text-muted-foreground" onClick={() => onDismiss(toast.id)} aria-label="Dismiss notification"><X /></Button>
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
  return <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background p-5">
    <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_15%,rgba(189,147,249,.18),transparent_38%)]" />
    <Card className="relative w-full max-w-sm gap-0 overflow-hidden py-0 shadow-md">
      <CardContent className="p-7 sm:p-9">
        <div className="mb-9"><Logo /><h1 className="mt-8 text-2xl font-bold text-foreground">Welcome back</h1><p className="mt-2 text-sm leading-6 text-muted-foreground">Sign in to manage your Minecraft servers.</p></div>
        <form onSubmit={submit}>
          <Label className="mb-2" htmlFor="password">Admin password</Label>
          <Input id="password" className="h-10" type="password" autoComplete="current-password" autoFocus required value={password} onChange={(event) => setPassword(event.target.value)} />
          {error && <Alert variant="destructive" className="mt-3"><AlertDescription>{error}</AlertDescription></Alert>}
          <Button className="mt-5 w-full" size="lg" disabled={busy}><KeyRound />{busy ? 'Signing in…' : 'Sign in'}</Button>
        </form>
        <p className="mt-6 text-center text-xs text-muted-foreground">Private by default · Session protected</p>
      </CardContent>
    </Card>
  </main>
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 p-0 backdrop-blur-sm sm:items-center sm:p-5" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <div role="dialog" aria-modal="true" aria-label={title} className="max-h-[94vh] w-full max-w-2xl overflow-auto rounded-t-xl border border-border bg-popover text-popover-foreground shadow-md sm:rounded-xl">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-popover/95 px-5 py-4 backdrop-blur">
        <h2 className="font-bold text-popover-foreground">{title}</h2><Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close"><X /></Button>
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
  useEffect(() => {
    setValue(formValue(server))
  }, [server?.id])
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
    {!server && <div className="grid grid-cols-2 gap-2 rounded-lg bg-muted p-1">
      <Button type="button" aria-pressed={mode === 'import'} variant={mode === 'import' ? 'default' : 'ghost'} onClick={() => { setMode('import'); setError('') }}>Import existing</Button>
      <Button type="button" aria-pressed={mode === 'manual'} variant={mode === 'manual' ? 'default' : 'ghost'} onClick={() => { setMode('manual'); setError('') }}>Manual setup</Button>
    </div>}
    <label><span className="label">Server name</span><Input required maxLength={50} value={value.name} onChange={(event) => set('name', event.target.value)} placeholder="Survival" /></label>
    <label><span className="label">Server directory</span><Input className="font-mono" required value={value.directory} onChange={(event) => set('directory', event.target.value)} placeholder="/Users/alex/minecraft/survival" /><span className="mt-1.5 block text-xs text-muted-foreground">{!server && mode === 'import' ? <>The existing folder containing <code>start.bat</code> or a server JAR.</> : <>An existing folder containing the JAR file. <code>~/…</code> is supported.</>}</span></label>
    {(!server && mode === 'manual' || server) && <>
      <div className="grid gap-4 sm:grid-cols-2">
      <label><span className="label">Server JAR</span><Input className="font-mono" required value={value.jar} onChange={(event) => set('jar', event.target.value)} placeholder="server.jar" /></label>
      </div>
    <div className="grid gap-4 sm:grid-cols-3">
      <label><span className="label">Java command</span><Input className="font-mono" required value={value.javaPath} onChange={(event) => set('javaPath', event.target.value)} /></label>
      <label><span className="label">Minimum RAM (MB)</span><Input type="number" min={256} max={65536} required value={value.minMemoryMb} onChange={(event) => set('minMemoryMb', event.target.valueAsNumber)} /></label>
      <label><span className="label">Maximum RAM (MB)</span><Input type="number" min={256} max={65536} required value={value.maxMemoryMb} onChange={(event) => set('maxMemoryMb', event.target.valueAsNumber)} /></label>
    </div>
    <label><span className="label">Extra Java arguments <span className="font-normal text-muted-foreground">(one per line)</span></span><textarea className="field min-h-20 resize-y font-mono" value={value.javaArgs} onChange={(event) => set('javaArgs', event.target.value)} placeholder="-XX:+UseG1GC" /></label>
    <div className="grid gap-4 sm:grid-cols-2">
      <label><span className="label">Graceful stop timeout (seconds)</span><Input type="number" min={5} max={120} required value={value.stopTimeoutSeconds} onChange={(event) => set('stopTimeoutSeconds', event.target.valueAsNumber)} /></label>
      <label className="flex min-h-[68px] items-center gap-3 rounded-lg border border-border bg-muted/30 px-4 py-3">
        <input className="h-4 w-4 accent-primary" type="checkbox" checked={value.autoRestart} onChange={(event) => set('autoRestart', event.target.checked)} />
        <span><span className="block text-sm font-semibold text-foreground">Automatic restart</span><span className="text-xs text-muted-foreground">Restart five seconds after a crash</span></span>
      </label>
    </div>
    </>}
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    <div className="flex flex-wrap justify-between gap-3 border-t border-border pt-5">
      <div>{server && onDelete && <Button type="button" variant="destructive" onClick={onDelete}><Trash2 />Remove server</Button>}</div>
      <div className="flex gap-2">{onCancel && <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>}<Button disabled={serverFormDisabled(busy, server?.status)}><Save />{busy ? 'Saving…' : server ? 'Save changes' : mode === 'import' ? 'Import server' : 'Add server'}</Button></div>
    </div>
  </form>
}

function Console({ server, lines, onCommand }: { server: ServerView; lines: string[]; onCommand: (command: string) => Promise<void> }) {
  const [command, setCommand] = useState('')
  const [error, setError] = useState('')
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [lines.length])
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!command.trim()) return
    const value = command; setCommand(''); setError('')
    try { await onCommand(value) } catch (reason) { setError((reason as Error).message); setCommand(value) }
  }
  const running = server.status === 'running' || server.status === 'starting'
  return <section className="panel overflow-hidden">
    <div className="flex items-center justify-between border-b border-border px-4 py-3"><span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground"><span className={`h-2 w-2 rounded-full ${running ? 'bg-chart-2 shadow-[0_0_8px_#50fa7b]' : 'bg-muted-foreground'}`} />Live console</span><Button variant="ghost" size="xs" onClick={() => navigator.clipboard.writeText(lines.join('\n'))}>Copy output</Button></div>
    <div className="console-lines h-[48vh] min-h-80 overflow-auto bg-sidebar py-3 font-mono text-[12px] leading-5 text-foreground sm:text-[13px]">
      {!lines.length && <div data-line="" className="px-3 text-muted-foreground">Console output will appear here.</div>}
      {lines.map((line, index) => <div key={`${index}-${line}`} data-line={index + 1} className={`whitespace-pre-wrap break-all px-3 hover:bg-white/[.025] ${line.startsWith('MineDeck:') ? 'text-primary' : line.startsWith('>') ? 'text-chart-5' : ''}`}>{line}</div>)}
      <div ref={end} />
    </div>
    <form onSubmit={submit} className="border-t border-border bg-card p-3">
      <div className="flex gap-2"><span className="flex items-center font-mono font-bold text-primary">›</span><Input className="h-10 flex-1 font-mono" aria-label="Console command" placeholder={running ? 'Enter a Minecraft command…' : 'Start the server to send commands'} disabled={!running} value={command} onChange={(event) => setCommand(event.target.value)} /><Button size="lg" disabled={!running}><Send />Send</Button></div>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </form>
  </section>
}

const editorTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: '#21222c', color: '#f8f8f2', fontSize: '13px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: '"Fira Code Variable", "Fira Code", monospace', lineHeight: '1.65', overflow: 'auto' },
  '.cm-content': { padding: '14px 0', caretColor: '#bd93f9' },
  '.cm-line': { padding: '0 18px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#bd93f9' },
  '.cm-gutters': { backgroundColor: '#282a36', color: '#73778e', border: 'none', borderRight: '1px solid #44475a' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 12px 0 10px', minWidth: '44px' },
  '.cm-activeLine': { backgroundColor: '#ffffff08' },
  '.cm-activeLineGutter': { backgroundColor: '#bd93f91a', color: '#bd93f9' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: '#bd93f940' },
  '.cm-foldGutter .cm-gutterElement': { color: '#9ca3af' },
  '.cm-searchMatch': { backgroundColor: '#ffb86c40', outline: '1px solid #ffb86c80' },
  '.cm-panels': { backgroundColor: '#2d2f3b', color: '#f8f8f2' },
}, { dark: true })

const editorHighlighting = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.comment, color: '#6272a4', fontStyle: 'italic' },
  { tag: [tags.propertyName, tags.attributeName, tags.tagName], color: '#8be9fd' },
  { tag: [tags.string, tags.attributeValue], color: '#50fa7b' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: '#ffb86c' },
  { tag: [tags.keyword, tags.modifier, tags.typeName], color: '#ff79c6' },
  { tag: [tags.operator, tags.punctuation, tags.bracket], color: '#bd93f9' },
  { tag: [tags.variableName, tags.name], color: '#f8f8f2' },
  { tag: tags.invalid, color: '#ff5555', textDecoration: 'underline' },
]))

interface EditorLanguage { label: string; extension?: Extension }

const editorLanguages: Record<string, EditorLanguage> = {
  yml: { label: 'YAML', extension: yaml() },
  yaml: { label: 'YAML', extension: yaml() },
  json: { label: 'JSON', extension: json() },
  mcmeta: { label: 'JSON', extension: json() },
  xml: { label: 'XML', extension: xml() },
  properties: { label: 'Properties', extension: StreamLanguage.define(properties) },
  conf: { label: 'Config', extension: StreamLanguage.define(properties) },
  cfg: { label: 'Config', extension: StreamLanguage.define(properties) },
  ini: { label: 'INI', extension: StreamLanguage.define(properties) },
  toml: { label: 'TOML', extension: StreamLanguage.define(toml) },
  sh: { label: 'Shell', extension: StreamLanguage.define(shell) },
  command: { label: 'Shell', extension: StreamLanguage.define(shell) },
}

const languageFor = (name: string): EditorLanguage => editorLanguages[name.split('.').pop()?.toLowerCase() ?? ''] ?? { label: 'Plain text' }
const fileTone = (name: string) => {
  const extension = name.split('.').pop()?.toLowerCase()
  if (extension === 'yml' || extension === 'yaml') return 'border-chart-1/30 bg-chart-1/10 text-chart-1'
  if (extension === 'json' || extension === 'mcmeta') return 'border-chart-3/30 bg-chart-3/10 text-chart-3'
  if (extension === 'properties' || extension === 'conf' || extension === 'cfg' || extension === 'ini') return 'border-chart-5/30 bg-chart-5/10 text-chart-5'
  if (extension === 'jar') return 'border-chart-4/30 bg-chart-4/10 text-chart-4'
  return 'border-border bg-muted/70 text-muted-foreground'
}

function FileGlyph({ entry }: { entry: FileEntry }) {
  if (entry.type === 'directory') return <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-primary/20 bg-primary/10 text-primary">◆</span>
  if (entry.type === 'link') return <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-border bg-muted text-muted-foreground">↗</span>
  return <span aria-hidden="true" className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg border text-sm ${fileTone(entry.name)}`}>▤</span>
}

function Files({ server }: { server: ServerView }) {
  const [path, setPath] = useState('')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [file, setFile] = useState('')
  const [content, setContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [dragging, setDragging] = useState(false)
  const [cursor, setCursor] = useState({ line: 1, column: 1 })
  const uploadInput = useRef<HTMLInputElement>(null)
  const saveShortcut = useRef<() => boolean>(() => true)
  const platform = useMemo(browserPlatform, [])
  const dirty = content !== savedContent
  const language = languageFor(file)
  const saveKeymap = useMemo(() => keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => saveShortcut.current() }]), [])
  const editorExtensions = useMemo(() => [editorTheme, editorHighlighting, saveKeymap, ...(language.extension ? [language.extension] : [])], [language.extension, saveKeymap])

  const getDirectory = (next: string) => api<{ path: string; entries: FileEntry[] }>(`/api/servers/${server.id}/files?path=${encodeURIComponent(next)}`)
  const loadDirectory = async (next: string) => {
    if (dirty && !confirm('Discard unsaved file changes?')) return
    setBusy('Browsing…'); setError(''); setNotice(''); setFile('')
    try {
      const result = await getDirectory(next)
      setPath(result.path); setEntries(result.entries); setContent(''); setSavedContent(''); setCursor({ line: 1, column: 1 })
    } catch (reason) { setError((reason as Error).message) } finally { setBusy('') }
  }
  const loadFile = async (name: string) => {
    if (dirty && !confirm('Discard unsaved file changes?')) return
    const target = path ? `${path}/${name}` : name
    setBusy('Opening…'); setError(''); setNotice('')
    try {
      const result = await api<{ content: string }>(`/api/servers/${server.id}/file?path=${encodeURIComponent(target)}`)
      setFile(target); setContent(result.content); setSavedContent(result.content); setCursor({ line: 1, column: 1 })
    } catch (reason) { setError((reason as Error).message) } finally { setBusy('') }
  }
  const save = async () => {
    if (!file || !dirty) return
    setBusy('Saving…'); setError(''); setNotice('')
    try {
      await api(`/api/servers/${server.id}/file`, { method: 'PUT', body: JSON.stringify({ path: file, content }) })
      setSavedContent(content); setNotice('Changes saved.')
    } catch (reason) { setError((reason as Error).message) } finally { setBusy('') }
  }
  saveShortcut.current = () => {
    if (file && dirty && !busy) void save()
    return true
  }
  const upload = async (files: File[]) => {
    if (!files.length) return
    if (files.length > 20) { setError('Upload up to 20 files at a time.'); return }
    const tooLarge = files.find((item) => item.size > 512 * 1024 * 1024)
    if (tooLarge) { setError(`${tooLarge.name} is larger than 512 MB.`); return }
    const form = new FormData()
    files.forEach((item) => form.append('files', item, item.name))
    setBusy(`Uploading ${files.length}…`); setError(''); setNotice('')
    try {
      const result = await api<{ uploaded: string[] }>(`/api/servers/${server.id}/files/upload?path=${encodeURIComponent(path)}`, { method: 'POST', body: form })
      setEntries((await getDirectory(path)).entries)
      setNotice(`${result.uploaded.length} ${result.uploaded.length === 1 ? 'file' : 'files'} uploaded.`)
    } catch (reason) {
      setError((reason as Error).message)
      const refreshed = await getDirectory(path).catch(() => undefined)
      if (refreshed) setEntries(refreshed.entries)
    } finally { setBusy('') }
  }
  const deleteFile = async (name: string, target: string) => {
    const warning = target === file && dirty ? ' Unsaved editor changes will also be lost.' : ''
    if (!confirm(`Move “${name}” to the hosted machine’s recycle bin?${warning}`)) return
    setBusy('Moving to recycle bin…'); setError(''); setNotice('')
    try {
      await api(`/api/servers/${server.id}/file`, { method: 'DELETE', body: JSON.stringify({ path: target }) })
      setEntries((await getDirectory(path)).entries)
      if (target === file) { setFile(''); setContent(''); setSavedContent(''); setCursor({ line: 1, column: 1 }) }
      setNotice(`${name} was moved to the hosted machine’s recycle bin.`)
    } catch (reason) { setError((reason as Error).message) } finally { setBusy('') }
  }

  useEffect(() => {
    setPath(''); setFile(''); setContent(''); setSavedContent(''); setNotice(''); setError('')
    void loadDirectory('')
  }, [server.id])

  const parts = path ? path.split('/') : []
  const parent = parts.slice(0, -1).join('/')
  const activeName = file.split('/').pop() ?? ''
  const lineCount = content.split('\n').length
  const bytes = new TextEncoder().encode(content).byteLength

  return <section className="panel overflow-hidden" aria-busy={Boolean(busy)}>
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-card/70 px-4 py-3">
      <div className="flex min-w-0 items-center gap-1 text-sm"><button className="font-semibold text-primary hover:text-primary/80" onClick={() => void loadDirectory('')}>root</button>{parts.map((part, index) => <span key={`${part}-${index}`} className="flex min-w-0 items-center gap-1"><span className="text-muted-foreground">/</span><button className="max-w-36 truncate text-foreground/80 hover:text-foreground" onClick={() => void loadDirectory(parts.slice(0, index + 1).join('/'))}>{part}</button></span>)}</div>
      <div className="flex items-center gap-3">
        <span className="hidden text-xs text-muted-foreground sm:inline">Upload up to 512 MB per file</span>
        <input ref={uploadInput} className="hidden" type="file" multiple onChange={(event) => { void upload(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = '' }} />
        <Button variant="outline" size="sm" disabled={Boolean(busy)} onClick={() => uploadInput.current?.click()}><Upload />{busy.startsWith('Uploading') ? busy : 'Upload files'}</Button>
      </div>
    </div>
    {error && <div role="alert" className="border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>}
    {notice && <div role="status" className="border-b border-primary/20 bg-primary/5 px-4 py-2 text-sm text-primary">✓ {notice}</div>}
    <div className="grid min-h-[62vh] md:grid-cols-[320px_minmax(0,1fr)]">
      <div
        className="relative max-h-[38vh] overflow-auto border-b border-border bg-sidebar/50 md:max-h-none md:border-b-0 md:border-r"
        onDragOver={(event) => { event.preventDefault(); if (event.dataTransfer.types.includes('Files')) setDragging(true) }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false) }}
        onDrop={(event) => { event.preventDefault(); setDragging(false); void upload(Array.from(event.dataTransfer.files)) }}
      >
        {dragging && <div className="absolute inset-2 z-10 grid place-items-center rounded-xl border-2 border-dashed border-primary bg-sidebar/95 p-5 text-center text-sm font-semibold text-primary">Drop files into {path || 'root'}</div>}
        {path && <button disabled={Boolean(busy)} className="flex w-full items-center gap-3 border-b border-border/70 px-4 py-3 text-left text-sm text-muted-foreground hover:bg-muted/50 hover:text-foreground disabled:opacity-50" onClick={() => void loadDirectory(parent)}><span className="text-lg">↰</span><span>Parent folder</span></button>}
        {!busy && !entries.length && <p className="p-5 text-sm text-muted-foreground">This folder is empty. Upload a file or drop one here.</p>}
        {entries.map((entry) => {
          const target = path ? `${path}/${entry.name}` : entry.name
          const selected = target === file
          return <div key={entry.name} className={`group flex items-center border-b border-border/60 transition ${selected ? 'bg-primary/10' : 'hover:bg-muted/50'}`}>
            <button disabled={entry.type === 'link' || Boolean(busy)} className="flex min-w-0 flex-1 items-center gap-3 px-4 py-2.5 text-left disabled:opacity-50" onClick={() => entry.type === 'directory' ? void loadDirectory(target) : void loadFile(entry.name)}>
              <FileGlyph entry={entry} /><span className="min-w-0 flex-1"><span className={`block truncate text-sm font-medium ${selected ? 'text-primary' : 'text-foreground/80 group-hover:text-foreground'}`}>{entry.name}</span><span className="text-[11px] text-muted-foreground">{entry.type === 'file' ? formatSize(entry.size) : entry.type}</span></span>
            </button>
            {entry.type === 'file' && <Button variant="ghost" size="icon-sm" className="mr-2 text-muted-foreground opacity-100 hover:text-destructive md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100" disabled={Boolean(busy)} onClick={() => void deleteFile(entry.name, target)} aria-label={`Move ${entry.name} to recycle bin`} title="Move to recycle bin"><Trash2 /></Button>}
          </div>
        })}
      </div>
      <div className="flex min-h-[32rem] min-w-0 flex-col bg-sidebar">
        {file ? <>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-sidebar px-3 py-2.5 sm:px-4">
            <div className="flex min-w-0 items-center gap-2"><span className={`grid h-7 w-7 shrink-0 place-items-center rounded-md border text-xs ${fileTone(activeName)}`}>▤</span><span className="min-w-0 truncate font-mono text-xs font-semibold text-foreground/80">{activeName}</span><Badge variant="outline" className="rounded-md text-[10px] uppercase tracking-wider">{language.label}</Badge>{dirty && <span className="text-xs text-chart-3">● Unsaved</span>}</div>
            <div className="flex items-center gap-2"><Button variant="destructive" size="sm" disabled={Boolean(busy)} onClick={() => void deleteFile(activeName, file)}><Trash2 />Recycle</Button><Button size="sm" disabled={!dirty || Boolean(busy)} onClick={() => void save()} title={`Save (${shortcutLabel('S', platform)})`}><Save />{busy === 'Saving…' ? busy : 'Save'} <span className="hidden font-normal opacity-60 sm:inline">{shortcutLabel('S', platform)}</span></Button></div>
          </div>
          <div className="file-editor min-h-0 flex-1 overflow-hidden">
            <CodeMirror
              aria-label={`Editing ${file}`}
              value={content}
              height="100%"
              theme="none"
              extensions={editorExtensions}
              basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true, highlightActiveLineGutter: true, bracketMatching: true, closeBrackets: true, autocompletion: false, tabSize: 2 }}
              indentWithTab
              onChange={setContent}
              onUpdate={(update) => {
                const position = update.state.selection.main.head
                const line = update.state.doc.lineAt(position)
                const next = { line: line.number, column: position - line.from + 1 }
                setCursor((current) => current.line === next.line && current.column === next.column ? current : next)
              }}
            />
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-border bg-sidebar px-4 py-1.5 font-mono text-[10px] text-muted-foreground"><span>Ln {cursor.line}, Col {cursor.column}</span><span className="hidden lg:inline">{shortcutLabel('S', platform)} save · {shortcutLabel('F', platform)} find · {shortcutLabel('Z', platform)} undo</span><span>{lineCount} {lineCount === 1 ? 'line' : 'lines'} · {formatSize(bytes)} · UTF-8</span></div>
        </> : <div className="flex flex-1 items-center justify-center p-10 text-center"><div><div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-border bg-card text-2xl text-muted-foreground">▤</div><p className="mt-4 text-sm font-medium text-foreground/80">Choose a text or config file</p><p className="mt-1 text-xs leading-5 text-muted-foreground">YAML, JSON, properties, TOML, XML, and shell files<br className="hidden sm:block" /> get automatic syntax colours.</p></div></div>}
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
    <label><span className="label">Current password</span><Input type="password" autoComplete="current-password" required value={currentPassword} onChange={(event) => setCurrent(event.target.value)} /></label>
    <label><span className="label">New password</span><Input type="password" autoComplete="new-password" minLength={12} required value={newPassword} onChange={(event) => setNext(event.target.value)} /><span className="mt-1.5 block text-xs text-muted-foreground">At least 12 characters.</span></label>
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    <div className="flex justify-end gap-2 pt-2"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button disabled={busy}><KeyRound />{busy ? 'Changing…' : 'Change password'}</Button></div>
  </form>
}

function Dashboard({ onLogout }: { onLogout: () => void }) {
  const [servers, setServers] = useState<ServerView[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [tab, setTab] = useState<'console' | 'files' | 'configuration'>('console')
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
    void api<ServerView[]>('/api/servers').then((items) => { statuses.current = new Map(items.map((server) => [server.id, server.status])); setServers(items); setSelectedId((id) => id || items[0]?.id || '') }).catch((reason) => setError(reason.message))
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
          setSelectedId((id) => id || event.servers[0]?.id || '')
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
    try { await api(`/api/servers/${selected.id}`, { method: 'DELETE' }); setSelectedId(servers.find((item) => item.id !== selected.id)?.id ?? '') }
    catch (reason) { setError((reason as Error).message) }
  }
  const select = (id: string) => { setSelectedId(id); setTab('console'); setError('') }

  return <div className="min-h-screen bg-background text-foreground">
    <Toasts items={toasts} onDismiss={(id) => setToasts((items) => items.filter((item) => item.id !== id))} />
    <aside className="fixed inset-y-0 left-0 z-20 hidden w-72 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground lg:flex">
      <div className="border-b border-sidebar-border p-5"><Logo /></div>
      <div className="flex items-center justify-between px-5 pb-2 pt-5"><span className="text-[11px] font-bold uppercase tracking-[.18em] text-muted-foreground">Your servers</span><Badge variant="secondary">{servers.length}</Badge></div>
      <nav className="flex-1 overflow-auto p-3">
        {servers.map((server) => <button key={server.id} onClick={() => select(server.id)} className={`mb-1 flex w-full items-center gap-3 rounded-lg border px-3 py-3 text-left transition ${server.id === selectedId ? 'border-sidebar-border bg-sidebar-accent text-sidebar-accent-foreground' : 'border-transparent hover:bg-sidebar-accent/50'}`}>
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${statusStyle[server.status]} ${server.status === 'running' ? 'shadow-[0_0_10px_#50fa7b]' : ''}`} />
          <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{server.name}</span><span className="text-xs text-muted-foreground">{prettyStatus(server.status)}</span></span>
          <span className="text-muted-foreground">›</span>
        </button>)}
        {!servers.length && <p className="px-3 py-8 text-center text-sm leading-6 text-muted-foreground">No servers yet.<br />Add your first one below.</p>}
      </nav>
      <div className="space-y-2 border-t border-sidebar-border p-3"><Button className="w-full" size="lg" onClick={() => setAddOpen(true)}><Plus />Add server</Button><div className="grid grid-cols-2 gap-2"><Button variant="ghost" size="sm" onClick={() => setPasswordOpen(true)}><KeyRound />Password</Button><Button variant="ghost" size="sm" onClick={() => void logout()}><LogOut />Sign out</Button></div></div>
    </aside>

    <header className="sticky top-0 z-20 border-b border-border bg-background/90 px-4 py-3 backdrop-blur lg:hidden">
      <div className="flex items-center gap-3"><Logo compact /><select aria-label="Select server" className="field min-w-0 flex-1 py-2" value={selectedId} onChange={(event) => select(event.target.value)}><option value="">Select a server</option>{servers.map((server) => <option key={server.id} value={server.id}>{server.name} · {prettyStatus(server.status)}</option>)}</select><Button size="icon-lg" onClick={() => setAddOpen(true)} aria-label="Add server"><Plus /></Button><Button variant="outline" size="icon-lg" onClick={() => setPasswordOpen(true)} aria-label="Account settings"><Settings /></Button></div>
    </header>

    <main className="min-h-screen lg:ml-72">
      {selected ? <div className="mx-auto max-w-7xl p-4 sm:p-6 lg:p-8">
        <div className="mb-6 flex flex-col justify-between gap-4 xl:flex-row xl:items-start">
          <div className="min-w-0"><div className="flex flex-wrap items-center gap-3"><h1 className="truncate text-2xl font-black tracking-tight text-foreground sm:text-3xl">{selected.name}</h1><Badge variant="outline" className="gap-2 px-3 py-1"><span className={`h-2 w-2 rounded-full ${statusStyle[selected.status]}`} />{prettyStatus(selected.status)}</Badge></div><p className="mt-2 truncate font-mono text-xs text-muted-foreground">{selected.directory}</p></div>
          <div className="flex flex-wrap gap-2">
            {selected.status === 'stopped' || selected.status === 'crashed' ? <Button onClick={() => void action('start')}><Play />Start</Button> : <><Button variant="outline" onClick={() => void action('restart')} disabled={selected.status === 'stopping'}><RotateCcw />Restart</Button><Button variant="outline" onClick={() => void action('stop')} disabled={selected.status === 'stopping'}><Square />Stop</Button><Button variant="destructive" onClick={() => confirm('Force-kill this Java process? Unsaved world data may be lost.') && void action('kill')}><Zap />Force kill</Button></>}
          </div>
        </div>
        {error && <Alert variant="destructive" className="mb-5 grid-cols-[1fr_auto] items-center"><AlertDescription className="col-start-1">{error}</AlertDescription><Button variant="ghost" size="icon-sm" className="col-start-2 text-destructive" onClick={() => setError('')} aria-label="Dismiss error"><X /></Button></Alert>}
        <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-5">
          <Metric label="Uptime" value={formatUptime(selected.uptimeSeconds)} detail={selected.pid ? `PID ${selected.pid}` : 'Not running'} />
          <Metric label="CPU" value={`${selected.cpuPercent.toFixed(1)}%`} detail="Java process" />
          <Metric label="Memory" value={`${selected.memoryMb.toLocaleString()} MB`} detail={`of ${selected.maxMemoryMb.toLocaleString()} MB`} />
          <Metric label="Players" value={String(selected.onlinePlayers)} detail="Currently online" />
          <Metric label="Crashes" value={String(selected.crashCount)} detail={selected.lastCrashAt ? new Date(selected.lastCrashAt).toLocaleDateString() : 'None recorded'} className="col-span-2 md:col-span-1" />
        </div>
        <div className="mb-4 flex items-center justify-between border-b border-border">
          <div className="flex overflow-auto">{(['console', 'files', 'configuration'] as const).map((item) => <button key={item} className={`border-b-2 px-4 py-3 text-sm font-semibold capitalize transition ${tab === item ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`} onClick={() => setTab(item)}>{item}</button>)}</div>
          <span className={`hidden items-center gap-1.5 text-xs sm:flex ${connected ? 'text-muted-foreground' : 'text-chart-3'}`}><span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-chart-2' : 'bg-chart-3'}`} />{connected ? 'Live' : 'Reconnecting'}</span>
        </div>
        {tab === 'console' && <Console server={selected} lines={logs[selected.id] ?? []} onCommand={(command) => api(`/api/servers/${selected.id}/command`, { method: 'POST', body: JSON.stringify({ command }) })} />}
        {tab === 'files' && <Files server={selected} />}
        {tab === 'configuration' && <Card className="gap-0 overflow-hidden py-0"><div className="border-b border-border px-5 py-4"><h2 className="font-bold text-card-foreground">Server configuration</h2><p className="mt-1 text-xs text-muted-foreground">Stop the server before changing launch settings.</p></div><ServerForm server={selected} onSaved={(saved) => setServers((items) => items.map((item) => item.id === saved.id ? saved : item))} onDelete={() => void remove()} /></Card>}
      </div> : <div className="flex min-h-screen items-center justify-center p-6"><div className="max-w-sm text-center"><div className="brand-cube mx-auto h-16 w-16 rounded-2xl" /><h1 className="mt-6 text-2xl font-bold text-foreground">Add your first server</h1><p className="mt-2 text-sm leading-6 text-muted-foreground">Point MineDeck at an existing Minecraft server folder to manage it from this dashboard.</p><Button className="mt-6" size="lg" onClick={() => setAddOpen(true)}><Plus />Add server</Button><Button variant="ghost" className="mt-6 w-full lg:hidden" size="sm" onClick={() => void logout()}><LogOut />Sign out</Button></div></div>}
    </main>
    {addOpen && <Modal title="Add Minecraft server" onClose={() => setAddOpen(false)}><ServerForm onCancel={() => setAddOpen(false)} onSaved={(server) => { setServers((items) => [...items, server]); setSelectedId(server.id); setAddOpen(false) }} /></Modal>}
    {passwordOpen && <Modal title="Change admin password" onClose={() => setPasswordOpen(false)}><PasswordForm onClose={() => setPasswordOpen(false)} /><div className="border-t border-border px-5 py-4 text-center lg:hidden"><Button variant="ghost" className="text-destructive" onClick={() => void logout()}><LogOut />Sign out of MineDeck</Button></div></Modal>}
  </div>
}

function Metric({ label, value, detail, className = '' }: { label: string; value: string; detail: string; className?: string }) {
  return <Card className={`gap-0 p-4 ${className}`}><div className="text-[10px] font-bold uppercase tracking-[.16em] text-muted-foreground">{label}</div><div className="mt-2 truncate text-xl font-bold tabular-nums text-card-foreground">{value}</div><div className="mt-1 truncate text-xs text-muted-foreground">{detail}</div></Card>
}

export default function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null)
  useEffect(() => { void api<{ authenticated: boolean }>('/api/auth/session').then(({ authenticated }) => setAuthenticated(authenticated)).catch(() => setAuthenticated(false)) }, [])
  if (authenticated === null) return <div className="flex min-h-screen items-center justify-center bg-background"><div className="brand-cube h-10 w-10 animate-pulse rounded-xl" /></div>
  return authenticated ? <Dashboard onLogout={() => setAuthenticated(false)} /> : <Login onLogin={() => setAuthenticated(true)} />
}
