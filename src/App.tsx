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
import { Ban, CheckCircle2, CircleX, Copy, Info, KeyRound, LogOut, Play, Plus, RefreshCw, RotateCcw, Save, Search, Send, Settings, Shield, ShieldOff, Square, Trash2, TriangleAlert, Upload, Users, UserX, X, Zap } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { consoleLineTokens } from '@/lib/console'
import type { FileEntry, PaperBuild, PlayerAction, PlayerView, ServerStatus, ServerView, SocketEvent } from '../shared.ts'

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

const wait = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds))

async function waitUntilServerStops(id: string, timeoutMilliseconds: number) {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    const servers = await api<ServerView[]>('/api/servers')
    const server = servers.find((item) => item.id === id)
    if (!server || server.status === 'stopped' || server.status === 'crashed') return
    await wait(750)
  }
  throw new ApiError('The server did not stop in time. Try removing it again once it is stopped.', 409)
}

const statusStyle: Record<ServerStatus, string> = {
  running: 'bg-chart-2', starting: 'bg-chart-3', stopping: 'bg-chart-3', crashed: 'bg-destructive', stopped: 'bg-muted-foreground',
}

type ToastTone = 'success' | 'info' | 'warning' | 'error'
interface Toast { id: number; group?: string; tone: ToastTone; title: string; message: string }
type ToastContent = Omit<Toast, 'id' | 'group'>

export function statusNotification(server: Pick<ServerView, 'name' | 'status' | 'autoRestart'>, previous: ServerStatus, restarting = false): ToastContent | undefined {
  if (server.status === previous) return
  if (server.status === 'starting') return { tone: 'info', title: restarting || previous === 'crashed' ? 'Restarting server' : 'Starting server', message: `${server.name} is starting up.` }
  if (server.status === 'running') return { tone: 'success', title: 'Server online', message: `${server.name} is ready for players.` }
  if (server.status === 'stopping') return { tone: 'warning', title: restarting ? 'Restarting server' : 'Stopping server', message: `${server.name} is saving before shutdown.` }
  if (server.status === 'stopped') return restarting
    ? { tone: 'info', title: 'Restarting server', message: `${server.name} stopped and will start again.` }
    : { tone: 'success', title: 'Server stopped', message: `${server.name} shut down safely.` }
  return { tone: 'error', title: 'Server crashed', message: `${server.name} exited unexpectedly.${server.autoRestart ? ' Automatic restart scheduled.' : ''}` }
}

export const serverFormDisabled = (busy: boolean, status?: ServerStatus) =>
  busy || (status !== undefined && status !== 'stopped' && status !== 'crashed')

export const usesAppleShortcutKeys = (platform: string) => /mac|iphone|ipad|ipod/i.test(platform)
export const shortcutLabel = (key: string, platform: string) => `${usesAppleShortcutKeys(platform) ? '⌘' : 'Ctrl+'}${key.toUpperCase()}`

interface ConsoleHistoryState {
  command: string
  index: number | null
  draft: string
}

export function navigateConsoleHistory(
  history: string[],
  current: ConsoleHistoryState,
  direction: 'up' | 'down',
): ConsoleHistoryState {
  if (!history.length || (direction === 'down' && current.index === null)) return current
  if (direction === 'up') {
    const index = current.index === null ? history.length - 1 : Math.max(0, current.index - 1)
    return { command: history[index]!, index, draft: current.index === null ? current.command : current.draft }
  }
  const index = current.index! + 1
  return index >= history.length
    ? { command: current.draft, index: null, draft: '' }
    : { command: history[index]!, index, draft: current.draft }
}

const browserPlatform = () => {
  if (typeof navigator === 'undefined') return ''
  const browser = navigator as Navigator & { userAgentData?: { platform?: string } }
  return browser.userAgentData?.platform || browser.platform || browser.userAgent
}

export const appThemes = [
  { id: 'dracula', name: 'Dracula' },
  { id: 'tiesen', name: 'Tiesen' },
  { id: 'portfolio', name: 'Portfolio' },
  { id: '2077', name: '2077' },
  { id: 'nlan', name: 'NLAN' },
  { id: 'discord', name: 'Discord' },
  { id: 'terminal', name: 'Iconic Terminal' },
] as const
type AppTheme = (typeof appThemes)[number]['id']
export const isAppTheme = (value: unknown): value is AppTheme => appThemes.some((theme) => theme.id === value)
const storedTheme = (): AppTheme => {
  try {
    const value = localStorage.getItem('minedeck-theme')
    return isAppTheme(value) ? value : 'dracula'
  } catch { return 'dracula' }
}

