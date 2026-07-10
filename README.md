# MineDeck

MineDeck is a lightweight, self-hosted Minecraft server manager for macOS. It runs each server directly with Java and exposes a password-protected dashboard to browsers on your local network.

## What it does

- Starts, gracefully stops, restarts, and force-kills multiple Java servers
- Streams console output over WebSockets and sends console commands
- Shows status, uptime, Java CPU/RAM, online players, and crash history
- Optionally restarts a server five seconds after an unexpected exit
- Edits server launch settings, memory limits, Java arguments, and stop timeout
- Browses files, uploads binary files, and syntax-highlights editable text/config files inside each server folder
- Moves deleted files to the host machine's Trash or Recycle Bin so they remain recoverable
- Protects the dashboard with scrypt-hashed passwords, rate-limited login, HttpOnly sessions, origin checks, and optional HTTPS

No Docker, virtual machine, Redis, MariaDB, or external control panel is involved. Configuration is stored atomically in `data/minedeck.json`.

## Run on macOS

Requirements: Node.js 22.12 or newer, plus the Java version required by your Minecraft server.

```bash
git clone <this-repository>
cd MineDeckRemote
npm install
npm run build
MINEDECK_PASSWORD='use-a-long-unique-password' npm start
```

Open [http://localhost:8787](http://localhost:8787). `MINEDECK_PASSWORD` is only used to create the first password hash. If it is omitted on first launch, MineDeck prints a random password once in the terminal.

For later starts, use:

```bash
npm start
```

MineDeck binds to `0.0.0.0` by default and prints the LAN URL at startup. On another PC on the same network, open `http://<your-mac-ip>:8787`. If macOS asks, allow incoming connections for Node. Do not port-forward MineDeck directly to the public internet.

## Add a Minecraft server

Prepare the server normally first: place its JAR in its own folder and accept Mojang's EULA in `eula.txt`. In MineDeck, add:

- an easy-to-recognize name;
- the absolute server folder, such as `/Users/alex/minecraft/survival`;
- a JAR path relative to that folder, usually `server.jar`;
- the Java command (`java` uses the system installation) and memory limits.

**Import existing** reads launch settings from `start.bat` when present. If there is no batch file, it selects `server.jar` (or the only top-level JAR) and uses `java`, 1 GB minimum RAM, and 2 GB maximum RAM as editable defaults. Use **Manual setup** when a folder contains multiple JARs and none is named `server.jar`.

Java arguments are entered one per line. MineDeck always adds `-jar <jar> nogui`. A server configuration cannot be changed or removed while its process is running, and the same server cannot be started twice.

The file browser is confined to that server folder, including through symbolic links. It syntax-highlights YAML, JSON, properties, TOML, XML, and shell files and edits text files up to 2 MB. Editor shortcuts follow the browser platform: Windows and Linux use `Ctrl` while macOS uses `⌘`. Uploads support up to 20 files at a time and 512 MB per file. Uploaded files never overwrite an existing name. Deleting a file sends it to the Trash or Recycle Bin of the machine running MineDeck; the API does not permanently unlink it.

## HTTPS and settings

Plain HTTP is usually adequate only on a trusted home LAN. For encrypted login and WebSockets, provide a certificate and key:

```bash
MINEDECK_TLS_CERT=/absolute/path/to/cert.pem \
MINEDECK_TLS_KEY=/absolute/path/to/key.pem \
npm start
```

Other settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `MINEDECK_HOST` | `0.0.0.0` | Listening interface |
| `MINEDECK_PORT` | `8787` | Dashboard port |
| `MINEDECK_DATA` | `data/minedeck.json` | JSON data file |

Stopping MineDeck gracefully stops its managed servers before exiting. Login sessions are intentionally memory-only, so an app restart signs browsers out.

## Development

```bash
npm run dev
npm test
npm run build
```

The Vite dashboard runs on port 5173 in development and proxies the API/WebSocket connection to Fastify on port 8787.
