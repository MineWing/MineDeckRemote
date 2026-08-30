import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { importServerConfig, resolveInside, resolveRecyclableEntry, validateServerConfig, validateUploadName } from './core.ts'
import { parsePlayerListLine, serverLaunchArguments, ServerManager, type StoredData } from './manager.ts'

test('file paths stay inside a server directory, including through symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'minedeck-'))
  const outside = await mkdtemp(join(tmpdir(), 'minedeck-outside-'))
  await mkdir(join(root, 'config'))
  await writeFile(join(root, 'config', 'server.properties'), 'motd=MineDeck')
  assert.equal(await resolveInside(root, 'config/server.properties'), await realpath(join(root, 'config', 'server.properties')))
  await assert.rejects(resolveInside(root, '../secret'))
  await symlink(outside, join(root, 'escape'), 'junction')
  await assert.rejects(resolveInside(root, 'escape'))
})

test('upload names cannot smuggle a path outside the selected directory', () => {
  assert.equal(validateUploadName('paper-1.21.jar'), 'paper-1.21.jar')
  assert.throws(() => validateUploadName('../secret.txt'))
  assert.throws(() => validateUploadName('nested/file.txt'))
  assert.throws(() => validateUploadName('nested\\file.txt'))
  assert.throws(() => validateUploadName(`${'界'.repeat(86)}.txt`))
  assert.throws(() => validateUploadName(''))
})

test('files and folders can be recycled without allowing the server root or symbolic links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'minedeck-recycle-'))
  await mkdir(join(root, 'world'))
  await writeFile(join(root, 'server.properties'), 'motd=MineDeck')
  await symlink(join(root, 'world'), join(root, 'world-link'))

  const canonicalRoot = await realpath(root)
  assert.equal(await resolveRecyclableEntry(root, 'world'), join(canonicalRoot, 'world'))
  assert.equal(await resolveRecyclableEntry(root, 'server.properties'), join(canonicalRoot, 'server.properties'))
  await assert.rejects(resolveRecyclableEntry(root, '.'), /root folder/)
  await assert.rejects(resolveRecyclableEntry(root, 'world-link'), /Only files and folders/)
})

test('player list responses support empty and populated server formats', () => {
  assert.deepEqual(parsePlayerListLine('[19:33:02 INFO]: There are 0 of a max of 20 players online.'), { count: 0, names: [] })
  assert.deepEqual(parsePlayerListLine('[19:33:02 INFO]: There are 2 of a max of 20 players online: Alex, Steve'), { count: 2, names: ['Alex', 'Steve'] })
})

test('server launches keep Java headless so it does not appear in the macOS Dock', () => {
  assert.deepEqual(serverLaunchArguments({
    minMemoryMb: 1024,
    maxMemoryMb: 2048,
    javaArgs: ['-XX:+UseG1GC'],
    jar: 'paper.jar',
  }), [
    '-Xms1024M',
    '-Xmx2048M',
    '-XX:+UseG1GC',
    '-Djava.awt.headless=true',
    '-jar',
    'paper.jar',
    'nogui',
  ])
})

test('the same server JAR cannot be registered twice through path aliases', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'minedeck-server-'))
  await writeFile(join(directory, 'server.jar'), 'placeholder')
  const data: StoredData = { version: 1, servers: [], stats: {} }
  const manager = new ServerManager(data, async () => undefined, () => undefined)
  const config = {
    id: '', name: 'Survival', directory, jar: 'server.jar', javaPath: 'java', minMemoryMb: 1024, maxMemoryMb: 2048,
    javaArgs: [], autoRestart: true, stopTimeoutSeconds: 30, createdAt: new Date().toISOString(),
  }
  await manager.add(config)
  await assert.rejects(manager.add({ ...config, id: '', name: 'Alias', jar: './server.jar' }), /already managed/)
  await manager.shutdown()
})

