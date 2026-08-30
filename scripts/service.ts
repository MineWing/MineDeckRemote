import { spawnSync } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import trash from 'trash'

const LABEL = 'com.minedeck.host'
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const agentDirectory = resolve(homedir(), 'Library/LaunchAgents')
const plistPath = resolve(agentDirectory, `${LABEL}.plist`)
const logDirectory = resolve(projectDirectory, 'data')
const stdoutPath = resolve(logDirectory, 'minedeck.stdout.log')
const stderrPath = resolve(logDirectory, 'minedeck.stderr.log')
const domain = `gui/${process.getuid?.()}`
const service = `${domain}/${LABEL}`

const xml = (value: string) => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&apos;')

const launchctl = (...arguments_: string[]) => spawnSync('/bin/launchctl', arguments_, {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
})

const checkedLaunchctl = (...arguments_: string[]) => {
  const result = launchctl(...arguments_)
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `launchctl ${arguments_.join(' ')} failed`)
  }
  return result.stdout
}

const bootstrap = async () => {
  let lastError = ''
  for (let attempt = 0; attempt < 4; attempt++) {
    const result = launchctl('bootstrap', domain, plistPath)
    if (result.status === 0) return
    lastError = result.stderr.trim() || result.stdout.trim()
    await new Promise((done) => setTimeout(done, 250 * (attempt + 1)))
  }
  throw new Error(lastError || 'launchctl bootstrap failed')
}

const serviceEnvironment = () => {
  const paths = [
    ...(process.env.PATH ?? '').split(':'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ].filter((value, index, all) => value && all.indexOf(value) === index)
  const environment: Record<string, string> = {
    NODE_ENV: 'production',
    MINEDECK_MDNS_HOST: process.env.MINEDECK_MDNS_HOST ?? 'minedeck.local',
    MINEDECK_PREVENT_SLEEP: '1',
    PATH: paths.join(':'),
  }
  for (const name of ['MINEDECK_HOST', 'MINEDECK_PORT', 'MINEDECK_DATA', 'MINEDECK_TLS_CERT', 'MINEDECK_TLS_KEY']) {
    if (process.env[name]) environment[name] = process.env[name]!
  }
  return environment
}

const plist = () => {
  const arguments_ = [process.execPath, '--import', 'tsx', resolve(projectDirectory, 'server/index.ts')]
  const environment = serviceEnvironment()
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${arguments_.map((argument) => `    <string>${xml(argument)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(projectDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(environment).map(([name, value]) => `    <key>${xml(name)}</key>\n    <string>${xml(value)}</string>`).join('\n')}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ExitTimeOut</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${xml(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(stderrPath)}</string>
</dict>
</plist>
`
}

const assertMac = () => {
  if (process.platform !== 'darwin') throw new Error('The MineDeck background service currently supports macOS only')
  if (!process.getuid) throw new Error('Could not determine the current macOS user')
}

const loaded = () => launchctl('print', service).status === 0

const unload = () => {
  if (!loaded()) return
  checkedLaunchctl('bootout', service)
}

const install = async () => {
  await mkdir(agentDirectory, { recursive: true })
  await mkdir(logDirectory, { recursive: true })
  unload()
  const temporary = `${plistPath}.tmp`
  await writeFile(temporary, plist(), { mode: 0o644 })
  await rename(temporary, plistPath)
  await bootstrap()
  console.log(`MineDeck is installed and running as ${LABEL}.`)
  console.log('It will start when you log in and restart automatically if it crashes.')
  console.log(`Logs: ${stdoutPath} and ${stderrPath}`)
}

const restart = () => {
  if (!loaded()) throw new Error('MineDeck is not installed as a service. Run npm run service:install first.')
  checkedLaunchctl('kickstart', '-k', service)
  console.log('MineDeck restarted.')
}

const status = async () => {
  const result = launchctl('print', service)
  if (result.status !== 0) {
    console.log('MineDeck is not installed or is not loaded.')
    process.exitCode = 1
    return
  }
  const details = result.stdout
  const state = details.match(/\bstate = (.+)/)?.[1]?.trim() ?? 'unknown'
  const pid = details.match(/\bpid = (\d+)/)?.[1]
  console.log(`MineDeck service: ${state}${pid ? ` (PID ${pid})` : ''}`)
  for (const path of [stdoutPath, stderrPath]) {
    const content = await readFile(path, 'utf8').catch(() => '')
    const lastLine = content.trim().split('\n').at(-1)
    if (lastLine) console.log(`${basename(path)}: ${lastLine}`)
  }
}

const uninstall = async () => {
  unload()
  const exists = await readFile(plistPath).then(() => true).catch(() => false)
  if (exists) await trash(plistPath, { glob: false })
  console.log(exists
    ? 'MineDeck background startup was disabled and its LaunchAgent was moved to Trash.'
    : 'MineDeck background startup is already disabled.')
  console.log('Your app, configuration, worlds, and logs were not removed.')
}

assertMac()
const command = process.argv[2]
try {
  if (command === 'install') await install()
  else if (command === 'restart') restart()
  else if (command === 'status') await status()
  else if (command === 'uninstall') await uninstall()
  else throw new Error('Usage: tsx scripts/service.ts <install|restart|status|uninstall>')
} catch (error) {
  console.error(`MineDeck service: ${(error as Error).message}`)
  process.exitCode = 1
}
