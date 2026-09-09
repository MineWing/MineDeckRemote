import test from 'node:test'
import assert from 'node:assert/strict'
import { sessionToken, Sessions, validOrigin } from './security.ts'

test('malformed session cookies are rejected without throwing', () => {
  for (const cookie of ['md_session=%', 'md_session=%A', 'md_session=%GG']) assert.equal(sessionToken(cookie), undefined)
  assert.equal(sessionToken('other=value; md_session=valid'), 'valid')
  assert.equal(sessionToken(), undefined)
})

test('browser origins must match protocol and host and malformed origins are rejected', () => {
  assert.equal(validOrigin('http://localhost:8787', 'localhost:8787', false), true)
  for (const origin of ['https://localhost:8787', 'http://evil.test', 'null', '%']) assert.equal(validOrigin(origin, 'localhost:8787', false), false)
  assert.equal(validOrigin(undefined, 'localhost:8787', false), true)
})

test('logout and password revocation terminate every associated socket', () => {
  const sessions = new Sessions(100)
  const first = sessions.create(), second = sessions.create()
  let closed = 0
  const socket = () => ({ terminate: () => { closed++ } })
  sessions.attach(first, socket()); sessions.attach(first, socket()); sessions.attach(second, socket())
  sessions.revoke(first)
  assert.equal(closed, 2)
  assert.equal(sessions.valid(first), false)
  assert.equal(sessions.valid(second), true)
  sessions.clear()
  assert.equal(closed, 3)
  assert.equal(sessions.valid(second), false)
})

test('expired sessions terminate sockets even when there is no traffic', () => {
  let now = 0, closed = 0
  const sessions = new Sessions(100, () => now)
  const token = sessions.create()
  sessions.attach(token, { terminate: () => { closed++ } })
  now = 100
  sessions.expire()
  assert.equal(closed, 1)
  assert.equal(sessions.valid(token), false)
  assert.equal(sessions.attach(token, { terminate: () => { closed++ } }), false)
  assert.equal(closed, 2)
})