const prettyStatus = (status: ServerStatus) => status.charAt(0).toUpperCase() + status.slice(1)
const tabs = ['console', 'players', 'files', 'configuration'] as const
const serverIdFromPath = () => {
  const match = window.location.pathname.match(/^\/servers\/([^/]+)\/?$/)
  if (!match) return ''
  try { return decodeURIComponent(match[1]!) } catch { return '' }
}
const formatUptime = (seconds: number) => {
  if (!seconds) return '—'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor(seconds % 86400 / 3600)
  const minutes = Math.floor(seconds % 3600 / 60)
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m ${seconds % 60}s`
}
const formatSize = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`

const METRIC_WINDOW_MS = 5 * 60_000
const METRIC_SAMPLE_INTERVAL_MS = 750
interface MetricSample { at: number; cpuPercent: number; memoryMb: number }
type MetricHistory = Record<string, MetricSample[]>

export function appendMetricHistory(current: MetricHistory, servers: ServerView[], now = Date.now()): MetricHistory {
  const liveIds = new Set(servers.map((server) => server.id))
  const next: MetricHistory = {}
  for (const server of servers) {
    const samples = (current[server.id] ?? []).filter((sample) => sample.at >= now - METRIC_WINDOW_MS)
    const sample = { at: now, cpuPercent: server.cpuPercent, memoryMb: server.memoryMb }
    const previous = samples.at(-1)
    next[server.id] = previous && now - previous.at < METRIC_SAMPLE_INTERVAL_MS
      ? [...samples.slice(0, -1), { ...sample, at: previous.at }]
      : [...samples, sample]
  }
  for (const id of Object.keys(current)) if (!liveIds.has(id)) delete next[id]
  return next
}

function Logo({ compact = false }: { compact?: boolean }) {
  return <div className="flex items-center gap-3">
    <svg aria-hidden="true" viewBox="0 0 48 48" className={`brand-mark ${compact ? 'h-8 w-8' : 'h-10 w-10'} shrink-0 text-foreground`}>
      <path d="m27.2 14.1 6.1 4.1-16.9 25.1-6.1-4.1 16.9-25.1Z" fill="currentColor" />
      <path d="M6.8 11.7C15.4 4.1 29.8 3.6 41.3 12l-3.5 5.1c-8.2-5.7-17.5-6-25.9-.2l-5.1-5.2Z" fill="currentColor" />
    </svg>
    <div className="leading-none"><div className={`${compact ? 'text-lg' : 'text-xl'} font-black tracking-tight text-foreground`}>MINEDECK</div><div className={`${compact ? 'mt-0.5 text-[8px]' : 'mt-1 text-[10px]'} bg-gradient-to-r from-primary to-chart-4 bg-clip-text font-black tracking-[.3em] text-transparent`}>REMOTE</div></div>
  </div>
}

const toastStyle: Record<ToastTone, { icon: ReactNode; accent: string; iconStyle: string }> = {
  success: { icon: <CheckCircle2 />, accent: 'bg-chart-2', iconStyle: 'bg-chart-2/10 text-chart-2' },
  info: { icon: <Info />, accent: 'bg-chart-5', iconStyle: 'bg-chart-5/10 text-chart-5' },
  warning: { icon: <TriangleAlert />, accent: 'bg-chart-3', iconStyle: 'bg-chart-3/10 text-chart-3' },
  error: { icon: <CircleX />, accent: 'bg-destructive', iconStyle: 'bg-destructive/10 text-destructive' },
}

function Toasts({ items, onDismiss }: { items: Toast[]; onDismiss: (id: number) => void }) {
  return <div className="pointer-events-none fixed inset-x-3 top-3 z-[60] flex flex-col items-end gap-2 sm:left-auto sm:right-4 sm:top-4 sm:w-[22rem]">
    {items.map((toast) => {
      const style = toastStyle[toast.tone]
      return <div key={toast.id} role={toast.tone === 'error' ? 'alert' : 'status'} aria-atomic="true" className="toast pointer-events-auto relative w-full overflow-hidden rounded-lg border border-border/80 bg-popover/95 p-3 pr-10 text-popover-foreground shadow-lg backdrop-blur-xl">
        <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-1 ${style.accent}`} />
        <div className="flex items-start gap-2.5 pl-1">
          <span aria-hidden="true" className={`grid size-8 shrink-0 place-items-center rounded-lg [&_svg]:size-4 ${style.iconStyle}`}>{style.icon}</span>
          <div className="min-w-0 pt-px"><div className="text-sm font-semibold leading-5 text-popover-foreground">{toast.title}</div><div className="mt-0.5 text-xs leading-[1.125rem] text-muted-foreground">{toast.message}</div></div>
        </div>
        <Button variant="ghost" size="icon-xs" className="absolute right-2 top-2 text-muted-foreground/70 hover:text-foreground" onClick={() => onDismiss(toast.id)} aria-label="Dismiss notification"><X /></Button>
      </div>
    })}
  </div>
}

function Login({ onLogin, theme, onThemeChange }: { onLogin: () => void; theme: AppTheme; onThemeChange: (theme: AppTheme) => void }) {
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
  return <div className="flex min-h-screen flex-col bg-background text-foreground">
    <main className="relative flex flex-1 items-center justify-center overflow-hidden p-5">
      <div className="login-glow pointer-events-none absolute inset-0" />
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
    <ThemeFooter selected={theme} onChange={onThemeChange} />
  </div>
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

function ConfirmationModal({ title, message, confirmLabel, busyLabel, busy, onConfirm, onClose }: {
  title: string
  message: ReactNode
  confirmLabel: string
  busyLabel: string
  busy: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return <Modal title={title} onClose={() => { if (!busy) onClose() }}>
    <div className="space-y-5 p-5 sm:p-6">
      <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4">
        <TriangleAlert className="mt-0.5 size-5 shrink-0 text-destructive" />
        <p className="text-sm leading-6 text-foreground/90">{message}</p>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button variant="destructive" disabled={busy} onClick={onConfirm}><Trash2 />{busy ? busyLabel : confirmLabel}</Button>
      </div>
    </div>
  </Modal>
}

interface ServerFormValue {
  name: string; directory: string; jar: string; javaPath: string; minMemoryMb: number; maxMemoryMb: number; javaArgs: string; autoRestart: boolean; stopTimeoutSeconds: number
}

const RAM_SLIDER_DEFAULT_MAX_MB = 24 * 1024
export const memoryForMaximum = (minMemoryMb: number, maxMemoryMb: number) => ({
  minMemoryMb: Math.min(minMemoryMb, maxMemoryMb),
  maxMemoryMb,
})
const formatMemoryMb = (memoryMb: number) => memoryMb < 1024
  ? `${memoryMb} MB`
  : `${Number((memoryMb / 1024).toFixed(2))} GB`

const formValue = (server?: ServerView): ServerFormValue => ({
  name: server?.name ?? '', directory: server?.directory ?? '', jar: server?.jar ?? 'server.jar', javaPath: server?.javaPath ?? 'java',
  minMemoryMb: server?.minMemoryMb ?? 1024, maxMemoryMb: server?.maxMemoryMb ?? 2048, javaArgs: server?.javaArgs.join('\n') ?? '',
  autoRestart: server?.autoRestart ?? true, stopTimeoutSeconds: server?.stopTimeoutSeconds ?? 30,
})

function ServerForm({ server, onSaved, onCancel, onDelete }: { server?: ServerView; onSaved: (server: ServerView) => void; onCancel?: () => void; onDelete?: () => void }) {
  const [value, setValue] = useState(() => formValue(server))
  const [mode, setMode] = useState<'import' | 'paper' | 'manual'>(server ? 'manual' : 'import')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [paperError, setPaperError] = useState('')
  const [paperLoading, setPaperLoading] = useState(false)
  const [paperVersions, setPaperVersions] = useState<string[]>([])
  const [paperVersion, setPaperVersion] = useState('')
  const [paperBuilds, setPaperBuilds] = useState<PaperBuild[]>([])
  const [paperBuild, setPaperBuild] = useState<number | ''>('')
  useEffect(() => {
    setValue(formValue(server))
  }, [server?.id])
  useEffect(() => {
    if (server || mode !== 'paper' || paperVersions.length) return
    let active = true
    setPaperLoading(true); setPaperError('')
    void api<{ versions: string[] }>('/api/paper/versions').then(({ versions }) => {
      if (!active) return
      setPaperVersions(versions)
      setPaperVersion(versions[0] ?? '')
      if (!versions.length) setPaperError('No Paper release versions are currently available.')
    }).catch((reason) => active && setPaperError((reason as Error).message)).finally(() => active && setPaperLoading(false))
    return () => { active = false }
  }, [mode, paperVersions.length, server])
  useEffect(() => {
    if (server || mode !== 'paper' || !paperVersion) return
    let active = true
    setPaperLoading(true); setPaperError(''); setPaperBuilds([]); setPaperBuild('')
    void api<{ builds: PaperBuild[] }>(`/api/paper/versions/${encodeURIComponent(paperVersion)}/builds`).then(({ builds }) => {
      if (!active) return
      setPaperBuilds(builds)
      setPaperBuild(builds[0]?.id ?? '')
      if (!builds.length) setPaperError(`Paper has no stable builds for Minecraft ${paperVersion}.`)
    }).catch((reason) => active && setPaperError((reason as Error).message)).finally(() => active && setPaperLoading(false))
    return () => { active = false }
  }, [mode, paperVersion, server])
  const set = <K extends keyof ServerFormValue>(key: K, next: ServerFormValue[K]) => setValue((current) => ({ ...current, [key]: next }))
  const setMaximumMemory = (maxMemoryMb: number) => setValue((current) => ({ ...current, ...memoryForMaximum(current.minMemoryMb, maxMemoryMb) }))
  const ramSliderMax = Math.max(RAM_SLIDER_DEFAULT_MAX_MB, Math.ceil(value.maxMemoryMb / 512) * 512)
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('')
    const importing = !server && mode === 'import'
    const downloadingPaper = !server && mode === 'paper'
    const settings = { ...value, javaArgs: value.javaArgs.split('\n').map((arg) => arg.trim()).filter(Boolean) }
    const payload = importing ? { name: value.name, directory: value.directory } : downloadingPaper ? { ...settings, paperVersion, paperBuild } : settings
    try {
      const saved = await api<ServerView>(server ? `/api/servers/${server.id}` : importing ? '/api/servers/import' : downloadingPaper ? '/api/servers/paper' : '/api/servers', { method: server ? 'PUT' : 'POST', body: JSON.stringify(payload) })
      onSaved(saved)
    } catch (reason) { setError((reason as Error).message) } finally { setBusy(false) }
  }
  return <form onSubmit={submit} className="space-y-5 p-5 sm:p-6">
    {!server && <div className="grid grid-cols-3 gap-2 rounded-lg bg-muted p-1">
      <Button type="button" aria-pressed={mode === 'import'} variant={mode === 'import' ? 'default' : 'ghost'} onClick={() => { setMode('import'); setError('') }}>Import existing</Button>
      <Button type="button" aria-pressed={mode === 'paper'} variant={mode === 'paper' ? 'default' : 'ghost'} onClick={() => { setMode('paper'); set('jar', 'paper.jar'); setError('') }}>Download Paper</Button>
      <Button type="button" aria-pressed={mode === 'manual'} variant={mode === 'manual' ? 'default' : 'ghost'} onClick={() => { setMode('manual'); setError('') }}>Manual setup</Button>
    </div>}
    <label><span className="label">Server name</span><Input required maxLength={50} value={value.name} onChange={(event) => set('name', event.target.value)} placeholder="Survival" /></label>
    <label><span className="label">Server directory</span><Input className="font-mono" required value={value.directory} onChange={(event) => set('directory', event.target.value)} placeholder="/Users/alex/minecraft/survival" /><span className="mt-1.5 block text-xs text-muted-foreground">{!server && mode === 'import' ? <>The existing folder containing <code>start.sh</code>, <code>start.bat</code>, or a server JAR. Memory, JAR, and JVM flags are imported when available.</> : server ? <>An existing folder containing the JAR file. <code>~/…</code> is supported.</> : mode === 'paper' ? <>The folder will be created and the selected stable Paper JAR will be downloaded into it.</> : <>The folder will be created if it does not exist. You can upload the server JAR afterward.</>}</span></label>
    {!server && mode === 'paper' && <div className="rounded-lg border border-border bg-muted/30 p-4">
      <div className="flex items-start justify-between gap-4"><div><div className="text-sm font-semibold text-foreground">Paper server</div><p className="mt-1 text-xs leading-5 text-muted-foreground">MineDeck downloads stable builds from PaperMC and verifies the SHA-256 checksum. You will still need to accept Mojang's EULA before the server can run.</p></div><Badge variant="outline">Paper only</Badge></div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label><span className="label">Minecraft version</span><select className="field" required disabled={paperLoading && !paperVersions.length} value={paperVersion} onChange={(event) => setPaperVersion(event.target.value)}><option value="">{paperLoading ? 'Loading versions…' : 'Choose a version'}</option>{paperVersions.map((version) => <option key={version} value={version}>{version}</option>)}</select></label>
        <label><span className="label">Paper build</span><select className="field" required disabled={paperLoading || !paperBuilds.length} value={paperBuild} onChange={(event) => setPaperBuild(Number(event.target.value))}><option value="">{paperLoading && paperVersion ? 'Loading builds…' : 'Choose a stable build'}</option>{paperBuilds.map((build, index) => <option key={build.id} value={build.id}>#{build.id}{index === 0 ? ' · latest stable' : ''} · {formatSize(build.size)}</option>)}</select></label>
      </div>
      {paperError && <p role="alert" className="mt-3 text-xs text-destructive">{paperError}</p>}
    </div>}
    {(server || mode !== 'import') && <>
      <div className="grid gap-4 sm:grid-cols-2">
      <label><span className="label">Server JAR{mode === 'paper' && !server ? ' filename' : ''}</span><Input className="font-mono" required value={value.jar} onChange={(event) => set('jar', event.target.value)} placeholder="server.jar" /></label>
      </div>
    <label className="block rounded-lg border border-border bg-muted/30 px-4 py-4">
      <span className="flex items-center justify-between gap-4"><span className="text-sm font-semibold text-foreground">RAM allocation</span><output className="rounded-md bg-primary/10 px-2.5 py-1 text-sm font-bold tabular-nums text-primary">{formatMemoryMb(value.maxMemoryMb)} max</output></span>
      <input className="mt-4 h-2 w-full cursor-pointer accent-primary" type="range" min={256} max={ramSliderMax} step={256} value={value.maxMemoryMb} onChange={(event) => setMaximumMemory(event.target.valueAsNumber)} />
      <span className="mt-2 flex justify-between text-[11px] tabular-nums text-muted-foreground"><span>256 MB</span><span>{formatMemoryMb(ramSliderMax / 2)}</span><span>{formatMemoryMb(ramSliderMax)}</span></span>
      <span className="mt-2 block text-xs text-muted-foreground">Drag to set the maximum heap. Minimum RAM is lowered automatically if necessary.</span>
    </label>
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
      <div className="flex gap-2">{onCancel && <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>}<Button disabled={serverFormDisabled(busy, server?.status) || (!server && mode === 'paper' && (paperLoading || !paperVersion || paperBuild === ''))}><Save />{busy ? mode === 'paper' ? 'Downloading Paper…' : 'Saving…' : server ? 'Save changes' : mode === 'import' ? 'Import server' : mode === 'paper' ? 'Download and add' : 'Add server'}</Button></div>
    </div>
  </form>
}

function Console({ server, address, lines, samples, onCommand }: { server: ServerView; address: string | null | undefined; lines: string[]; samples: MetricSample[]; onCommand: (command: string) => Promise<void> }) {
  const [command, setCommand] = useState('')
  const [error, setError] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const [historyDraft, setHistoryDraft] = useState('')
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [lines.length])
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!command.trim()) return
    const value = command; setCommand(''); setError(''); setHistory((items) => [...items, value].slice(-100)); setHistoryIndex(null); setHistoryDraft('')
    try { await onCommand(value) } catch (reason) { setError((reason as Error).message); setCommand(value) }
  }
  const navigateHistory = (direction: 'up' | 'down') => {
    const next = navigateConsoleHistory(history, { command, index: historyIndex, draft: historyDraft }, direction)
    setCommand(next.command); setHistoryIndex(next.index); setHistoryDraft(next.draft)
  }
  const running = server.status === 'running' || server.status === 'starting'
  return <div className="space-y-4">
    <div className="panel flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0"><div className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Server address</div><code className="mt-1 block truncate text-sm font-semibold text-foreground">{address === undefined ? 'Loading…' : address ?? 'Unavailable'}</code></div>
      <Button variant="outline" size="sm" disabled={!address} onClick={() => address && void navigator.clipboard.writeText(address)}><Copy />Copy address</Button>
    </div>
    <section className="panel overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-4 py-3"><span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground"><span className={`h-2 w-2 rounded-full ${running ? 'bg-chart-2 shadow-[0_0_8px_#50fa7b]' : 'bg-muted-foreground'}`} />Live console</span><Button variant="ghost" size="xs" onClick={() => navigator.clipboard.writeText(lines.join('\n'))}>Copy output</Button></div>
      <div className="console-lines h-[48vh] min-h-80 overflow-auto bg-sidebar py-3 font-mono text-[12px] leading-5 text-foreground sm:text-[13px]">
        {!lines.length && <div className="px-3 text-muted-foreground">Console output will appear here.</div>}
        {lines.map((line, index) => <div key={`${index}-${line}`} className="whitespace-pre-wrap break-all px-3 hover:bg-white/[.025]">{consoleLineTokens(line).map((token, tokenIndex) => <span key={tokenIndex} className={token.className}>{token.text}</span>)}</div>)}
        <div ref={end} />
      </div>
      <form onSubmit={submit} className="border-t border-border bg-card p-3">
        <div className="flex gap-2"><span className="flex items-center font-mono font-bold text-primary">›</span><Input className="h-10 flex-1 font-mono" aria-label="Console command" placeholder={running ? 'Enter a Minecraft command…' : 'Start the server to send commands'} disabled={!running} value={command} onChange={(event) => setCommand(event.target.value)} onKeyDown={(event) => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); navigateHistory(event.key === 'ArrowUp' ? 'up' : 'down') } }} /><Button size="lg" disabled={!running}><Send />Send</Button></div>
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      </form>
    </section>
    <div className="grid gap-4 md:grid-cols-2" aria-label="Server resource usage">
      <ResourceChart title="CPU" value={`${server.cpuPercent.toFixed(1)}%`} samples={samples} getValue={(sample) => sample.cpuPercent} minimumMax={100} formatScale={(value) => `${Math.round(value)}%`} color="text-chart-4" />
      <ResourceChart title="RAM" value={`${server.memoryMb.toLocaleString()} MB`} detail={`of ${server.maxMemoryMb.toLocaleString()} MB`} samples={samples} getValue={(sample) => sample.memoryMb} minimumMax={server.maxMemoryMb} formatScale={(value) => `${Math.round(value).toLocaleString()} MB`} color="text-chart-5" />
    </div>
  </div>
}

function ResourceChart({ title, value, detail = 'Java process', samples, getValue, minimumMax, formatScale, color }: {
  title: string
  value: string
  detail?: string
  samples: MetricSample[]
  getValue: (sample: MetricSample) => number
  minimumMax: number
  formatScale: (value: number) => string
  color: string
}) {
  const width = 600
  const height = 180
  const plot = { left: 12, right: 588, top: 12, bottom: 148 }
  const now = Date.now()
  const visible = samples.filter((sample) => sample.at >= now - METRIC_WINDOW_MS)
  const rawMax = Math.max(minimumMax, ...visible.map(getValue), 1)
  const step = title === 'CPU' ? 25 : 256
  const max = Math.ceil(rawMax / step) * step
  const points = visible.map((sample) => ({
    x: plot.left + Math.max(0, Math.min(1, (sample.at - (now - METRIC_WINDOW_MS)) / METRIC_WINDOW_MS)) * (plot.right - plot.left),
    y: plot.bottom - Math.max(0, Math.min(1, getValue(sample) / max)) * (plot.bottom - plot.top),
  }))
  const line = points.map((point, index) => `${index ? 'L' : 'M'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ')
  const area = points.length ? `${line} L ${points.at(-1)!.x.toFixed(1)} ${plot.bottom} L ${points[0]!.x.toFixed(1)} ${plot.bottom} Z` : ''
  const latest = points.at(-1)

  return <section className="panel overflow-hidden">
    <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
      <div><h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{title} usage</h2><p className="mt-1 text-xs text-muted-foreground">{detail}</p></div>
      <div className={`text-right text-xl font-bold tabular-nums ${color}`}>{value}</div>
    </div>
    <div className="relative px-3 pb-3 pt-2">
      <svg viewBox={`0 0 ${width} ${height}`} className={`block h-44 w-full ${color}`} role="img" aria-label={`${title} usage over the last five minutes`}>
        <title>{title} usage over the last five minutes</title>
        {[plot.top, (plot.top + plot.bottom) / 2, plot.bottom].map((y) => <line key={y} x1={plot.left} x2={plot.right} y1={y} y2={y} className="text-border" stroke="currentColor" strokeWidth="1" vectorEffect="non-scaling-stroke" />)}
        {area && <path d={area} fill="currentColor" opacity="0.12" />}
        {line && <path d={line} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
        {latest && <circle cx={latest.x} cy={latest.y} r="3.5" fill="currentColor" stroke="var(--card)" strokeWidth="2" vectorEffect="non-scaling-stroke" />}
        <text x={plot.left} y="173" fill="var(--muted-foreground)" fontSize="11">5 minutes ago</text>
        <text x={plot.right} y="173" fill="var(--muted-foreground)" fontSize="11" textAnchor="end">Now</text>
        <text x={plot.right - 2} y={plot.top + 11} fill="var(--muted-foreground)" fontSize="11" textAnchor="end">{formatScale(max)}</text>
        <text x={plot.right - 2} y={plot.bottom - 5} fill="var(--muted-foreground)" fontSize="11" textAnchor="end">0</text>
      </svg>
      {!visible.length && <div className="pointer-events-none absolute inset-x-3 top-2 flex h-36 items-center justify-center text-xs text-muted-foreground">Waiting for metrics…</div>}
    </div>
  </section>
}

const editorTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--sidebar)', color: 'var(--foreground)', fontSize: '13px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: '"Fira Code Variable", "Fira Code", monospace', lineHeight: '1.65', overflow: 'auto' },
  '.cm-content': { padding: '14px 0', caretColor: 'var(--primary)' },
  '.cm-line': { padding: '0 18px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--primary)' },
  '.cm-gutters': { backgroundColor: 'var(--background)', color: 'var(--muted-foreground)', border: 'none', borderRight: '1px solid var(--border)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 12px 0 10px', minWidth: '44px' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--foreground), transparent 96%)' },
  '.cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--primary), transparent 88%)', color: 'var(--primary)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'color-mix(in srgb, var(--primary), transparent 75%)' },
  '.cm-foldGutter .cm-gutterElement': { color: 'var(--muted-foreground)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--chart-3), transparent 70%)', outline: '1px solid var(--chart-3)' },
  '.cm-panels': { backgroundColor: 'var(--card)', color: 'var(--card-foreground)' },
}, { dark: true })

const editorHighlighting = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.comment, color: 'var(--muted-foreground)', fontStyle: 'italic' },
  { tag: [tags.propertyName, tags.attributeName, tags.tagName], color: 'var(--chart-5)' },
  { tag: [tags.string, tags.attributeValue], color: 'var(--chart-2)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--chart-3)' },
  { tag: [tags.keyword, tags.modifier, tags.typeName], color: 'var(--chart-4)' },
  { tag: [tags.operator, tags.punctuation, tags.bracket], color: 'var(--chart-1)' },
  { tag: [tags.variableName, tags.name], color: 'var(--foreground)' },
  { tag: tags.invalid, color: 'var(--destructive)', textDecoration: 'underline' },
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
  const [pendingDelete, setPendingDelete] = useState<{ name: string; target: string; type: 'file' | 'directory' }>()
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
  const deleteEntry = async (name: string, target: string, type: 'file' | 'directory' = 'file') => {
    setBusy('Moving to recycle bin…'); setError(''); setNotice('')
    try {
      await api(`/api/servers/${server.id}/file`, { method: 'DELETE', body: JSON.stringify({ path: target }) })
      setEntries((await getDirectory(path)).entries)
      if (target === file) { setFile(''); setContent(''); setSavedContent(''); setCursor({ line: 1, column: 1 }) }
      setNotice(`${name} was moved to the hosted machine’s recycle bin.`)
    } catch (reason) { setError((reason as Error).message) } finally { setBusy(''); setPendingDelete(undefined) }
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
            {(entry.type === 'file' || entry.type === 'directory') && <Button variant="ghost" size="icon-sm" className="mr-2 text-muted-foreground opacity-100 hover:text-destructive md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100" disabled={Boolean(busy)} onClick={() => setPendingDelete({ name: entry.name, target, type: entry.type === 'directory' ? 'directory' : 'file' })} aria-label={`Move ${entry.name} to recycle bin`} title="Move to recycle bin"><Trash2 /></Button>}
          </div>
        })}
      </div>
      <div className="flex min-h-[32rem] min-w-0 flex-col bg-sidebar">
        {file ? <>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-sidebar px-3 py-2.5 sm:px-4">
            <div className="flex min-w-0 items-center gap-2"><span className={`grid h-7 w-7 shrink-0 place-items-center rounded-md border text-xs ${fileTone(activeName)}`}>▤</span><span className="min-w-0 truncate font-mono text-xs font-semibold text-foreground/80">{activeName}</span><Badge variant="outline" className="rounded-md text-[10px] uppercase tracking-wider">{language.label}</Badge>{dirty && <span className="text-xs text-chart-3">● Unsaved</span>}</div>
            <div className="flex items-center gap-2"><Button variant="destructive" size="sm" disabled={Boolean(busy)} onClick={() => setPendingDelete({ name: activeName, target: file, type: 'file' })}><Trash2 />Recycle</Button><Button size="sm" disabled={!dirty || Boolean(busy)} onClick={() => void save()} title={`Save (${shortcutLabel('S', platform)})`}><Save />{busy === 'Saving…' ? busy : 'Save'} <span className="hidden font-normal opacity-60 sm:inline">{shortcutLabel('S', platform)}</span></Button></div>
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
    {pendingDelete && <ConfirmationModal
      title={`Recycle ${pendingDelete.type}`}
      message={<>“{pendingDelete.name}” will be moved to the hosted machine’s recycle bin.{pendingDelete.type === 'directory' ? ' The folder and everything inside it will be moved.' : ''}{pendingDelete.target === file && dirty ? ' Unsaved editor changes will also be lost.' : ''}</>}
      confirmLabel="Move to recycle bin"
      busyLabel="Moving…"
      busy={busy === 'Moving to recycle bin…'}
      onClose={() => setPendingDelete(undefined)}
      onConfirm={() => void deleteEntry(pendingDelete.name, pendingDelete.target, pendingDelete.type)}
    />}
  </section>
}