test('an existing server can be imported from start.bat', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'minedeck-import-'))
  await writeFile(join(directory, 'paper.jar'), 'placeholder')
  await writeFile(join(directory, 'start.bat'), '@echo off\r\n"C:\\Program Files\\Java\\bin\\java.exe" -Xms2G -Xmx4G -XX:+UseG1GC -jar "paper.jar" nogui\r\npause')

  const config = await importServerConfig({ name: 'Existing server', directory })
  assert.equal(config.jar, 'paper.jar')
  assert.equal(config.javaPath, 'C:\\Program Files\\Java\\bin\\java.exe')
  assert.equal(config.minMemoryMb, 2048)
  assert.equal(config.maxMemoryMb, 4096)
  assert.deepEqual(config.javaArgs, ['-XX:+UseG1GC'])
})

test('flags.sh start scripts import memory, server JAR, and Java flags', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'minedeck-import-'))
  await writeFile(join(directory, 'paper server.jar'), 'placeholder')
  await writeFile(join(directory, 'start.sh'), `#!/bin/bash

while [ true ]; do
  java -Xms4096M -Xmx4096M --add-modules=jdk.incubator.vector \\
    -XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 \\
    -XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC -XX:+AlwaysPreTouch \\
    -XX:G1HeapWastePercent=5 -XX:G1MixedGCCountTarget=4 -XX:InitiatingHeapOccupancyPercent=15 \\
    -XX:G1MixedGCLiveThresholdPercent=90 -XX:G1RSetUpdatingPauseTimePercent=5 \\
    -XX:SurvivorRatio=32 -XX:+PerfDisableSharedMem -XX:MaxTenuringThreshold=1 \\
    -Dusing.aikars.flags=https://mcflags.emc.gs -Daikars.new.flags=true \\
    -XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M \\
    -XX:G1ReservePercent=20 \\
    -jar paper\\ server.jar --nogui

  echo Server restarting...
done
`)

  const config = await importServerConfig({ name: 'Flags server', directory })
  assert.equal(config.jar, 'paper server.jar')
  assert.equal(config.javaPath, 'java')
  assert.equal(config.minMemoryMb, 4096)
  assert.equal(config.maxMemoryMb, 4096)
  assert.equal(config.javaArgs.length, 21)
  assert.equal(config.javaArgs[0], '--add-modules=jdk.incubator.vector')
  assert.ok(config.javaArgs.includes('-XX:+UseG1GC'))
  assert.ok(config.javaArgs.includes('-Dusing.aikars.flags=https://mcflags.emc.gs'))
  assert.ok(config.javaArgs.includes('-XX:G1ReservePercent=20'))
})

test('an existing server.jar can be imported without a launch script', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'minedeck-import-'))
  await writeFile(join(directory, 'server.jar'), 'placeholder')

  const config = await importServerConfig({ name: 'Existing server', directory })
  assert.equal(config.jar, 'server.jar')
  assert.equal(config.javaPath, 'java')
  assert.equal(config.minMemoryMb, 1024)
  assert.equal(config.maxMemoryMb, 2048)
})

test('manual setup creates a missing server directory before the JAR is uploaded', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'minedeck-create-'))
  const directory = join(parent, 'servers', 'new-survival')
  const config = await validateServerConfig({
    name: 'New survival',
    directory,
    jar: 'server.jar',
    javaPath: 'java',
    minMemoryMb: 1024,
    maxMemoryMb: 2048,
    javaArgs: [],
    autoRestart: true,
    stopTimeoutSeconds: 30,
  }, undefined, { createDirectory: true, requireJar: false })

  assert.equal(config.directory, await realpath(directory))
  assert.equal((await stat(directory)).isDirectory(), true)

  const data: StoredData = { version: 1, servers: [], stats: {} }
  const manager = new ServerManager(data, async () => undefined, () => undefined)
  await manager.add(config)
  assert.equal(manager.list()[0]?.jar, 'server.jar')
  await manager.shutdown()
})
