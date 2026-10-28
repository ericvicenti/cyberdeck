import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ProbeTransport, peerBaseUrl } from '../src/daemon/probe';

const id = '12345678-1234-1234-1234-123456789abc';
test('Probe carries real HTTP and binary/text WebSockets; no VPN fallback after revocation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cyberdeck-probe-'));
  const peer = Bun.serve({ port: 0, hostname: '127.0.0.1',
    fetch(req, server) { if (new URL(req.url).pathname === '/socket' && server.upgrade(req)) return; return Response.json({ authorization: req.headers.get('authorization'), method: req.method, path: new URL(req.url).pathname }); },
    websocket: { message(ws, data) { ws.send(data); } },
  });
  const oldTarget = process.env.PROBE_TEST_TARGET, oldLaunches = process.env.PROBE_TEST_LAUNCHES;
  process.env.PROBE_TEST_TARGET = String(peer.port); process.env.PROBE_TEST_LAUNCHES = join(dir, 'launches');
  const shim = join(dir, 'ssh');
  writeFileSync(shim, `#!/bin/sh\nexec '${process.execPath}' '${resolve('tests/fixtures/probe-ssh.ts')}' "$@"\n`); chmodSync(shim, 0o700);
  const directory = { account: 'Test', device: 'self', broker: { host: 'relay.example' }, devices: [{ id, name: 'Linux', port: null, sshPort: 22000, online: true }] };
  const save = () => writeFileSync(join(dir, 'fleet.json'), JSON.stringify(directory)); save();
  writeFileSync(join(dir, 'status.json'), JSON.stringify({ synced: Date.now() / 1000 }));
  const transport = new ProbeTransport(dir, shim);
  try {
    expect(transport.match('linux')?.id).toBe(id);
    const urls = await Promise.all([transport.url(id), transport.url(id), transport.url(id)]);
    expect(new Set(urls).size).toBe(1);
    expect(readFileSync(join(dir, 'launches'), 'utf8').trim().split('\n')).toHaveLength(1);
    const response = await fetch(urls[0] + '/api/files', { method: 'POST', headers: { authorization: 'Bearer peer-secret' } });
    expect(await response.json()).toEqual({ authorization: 'Bearer peer-secret', method: 'POST', path: '/api/files' });
    const frames = await new Promise<(string | number[])[]>((resolve, reject) => {
      const ws = new WebSocket(urls[0]!.replace('http:', 'ws:') + '/socket'); ws.binaryType = 'arraybuffer';
      const timer = setTimeout(() => { ws.close(); reject(new Error('WebSocket timeout')); }, 3000);
      const got: (string | number[])[] = [];
      ws.onopen = () => { ws.send('terminal-input'); ws.send(new Uint8Array([0, 255, 42])); };
      ws.onmessage = e => { got.push(typeof e.data === 'string' ? e.data : [...new Uint8Array(e.data)]); if (got.length === 2) { clearTimeout(timer); ws.close(); resolve(got); } };
      ws.onerror = reject;
    });
    expect(frames).toEqual(['terminal-input', [0, 255, 42]]);
    directory.devices = []; save();
    await expect(transport.url(id)).rejects.toThrow('no longer enrolled');
    await expect(peerBaseUrl({ id: 'peer', url: 'http://legacy.invalid', probe_device: id })).rejects.toThrow('not enabled');
    directory.devices = [{ id, name: 'Linux', port: null, sshPort: 22000, online: true }]; save();
    writeFileSync(join(dir, 'status.json'), JSON.stringify({ synced: 0 }));
    await expect(transport.url(id)).rejects.toThrow('stale');
  } finally {
    transport.close(); peer.stop(true);
    if (oldTarget == null) delete process.env.PROBE_TEST_TARGET; else process.env.PROBE_TEST_TARGET = oldTarget;
    if (oldLaunches == null) delete process.env.PROBE_TEST_LAUNCHES; else process.env.PROBE_TEST_LAUNCHES = oldLaunches;
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);

test('offline Probe nodes do not fall back to an old SSH alias', async () => {
  const { resolveHost } = await import('../src/shared/fleetview');
  const route = resolveHost({ host: 'Mac', me: 'Here', hosts: [{ name: 'Mac', ssh: 'mac.tailnet' }],
    nodes: [{ id: 'mac', name: 'Mac', online: false, probe_device: id }] });
  expect(route.kind).toBe('none');
});