const playerHeadUrl = (uuid: string) => `https://mc-heads.net/avatar/${uuid.replaceAll('-', '')}/96`

function Players({ server }: { server: ServerView }) {
  const [players, setPlayers] = useState<PlayerView[]>([])
  const [selectedUuid, setSelectedUuid] = useState('')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<PlayerAction | ''>('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const selected = players.find((player) => player.uuid === selectedUuid)
  const filtered = useMemo(() => {
    const value = query.trim().toLowerCase()
    return value ? players.filter((player) => player.username.toLowerCase().includes(value) || player.uuid.includes(value)) : players
  }, [players, query])

  const load = async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const result = await api<PlayerView[]>(`/api/servers/${server.id}/players`)
      setPlayers(result)
      setError('')
    } catch (reason) { setError((reason as Error).message) }
    finally { if (!silent) setLoading(false) }
  }

  useEffect(() => {
    setPlayers([]); setSelectedUuid(''); setQuery(''); setError(''); setNotice(''); setLoading(true)
    void load()
    const timer = window.setInterval(() => void load(true), 5_000)
    return () => window.clearInterval(timer)
  }, [server.id])

  const run = async (action: PlayerAction) => {
    if (!selected) return
    setBusy(action); setError(''); setNotice('')
    try {
      await api(`/api/servers/${server.id}/players/${encodeURIComponent(selected.uuid)}/actions/${action}`, { method: 'POST' })
      setPlayers((items) => items.map((player) => player.uuid !== selected.uuid ? player : {
        ...player,
        isOp: action === 'op' ? true : action === 'deop' ? false : player.isOp,
        isWhitelisted: action === 'remove-whitelist' ? false : player.isWhitelisted,
        isOnline: action === 'kick' || action === 'ban' ? false : player.isOnline,
        isBanned: action === 'ban' ? true : player.isBanned,
      }))
      const labels: Record<PlayerAction, string> = {
        op: `${selected.username} is now an operator.`,
        deop: `Operator access removed from ${selected.username}.`,
        'remove-whitelist': `${selected.username} was removed from the whitelist.`,
        kick: `${selected.username} was kicked.`,
        ban: `${selected.username} was banned.`,
      }
      setNotice(labels[action])
      window.setTimeout(() => void load(true), 1_000)
    } catch (reason) { setError((reason as Error).message) }
    finally { setBusy('') }
  }

  const running = server.status === 'running'
  return <>
    <section className="panel overflow-hidden" aria-busy={loading}>
      <div className="flex flex-col gap-3 border-b border-border bg-card/70 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div><h2 className="flex items-center gap-2 font-bold text-card-foreground"><Users className="size-4 text-primary" />Players</h2><p className="mt-1 text-xs text-muted-foreground">{players.length} known · {players.filter((player) => player.isOnline).length} online</p></div>
        <div className="flex gap-2">
          <label className="relative min-w-0 flex-1 sm:w-64"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input className="pl-9" aria-label="Search players" placeholder="Search username or UUID" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          <Button variant="outline" size="icon" disabled={loading} onClick={() => void load()} aria-label="Refresh players"><RefreshCw className={loading ? 'animate-spin' : ''} /></Button>
        </div>
      </div>
      {!running && <div className="border-b border-chart-3/30 bg-chart-3/10 px-4 py-2.5 text-sm text-chart-3">Start the server to change player access, kick, or ban.</div>}
      {error && !selected && <div role="alert" className="border-b border-destructive/40 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">{error}</div>}
      <div className="p-4 sm:p-5">
        {loading && !players.length ? <div className="grid min-h-64 place-items-center text-sm text-muted-foreground"><span className="flex items-center gap-2"><RefreshCw className="size-4 animate-spin" />Loading players…</span></div>
          : !filtered.length ? <div className="grid min-h-64 place-items-center px-5 text-center"><div><Users className="mx-auto size-10 text-muted-foreground/60" /><p className="mt-4 text-sm font-semibold text-foreground">{query ? 'No matching players' : 'No players found'}</p><p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">{query ? 'Try a different username or UUID.' : 'Players will appear after they have joined this Java server at least once.'}</p></div></div>
            : <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{filtered.map((player) => <button key={player.uuid} onClick={() => { setSelectedUuid(player.uuid); setError(''); setNotice('') }} className="group flex min-w-0 items-center gap-4 rounded-xl border border-border bg-muted/20 p-3.5 text-left transition hover:border-primary/50 hover:bg-primary/5 focus-visible:ring-3 focus-visible:ring-ring/50">
              <div className="relative shrink-0"><img src={playerHeadUrl(player.uuid)} alt="" width="64" height="64" loading="lazy" className="h-16 w-16 rounded-lg bg-muted [image-rendering:pixelated]" /><span className={`absolute -bottom-1 -right-1 h-3.5 w-3.5 rounded-full border-2 border-card ${player.isOnline ? 'bg-chart-2 shadow-[0_0_8px_#50fa7b]' : 'bg-muted-foreground'}`} /></div>
              <span className="min-w-0 flex-1"><span className="block truncate font-bold text-card-foreground group-hover:text-primary">{player.username}</span><span className="mt-1 block truncate font-mono text-[10px] text-muted-foreground">{player.uuid}</span><span className="mt-2 flex flex-wrap gap-1.5">{player.isOnline && <Badge className="bg-chart-2/15 text-chart-2">Online</Badge>}{player.isOp && <Badge variant="outline" className="border-primary/30 text-primary">OP</Badge>}{player.isWhitelisted && <Badge variant="outline">Whitelisted</Badge>}{player.isBanned && <Badge variant="destructive">Banned</Badge>}</span></span>
              <span className="text-lg text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-primary">›</span>
            </button>)}</div>}
      </div>
      <div className="border-t border-border bg-muted/20 px-4 py-2 text-right text-[10px] text-muted-foreground">Player heads by <a className="text-primary hover:underline" href="https://mc-heads.net" target="_blank" rel="noreferrer">MCHeads</a></div>
    </section>

    {selected && <Modal title={`Manage ${selected.username}`} onClose={() => { setSelectedUuid(''); setError(''); setNotice('') }}>
      <div className="p-5 sm:p-6">
        <div className="flex items-center gap-4"><img src={playerHeadUrl(selected.uuid)} alt={`${selected.username}'s Minecraft head`} width="80" height="80" className="h-20 w-20 rounded-xl bg-muted [image-rendering:pixelated]" /><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="truncate text-xl font-black text-popover-foreground">{selected.username}</h3><Badge variant="outline" className="gap-1.5"><span className={`h-1.5 w-1.5 rounded-full ${selected.isOnline ? 'bg-chart-2' : 'bg-muted-foreground'}`} />{selected.isOnline ? 'Online' : 'Offline'}</Badge></div><div className="mt-2 flex min-w-0 items-center gap-1.5"><code className="truncate text-xs text-muted-foreground">{selected.uuid}</code><Button variant="ghost" size="icon-xs" onClick={() => void navigator.clipboard.writeText(selected.uuid)} aria-label="Copy UUID"><Copy /></Button></div></div></div>

        <div className="mt-6 flex flex-wrap gap-2">{selected.isOp && <Badge variant="outline" className="border-primary/30 text-primary">Operator</Badge>}{selected.isWhitelisted && <Badge variant="outline">Whitelisted</Badge>}{selected.isBanned && <Badge variant="destructive">Banned</Badge>}{!selected.isOp && !selected.isWhitelisted && !selected.isBanned && <span className="text-xs text-muted-foreground">No special access</span>}</div>
        {notice && <Alert className="mt-5 border-chart-2/30 bg-chart-2/10 text-chart-2"><AlertDescription>{notice}</AlertDescription></Alert>}
        {error && <Alert variant="destructive" className="mt-5"><AlertDescription>{error}</AlertDescription></Alert>}

        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <Button variant="outline" className="h-auto justify-start px-4 py-3 text-left" disabled={!running || Boolean(busy)} onClick={() => void run(selected.isOp ? 'deop' : 'op')}>{selected.isOp ? <ShieldOff /> : <Shield />}<span><span className="block">{selected.isOp ? 'Remove OP' : 'Make operator'}</span><span className="mt-0.5 block text-[11px] font-normal text-muted-foreground">{selected.isOp ? 'Revoke operator commands' : 'Grant full operator commands'}</span></span></Button>
          <Button variant="outline" className="h-auto justify-start px-4 py-3 text-left" disabled={!running || !selected.isWhitelisted || Boolean(busy)} onClick={() => void run('remove-whitelist')}><UserX /><span><span className="block">{selected.isWhitelisted ? 'Remove whitelist' : 'Not whitelisted'}</span><span className="mt-0.5 block text-[11px] font-normal text-muted-foreground">Remove server whitelist access</span></span></Button>
          <Button variant="outline" className="h-auto justify-start px-4 py-3 text-left" disabled={!running || !selected.isOnline || Boolean(busy)} onClick={() => void run('kick')}><UserX /><span><span className="block">Kick player</span><span className="mt-0.5 block text-[11px] font-normal text-muted-foreground">Disconnect from this session</span></span></Button>
          <Button variant="destructive" className="h-auto justify-start px-4 py-3 text-left" disabled={!running || selected.isBanned || Boolean(busy)} onClick={() => confirm(`Ban ${selected.username} from this server?`) && void run('ban')}><Ban /><span><span className="block">{selected.isBanned ? 'Already banned' : 'Ban player'}</span><span className="mt-0.5 block text-[11px] font-normal opacity-75">Prevent future connections</span></span></Button>
        </div>
        {busy && <p className="mt-4 flex items-center justify-center gap-2 text-xs text-muted-foreground"><RefreshCw className="size-3 animate-spin" />Applying player action…</p>}
      </div>
    </Modal>}
  </>
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

