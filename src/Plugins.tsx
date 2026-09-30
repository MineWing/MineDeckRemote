import { useEffect, useState, type FormEvent } from 'react'
import type { ModrinthProject, ModrinthVersion, PluginPlan, PluginTarget, ServerView } from '../shared.ts'

type Request = <T>(path: string, init?: RequestInit) => Promise<T>
const control = 'border border-border bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50'
const button = `${control} font-semibold`
const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`
function Skeleton({ label }: { label: string }) {
  return <div role="status" aria-label={label} className="space-y-3 py-5"><span className="sr-only">{label}</span>{[0, 1, 2, 3].map((item) => <div key={item} className="h-14 animate-pulse bg-muted" />)}</div>
}

export function Plugins({ server, request }: { server: ServerView; request: Request }) {
  const [target, setTarget] = useState<PluginTarget>()
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let active = true
    setTarget(undefined); setError('')
    void request<PluginTarget>(`/api/servers/${server.id}/plugins/target`).then((target) => { if (active) setTarget(target) })
      .catch((reason) => { if (active) setError(reason.message) })
    return () => { active = false }
  }, [request, server.id, server.status, refresh])
  if (error) return <section aria-label="Plugins"><h2 className="text-xl font-bold">Plugins from Modrinth</h2><p role="alert" className="my-4 text-sm">{error}</p><button className={button} onClick={() => setRefresh((value) => value + 1)}>Refresh server detection</button></section>
  if (!target) return <Skeleton label="Detecting server software and Minecraft version" />
  return <PluginBrowser key={`${target.loader}:${target.gameVersion}`} server={server} request={request} target={target} />
}

function PluginBrowser({ server, request, target }: { server: ServerView; request: Request; target: PluginTarget }) {
  const { loader, gameVersion } = target
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState({ query: '', offset: 0, attempt: 0 })
  const [results, setResults] = useState<{ projects: ModrinthProject[]; total: number }>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [project, setProject] = useState<ModrinthProject>()
  const [files, setFiles] = useState<string[]>([])
  const [filesLoading, setFilesLoading] = useState(true)
  const [filesError, setFilesError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [installing, setInstalling] = useState(false)
  const [notice, setNotice] = useState('')
  const locked = installing || Boolean(server.pluginsInstalling)
  useEffect(() => {
    let active = true
    setFilesLoading(true); setFilesError('')
    void request<{ files: string[] }>(`/api/servers/${server.id}/plugins`).then(({ files }) => { if (active) setFiles(files) })
      .catch((reason) => { if (active) setFilesError(reason.message) }).finally(() => { if (active) setFilesLoading(false) })
    return () => { active = false }
  }, [request, server.id, refresh, server.pluginsInstalling])
  useEffect(() => {
    let active = true
    setProject(undefined); setResults(undefined); setError('')
    if (!gameVersion) { setLoading(false); return }
    setLoading(true)
    const params = new URLSearchParams({ query: search.query, offset: String(search.offset) })
    void request<{ projects: ModrinthProject[]; total: number }>(`/api/servers/${server.id}/plugins/search?${params}`).then((response) => { if (active) setResults(response) })
      .catch((reason) => { if (active) setError(reason.message) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [request, server.id, loader, gameVersion, search])
  const submit = (event: FormEvent) => { event.preventDefault(); setSearch((value) => ({ query: query.trim(), offset: 0, attempt: value.attempt + 1 })) }
  return <section className="space-y-6" aria-label="Plugins">
    <div><h2 className="text-xl font-bold">Plugins from Modrinth</h2><p className="mt-1 text-sm text-muted-foreground">Only plugins matching this server’s detected software and Minecraft version can be installed. Stop the server before installing, then start it to load the plugins.</p></div>
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
      <p className="border border-border px-3 py-2 text-sm">Detected server: <strong className="capitalize">{loader}</strong> · Minecraft <strong>{gameVersion}</strong></p>
      <label className="grid min-w-48 flex-1 gap-1 text-sm">Search plugins<input className={control} value={query} maxLength={120} disabled={locked} onChange={(event) => setQuery(event.target.value)} placeholder="Name or keyword" /></label>
      <button className={button} disabled={locked || !gameVersion}>Search</button>
    </form>
    {notice && <p role="status" className="border border-border p-3 text-sm">{notice}</p>}
    {(server.pid !== null || server.status === 'starting' || server.status === 'stopping') && <p className="text-sm text-muted-foreground">You can browse now. Stop this server from the controls above to enable installation.</p>}
    {error && <p role="alert" className="text-destructive">{error} <button className="underline" onClick={() => setSearch((value) => ({ ...value, attempt: value.attempt + 1 }))}>Retry</button></p>}
    {loading ? <Skeleton label="Searching Modrinth" /> : results && <>
      <p className="text-sm text-muted-foreground">{results.total.toLocaleString()} matching projects. Only compatible releases can be installed.</p>
      {!results.projects.length && <p className="border border-border p-5">No plugins found. Try a different search or version.</p>}
      <div className="divide-y divide-border border-y border-border">{results.projects.map((item) => <article key={item.id} className="py-4">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-bold">{item.title}</h3><p className="text-xs text-muted-foreground">By {item.author} · {item.downloads.toLocaleString()} downloads</p></div><button className={button} disabled={locked} onClick={() => setProject(item)}>Choose version</button></div>
        <p className="mt-2 text-sm">{item.description}</p><a className="mt-2 inline-block text-sm underline" href={`https://modrinth.com/plugin/${item.slug}`} target="_blank" rel="noreferrer">View on Modrinth</a>
        {project?.id === item.id && <PluginDetails key={`${item.id}:${loader}:${gameVersion}`} project={item} target={target} server={server} request={request} onInstalling={setInstalling} onInstalled={(message) => { setNotice(message); setRefresh((value) => value + 1); setProject(undefined) }} />}
      </article>)}</div>
      <div className="flex items-center justify-between gap-3"><button className={button} disabled={locked || search.offset === 0} onClick={() => setSearch((value) => ({ ...value, offset: Math.max(0, value.offset - 20) }))}>Previous</button><span className="text-sm">Page {Math.floor(search.offset / 20) + 1}</span><button className={button} disabled={locked || search.offset + 20 >= results.total || search.offset >= 10_000} onClick={() => setSearch((value) => ({ ...value, offset: value.offset + 20 }))}>Next</button></div>
    </>}
    <section className="border-t border-border pt-5"><div className="flex items-center justify-between"><h3 className="font-bold">Installed JARs</h3><button className={button} disabled={locked || filesLoading} onClick={() => setRefresh((value) => value + 1)}>Refresh</button></div>
      {filesLoading ? <Skeleton label="Loading installed plugins" /> : filesError ? <p role="alert" className="mt-3 text-destructive">{filesError}</p> : files.length ? <ul className="mt-3 divide-y divide-border">{files.map((file) => <li key={file} className="break-all py-2 font-mono text-xs">{file}</li>)}</ul> : <p className="mt-3 text-sm text-muted-foreground">No plugin JARs in this server's plugins folder yet.</p>}
      <p className="mt-3 text-xs text-muted-foreground">Manage plugin files in the Files tab. Existing versions are kept until you move them to Trash.</p>
    </section>
    <p className="text-xs text-muted-foreground">Search and downloads use Modrinth. <a className="underline" href="https://modrinth.com/legal/terms" target="_blank" rel="noreferrer">Terms of service</a> · <a className="underline" href="https://modrinth.com/legal/privacy" target="_blank" rel="noreferrer">Privacy policy</a></p>
  </section>
}

