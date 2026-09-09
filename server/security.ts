import { randomBytes } from 'node:crypto'

export function sessionToken(header = ''): string | undefined {
  try {
    return header.split(';').map((part) => part.trim().split('='))
      .find(([key]) => key === 'md_session')?.slice(1).map(decodeURIComponent).join('=')
  } catch { return undefined }
}

export function validOrigin(origin: string | undefined, host: string | undefined, secure: boolean) {
  if (!origin) return true // Non-browser clients do not send Origin.
  try { return new URL(origin).origin === `${secure ? 'https' : 'http'}://${host}` } catch { return false }
}

type SessionSocket = { terminate(): void }
export class Sessions {
  private sessions = new Map<string, { expires: number; sockets: Set<SessionSocket> }>()
  constructor(private lifetimeMs: number, private now = Date.now) {}
  create() {
    const token = randomBytes(32).toString('base64url')
    this.sessions.set(token, { expires: this.now() + this.lifetimeMs, sockets: new Set() })
    return token
  }
  valid(token: string | undefined): token is string {
    if (!token) return false
    const session = this.sessions.get(token)
    if (!session || session.expires <= this.now()) { this.revoke(token); return false }
    return true
  }
  attach(token: string, socket: SessionSocket) {
    if (!this.valid(token)) { socket.terminate(); return false }
    this.sessions.get(token)!.sockets.add(socket)
    return true
  }
  detach(token: string, socket: SessionSocket) { this.sessions.get(token)?.sockets.delete(socket) }
  revoke(token: string) {
    const session = this.sessions.get(token)
    this.sessions.delete(token)
    for (const socket of session?.sockets ?? []) socket.terminate()
  }
  clear() { for (const token of this.sessions.keys()) this.revoke(token) }
  expire() { for (const token of this.sessions.keys()) this.valid(token) }
}