function ThemeFooter({ selected, onChange, offset = false }: { selected: AppTheme; onChange: (theme: AppTheme) => void; offset?: boolean }) {
  return <footer className={`border-t border-border bg-card/40 px-4 py-3 ${offset ? 'lg:ml-72' : ''}`}>
    <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
      <span className="text-xs text-muted-foreground">MineDeck Remote</span>
      <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <span>Theme</span>
        <select aria-label="Theme" className="field h-8 w-auto min-w-36 py-1 text-xs text-foreground" value={selected} onChange={(event) => onChange(event.target.value as AppTheme)}>
          {appThemes.map((theme) => <option key={theme.id} value={theme.id}>{theme.name}</option>)}
        </select>
      </label>
    </div>
  </footer>
}

function Dashboard({ onLogout, theme, onThemeChange }: { onLogout: () => void; theme: AppTheme; onThemeChange: (theme: AppTheme) => void }) {
  const [servers, setServers] = useState<ServerView[]>([])
  const [serversLoaded, setServersLoaded] = useState(false)
  const [selectedId, setSelectedId] = useState(serverIdFromPath)
  const [tab, setTab] = useState<(typeof tabs)[number]>('console')
  const [logs, setLogs] = useState<Record<string, string[]>>({})
  const [metricHistory, setMetricHistory] = useState<MetricHistory>({})
  const [connected, setConnected] = useState(false)
  const [serverAddresses, setServerAddresses] = useState<Record<string, string | null>>({})
  const [addOpen, setAddOpen] = useState(false)
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [removingId, setRemovingId] = useState('')
  const [pendingRemoval, setPendingRemoval] = useState<ServerView>()
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
    void api<ServerView[]>('/api/servers').then((items) => {
      statuses.current = new Map(items.map((server) => [server.id, server.status]))
      setServers(items)
      setMetricHistory((current) => appendMetricHistory(current, items))
      const requestedId = serverIdFromPath()
      if (requestedId && !items.some((server) => server.id === requestedId)) {
        window.history.replaceState(null, '', '/')
        setSelectedId('')
      }
      setServersLoaded(true)
    }).catch((reason) => { setError(reason.message); setServersLoaded(true) })
  }, [])
  useEffect(() => {
    if (!selectedId || tab !== 'console') return
    void api<{ address: string | null }>(`/api/servers/${selectedId}/address`).then(({ address }) => {
      setServerAddresses((current) => ({ ...current, [selectedId]: address }))
    }).catch(() => setServerAddresses((current) => ({ ...current, [selectedId]: null })))
  }, [selectedId, tab])
  useEffect(() => {
    const navigateFromHistory = () => {
      setSelectedId(serverIdFromPath())
      setTab('console')
      setError('')
    }
    window.addEventListener('popstate', navigateFromHistory)
    return () => window.removeEventListener('popstate', navigateFromHistory)
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
          setMetricHistory((current) => appendMetricHistory(current, event.servers))
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
  const remove = async (server: ServerView) => {
    setRemovingId(server.id)
    setError('')
    try {
      if (server.status !== 'stopped' && server.status !== 'crashed') {
        if (server.status !== 'stopping') await api(`/api/servers/${server.id}/actions/stop`, { method: 'POST' })
        await waitUntilServerStops(server.id, (server.stopTimeoutSeconds + 10) * 1_000)
      }
      await api(`/api/servers/${server.id}`, { method: 'DELETE' })
      setServers((items) => items.filter((item) => item.id !== server.id))
      setLogs((current) => {
        const next = { ...current }
        delete next[server.id]
        return next
      })
      statuses.current.delete(server.id)
      restarting.current.delete(server.id)
      if (selectedId === server.id) select('')
      notify({ tone: 'success', title: 'Server removed', message: `${server.name} was removed from MineDeck. Its files were left untouched.` })
    } catch (reason) {
      const message = (reason as Error).message
      setError(message)
      notify({ tone: 'error', title: 'Could not remove server', message }, `server:${server.id}`)
    } finally { setRemovingId(''); setPendingRemoval(undefined) }
  }
  const select = (id: string) => {
    window.history.pushState(null, '', id ? `/servers/${encodeURIComponent(id)}` : '/')
    setSelectedId(id)
    setTab('console')
    setError('')
  }

  return <div className="flex min-h-screen flex-col bg-background text-foreground">
    <Toasts items={toasts} onDismiss={(id) => setToasts((items) => items.filter((item) => item.id !== id))} />
    {selected && <aside className="fixed inset-y-0 left-0 z-20 hidden w-72 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground lg:flex">
      <div className="border-b border-sidebar-border p-5"><Logo /></div>
      <div className="border-b border-sidebar-border p-4">
        <div className="rounded-lg bg-sidebar-accent p-3 text-sidebar-accent-foreground"><div className="flex items-center gap-3"><span className={`h-2.5 w-2.5 shrink-0 rounded-full ${statusStyle[selected.status]}`} /><div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold">{selected.name}</div><div className="text-xs text-muted-foreground">{prettyStatus(selected.status)}</div></div></div><Button variant="ghost" size="sm" className="mt-3 w-full" onClick={() => select('')}>Change server</Button></div>
      </div>
      <nav className="flex-1 p-3">
        <div className="flex items-center justify-between px-3 pb-2 pt-1"><span className="text-[11px] font-bold uppercase tracking-[.18em] text-muted-foreground">Server</span><span className={`flex items-center gap-1.5 text-[11px] ${connected ? 'text-muted-foreground' : 'text-chart-3'}`}><span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-chart-2' : 'bg-chart-3'}`} />{connected ? 'Live' : 'Reconnecting'}</span></div>
        {tabs.map((item) => <button key={item} onClick={() => setTab(item)} className={`mb-1 flex w-full items-center rounded-lg border px-4 py-3 text-left text-sm font-semibold capitalize transition ${tab === item ? 'border-sidebar-border bg-sidebar-accent text-sidebar-accent-foreground' : 'border-transparent text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground'}`}>{item}</button>)}
      </nav>
      <div className="space-y-2 border-t border-sidebar-border p-3"><Button className="w-full" size="lg" onClick={() => setAddOpen(true)}><Plus />Add server</Button><div className="grid grid-cols-2 gap-2"><Button variant="ghost" size="sm" onClick={() => setPasswordOpen(true)}><KeyRound />Password</Button><Button variant="ghost" size="sm" onClick={() => void logout()}><LogOut />Sign out</Button></div></div>
    </aside>}

    <header className="sticky top-0 z-20 border-b border-border bg-background/90 px-4 py-3 backdrop-blur lg:hidden">
      <div className="flex items-center gap-3"><Logo compact /><select aria-label="Select server" className="field min-w-0 flex-1 py-2" value={selectedId} onChange={(event) => select(event.target.value)}><option value="">Select a server</option>{servers.map((server) => <option key={server.id} value={server.id}>{server.name} · {prettyStatus(server.status)}</option>)}</select><Button size="icon-lg" onClick={() => setAddOpen(true)} aria-label="Add server"><Plus /></Button><Button variant="outline" size="icon-lg" onClick={() => setPasswordOpen(true)} aria-label="Account settings"><Settings /></Button></div>
    </header>

    <main className={`flex-1 ${selected ? 'lg:ml-72' : ''}`}>
      {!serversLoaded ? <div className="flex min-h-[70vh] items-center justify-center"><div className="brand-cube h-10 w-10 animate-pulse rounded-xl" /></div> : selected ? <div className="mx-auto max-w-7xl p-4 sm:p-6 lg:p-8">
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
        <div className="mb-4 flex items-center justify-between border-b border-border lg:hidden">
          <div className="flex overflow-auto">{tabs.map((item) => <button key={item} className={`border-b-2 px-4 py-3 text-sm font-semibold capitalize transition ${tab === item ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`} onClick={() => setTab(item)}>{item}</button>)}</div>
          <span className={`hidden items-center gap-1.5 text-xs sm:flex ${connected ? 'text-muted-foreground' : 'text-chart-3'}`}><span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-chart-2' : 'bg-chart-3'}`} />{connected ? 'Live' : 'Reconnecting'}</span>
        </div>
        {tab === 'console' && <Console key={selected.id} server={selected} address={serverAddresses[selected.id]} lines={logs[selected.id] ?? []} samples={metricHistory[selected.id] ?? []} onCommand={(command) => api(`/api/servers/${selected.id}/command`, { method: 'POST', body: JSON.stringify({ command }) })} />}
        {tab === 'players' && <Players server={selected} />}
        {tab === 'files' && <Files server={selected} />}
        {tab === 'configuration' && <Card className="gap-0 overflow-hidden py-0"><div className="border-b border-border px-5 py-4"><h2 className="font-bold text-card-foreground">Server configuration</h2><p className="mt-1 text-xs text-muted-foreground">Stop the server before changing launch settings.</p></div><ServerForm server={selected} onSaved={(saved) => setServers((items) => items.map((item) => item.id === saved.id ? saved : item))} onDelete={() => setPendingRemoval(selected)} /></Card>}
      </div> : servers.length ? <div className="mx-auto max-w-5xl p-6 sm:p-10 lg:p-14"><div className="flex flex-wrap items-end justify-between gap-4"><div><h1 className="text-3xl font-black tracking-tight text-foreground">Select a server</h1><p className="mt-2 text-sm text-muted-foreground">Choose a server before opening its console, files, or configuration.</p></div><Button onClick={() => setAddOpen(true)}><Plus />Add server</Button></div>{error && <Alert variant="destructive" className="mt-5"><AlertDescription>{error}</AlertDescription></Alert>}<div className="mt-8 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{servers.map((server) => {
        return <div key={server.id} className="panel group flex items-center transition hover:border-primary/50 hover:bg-muted/50">
          <button onClick={() => select(server.id)} className="flex min-w-0 flex-1 items-center gap-4 p-5 text-left">
            <span className={`h-3 w-3 shrink-0 rounded-full ${statusStyle[server.status]} ${server.status === 'running' ? 'shadow-[0_0_10px_var(--chart-2)]' : ''}`} />
            <span className="min-w-0 flex-1"><span className="block truncate font-bold text-card-foreground">{server.name}</span><span className="mt-1 block text-xs text-muted-foreground">{prettyStatus(server.status)}</span></span>
            <span className="text-xl text-muted-foreground">›</span>
          </button>
          <Button variant="ghost" size="icon-sm" className="mr-3 text-muted-foreground hover:text-destructive" disabled={Boolean(removingId)} onClick={() => setPendingRemoval(server)} aria-label={`Remove ${server.name}`} title={`Remove ${server.name}`}><Trash2 /></Button>
        </div>
      })}</div></div> : <div className="flex min-h-[70vh] items-center justify-center p-6"><div className="max-w-sm text-center"><div className="brand-cube mx-auto h-16 w-16 rounded-2xl" /><h1 className="mt-6 text-2xl font-bold text-foreground">Add your first server</h1><p className="mt-2 text-sm leading-6 text-muted-foreground">Point MineDeck at an existing Minecraft server folder to manage it from this dashboard.</p><Button className="mt-6" size="lg" onClick={() => setAddOpen(true)}><Plus />Add server</Button><Button variant="ghost" className="mt-6 w-full lg:hidden" size="sm" onClick={() => void logout()}><LogOut />Sign out</Button></div></div>}
    </main>
    <ThemeFooter selected={theme} onChange={onThemeChange} offset={Boolean(selected)} />
    {pendingRemoval && <ConfirmationModal
      title={`Remove ${pendingRemoval.name}?`}
      message={pendingRemoval.status === 'stopped' || pendingRemoval.status === 'crashed'
        ? <>This removes the server from MineDeck. Its server folder and every file inside it will remain untouched.</>
        : <>MineDeck will gracefully stop this server, then remove it from the dashboard. Its server folder and every file inside it will remain untouched.</>}
      confirmLabel={pendingRemoval.status === 'stopped' || pendingRemoval.status === 'crashed' ? 'Remove server' : 'Stop and remove'}
      busyLabel={pendingRemoval.status === 'stopped' || pendingRemoval.status === 'crashed' ? 'Removing…' : 'Stopping and removing…'}
      busy={removingId === pendingRemoval.id}
      onClose={() => setPendingRemoval(undefined)}
      onConfirm={() => void remove(pendingRemoval)}
    />}
    {addOpen && <Modal title="Add Minecraft server" onClose={() => setAddOpen(false)}><ServerForm onCancel={() => setAddOpen(false)} onSaved={(server) => { setServers((items) => [...items, server]); select(server.id); setAddOpen(false) }} /></Modal>}
    {passwordOpen && <Modal title="Change admin password" onClose={() => setPasswordOpen(false)}><PasswordForm onClose={() => setPasswordOpen(false)} /><div className="border-t border-border px-5 py-4 text-center lg:hidden"><Button variant="ghost" className="text-destructive" onClick={() => void logout()}><LogOut />Sign out of MineDeck</Button></div></Modal>}
  </div>
}

