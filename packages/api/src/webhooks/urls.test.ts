import { describe, expect, it } from 'vitest'
import { validateWebhookUrl } from './urls.js'

// API7 cycle 1 (D13): one case per rule. A refusal says why; an accepted URL is a public https host.
const ok = (url: string, allowInsecure = false) => expect(validateWebhookUrl(url, { allowInsecure }), url).toEqual({ ok: true })
const no = (url: string, allowInsecure = false) => {
  const v = validateWebhookUrl(url, { allowInsecure })
  expect(v.ok, url).toBe(false)
  if (!v.ok) expect(v.reason.length, url).toBeGreaterThan(5)
}

describe('scheme and shape', () => {
  it('accepts a public https host, with a port, a path and a query', () => {
    for (const u of ['https://example.com/hook', 'https://hooks.example.co.uk:8443/a/b?x=1', 'https://example.com', 'https://203.0.113.7/hook']) ok(u)
  })
  it('refuses http://, other schemes and text that is not a URL', () => {
    for (const u of ['http://example.com/hook', 'ftp://example.com/x', 'ws://example.com', 'example.com/hook', 'not a url', '', 'https://', '//example.com']) no(u)
  })
  it('refuses credentials in the authority', () => {
    for (const u of ['https://user:pw@example.com/hook', 'https://user@example.com/hook', 'https://:pw@example.com/hook']) no(u)
  })
  it('refuses 2 049 characters and accepts 2 048', () => {
    const base = 'https://example.com/'
    ok(base + 'a'.repeat(2048 - base.length))
    no(base + 'a'.repeat(2049 - base.length))
  })
})

describe('hosts', () => {
  it('refuses localhost in every spelling', () => {
    for (const u of ['https://localhost/hook', 'https://LOCALHOST:3000/hook', 'https://localhost./hook', 'https://api.localhost/hook']) no(u)
  })
  it('refuses IPv4 literals in loopback, private, link-local and unspecified ranges', () => {
    for (const h of ['127.0.0.1', '127.255.255.254', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.0.1', '192.168.255.255', '169.254.169.254', '169.254.0.1', '0.0.0.0']) no(`https://${h}/hook`)
  })
  it('accepts the public addresses beside those ranges', () => {
    for (const h of ['172.15.255.255', '172.32.0.0', '192.167.255.255', '192.169.0.0', '11.0.0.1', '9.255.255.255', '169.253.255.255', '169.255.0.0', '126.255.255.255', '128.0.0.1']) ok(`https://${h}/hook`)
  })
  it('CGNAT 100.64.0.0/10: one boundary address each side', () => {
    ok('https://100.63.255.255/hook')
    no('https://100.64.0.0/hook')
    no('https://100.127.255.255/hook')
    ok('https://100.128.0.0/hook')
  })
  it('refuses IPv4 written another way (the URL parser normalises it)', () => {
    for (const u of ['https://2130706433/hook', 'https://0x7f000001/hook', 'https://127.1/hook', 'https://0177.0.0.1/hook']) no(u)
  })
  it('refuses IPv6 literals: loopback, unspecified, unique local, link-local, and IPv4-mapped private or loopback', () => {
    for (const h of ['[::1]', '[::]', '[fc00::1]', '[fd12:3456::1]', '[fe80::1]', '[febf::1]', '[::ffff:10.0.0.1]', '[::ffff:7f00:1]', '[::ffff:100.64.0.1]', '[::ffff:169.254.169.254]', '[fec0::1]', '[64:ff9b::a00:1]']) no(`https://${h}/hook`)
  })
  it('accepts a public IPv6 literal and a mapped public IPv4', () => {
    for (const h of ['[2606:4700:4700::1111]', '[2001:db8::1]', '[::ffff:203.0.113.7]', '[64:ff9b::cb00:7107]']) ok(`https://${h}/hook`)
  })
})

describe('WEBHOOK_ALLOW_INSECURE_URLS (local development)', () => {
  it('admits http:// and loopback hosts', () => {
    for (const u of ['http://localhost:9999/hook', 'https://localhost/hook', 'http://127.0.0.1:8787/hook', 'http://[::1]:8787/hook', 'http://example.com/hook', 'http://api.localhost/hook']) ok(u, true)
  })
  it('still refuses a private, link-local or CGNAT literal, credentials, other schemes and the length limit', () => {
    for (const u of ['http://10.0.0.1/hook', 'https://192.168.1.1/hook', 'http://169.254.169.254/', 'http://100.64.0.1/', 'http://[fc00::1]/', 'http://user:pw@localhost/hook', 'ftp://localhost/x', 'http://localhost/' + 'a'.repeat(2049)]) no(u, true)
  })
})