function PluginDetails({ project, target, server, request, onInstalling, onInstalled }: { project: ModrinthProject; target: PluginTarget; server: ServerView; request: Request; onInstalling: (value: boolean) => void; onInstalled: (message: string) => void }) {
  const [versions, setVersions] = useState<ModrinthVersion[]>([])
  const [versionId, setVersionId] = useState('')
  const [plan, setPlan] = useState<PluginPlan>()
  const [loading, setLoading] = useState(true)
  const [planning, setPlanning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const { loader, gameVersion } = target
  useEffect(() => {
    let active = true
    setLoading(true); setError('')
    void request<{ versions: ModrinthVersion[] }>(`/api/servers/${server.id}/plugins/projects/${project.id}/versions`).then(({ versions }) => {
      if (active) { setVersions(versions); setVersionId(versions[0]?.id ?? '') }
    }).catch((reason) => { if (active) setError(reason.message) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [request, server.id, project.id, loader, gameVersion, retry])
  useEffect(() => {
    let active = true
    setPlan(undefined)
    if (!versionId) return
    setPlanning(true); setError('')
    void request<PluginPlan>(`/api/servers/${server.id}/plugins/plan`, { method: 'POST', body: JSON.stringify({ versionId }) }).then((plan) => { if (active) setPlan(plan) })
      .catch((reason) => { if (active) setError(reason.message) }).finally(() => { if (active) setPlanning(false) })
    return () => { active = false }
  }, [request, server.id, versionId, loader, gameVersion, retry])
  const install = async () => {
    if (!plan) return
    setBusy(true); onInstalling(true); setError('')
    try {
      const result = await request<{ installed: string[]; alreadyInstalled: string[] }>(`/api/servers/${server.id}/plugins/install`, { method: 'POST', body: JSON.stringify({ versionId, fingerprint: plan.fingerprint }) })
      onInstalled(result.installed.length ? `Installed ${project.title}${plan.items.length > 1 ? ' and its required dependencies' : ''}. Start the server to load the plugins.` : `${project.title} and its required dependencies are already installed.`)
    } catch (reason) { setError((reason as Error).message) }
    finally { setBusy(false); onInstalling(false) }
  }
  return <div className="mt-4 border border-border bg-muted/30 p-4">
    {loading ? <Skeleton label="Loading plugin releases" /> : versions.length ? <label className="grid gap-2 text-sm">Release<select className={control} disabled={busy || server.pluginsInstalling} value={versionId} onChange={(event) => setVersionId(event.target.value)}>{versions.map((version) => <option value={version.id} key={version.id}>{version.name} · {version.published.slice(0, 10)}</option>)}</select></label> : !error && <p>No stable release supports this server software and Minecraft version.</p>}
    {planning && <Skeleton label="Checking required dependencies" />}
    {plan && !planning && <><h4 className="mt-4 font-semibold">Review installation</h4><p className="mt-1 text-sm text-muted-foreground">These files include required dependencies. Existing files will not be overwritten.</p><ul className="mt-3 divide-y divide-border">{plan.items.map((item) => <li key={item.id} className="py-2 text-sm"><a className="underline" href={`https://modrinth.com/project/${item.projectId}`} target="_blank" rel="noreferrer">{item.name}</a><span className="ml-2 text-muted-foreground">{size(item.size)}</span><span className="mt-1 block break-all font-mono text-xs text-muted-foreground">{item.filename}</span></li>)}</ul>
      <button className={`${button} mt-4`} disabled={busy || server.pluginsInstalling || server.pid !== null || !['stopped', 'crashed'].includes(server.status)} onClick={() => void install()}>{busy || server.pluginsInstalling ? 'Installing…' : `Install ${plan.items.length === 1 ? 'plugin' : `${plan.items.length} plugins`}`}</button></>}
    {error && <p role="alert" className="mt-3 text-destructive">{error} <button className="underline" disabled={busy} onClick={() => setRetry((value) => value + 1)}>Retry</button></p>}
  </div>
}