function Metric({ label, value, detail, className = '' }: { label: string; value: string; detail: string; className?: string }) {
  return <Card className={`gap-0 p-4 ${className}`}><div className="text-[10px] font-bold uppercase tracking-[.16em] text-muted-foreground">{label}</div><div className="mt-2 truncate text-xl font-bold tabular-nums text-card-foreground">{value}</div><div className="mt-1 truncate text-xs text-muted-foreground">{detail}</div></Card>
}

export default function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null)
  const [theme, setTheme] = useState<AppTheme>(storedTheme)
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try { localStorage.setItem('minedeck-theme', theme) } catch { /* Storage can be unavailable in private browsing. */ }
    const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    themeColor?.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--background').trim())
  }, [theme])
  useEffect(() => { void api<{ authenticated: boolean }>('/api/auth/session').then(({ authenticated }) => setAuthenticated(authenticated)).catch(() => setAuthenticated(false)) }, [])
  if (authenticated === null) return <div className="flex min-h-screen flex-col bg-background"><div className="flex flex-1 items-center justify-center"><div className="brand-cube h-10 w-10 animate-pulse rounded-xl" /></div><ThemeFooter selected={theme} onChange={setTheme} /></div>
  return authenticated
    ? <Dashboard onLogout={() => setAuthenticated(false)} theme={theme} onThemeChange={setTheme} />
    : <Login onLogin={() => setAuthenticated(true)} theme={theme} onThemeChange={setTheme} />
}
