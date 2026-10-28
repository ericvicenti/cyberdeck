// Probe transports Cyberdeck's complete HTTP/WebSocket protocol inside pinned SSH.
// Enrolled peers never silently fall back to their old VPN address.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createServer, connect } from 'node:net';
import type { Database } from 'bun:sqlite';

type Device = { id: string; name: string; port: number | null; sshPort?: number | null; online: boolean };
type Directory = { account: string; device: string; broker: { host: string }; devices: Device[] };
export type Peer = { id: string; name?: string; url: string; token?: string; probe_device?: string | null };
const uuid = /^[a-f0-9-]{36}$/;
const name = (s: string) => s.toLowerCase().replace(/\.local$/, '');

export class ProbeTransport {
  private tunnels = new Map<string, Promise<{ url: string; child: ReturnType<typeof Bun.spawn> }>>();
  constructor(readonly state: string, readonly ssh = 'ssh') {}
  directory(): { fleet: Directory; fresh: boolean } {
    const fleet = JSON.parse(readFileSync(join(this.state, 'fleet.json'), 'utf8')) as Directory;
    const status = JSON.parse(readFileSync(join(this.state, 'status.json'), 'utf8'));
    if (!Array.isArray(fleet.devices)) throw new Error('Invalid Probe directory');
    return { fleet, fresh: Date.now() - Number(status.synced) * 1000 < 90_000 };
  }
  device(id: string): Device {
    if (!uuid.test(id)) throw new Error('Invalid Probe device');
    const { fleet, fresh } = this.directory();
    if (!fresh) throw new Error('Probe directory is stale; check the network agent');
    const d = fleet.devices.find(d => d.id === id && (d.sshPort || d.port));
    if (!d) throw new Error('Device is no longer enrolled in Probe');
    return d;
  }
  match(host: string): Device | undefined {
    try {
      const found = this.directory().fleet.devices.filter(d => (d.sshPort || d.port) && uuid.test(d.id) && name(d.name) === name(host));
      return found.length === 1 ? found[0] : undefined;
    } catch { return undefined; }
  }
  sshArgs(id: string): string[] {
    this.device(id);
    return ['-F', join(this.state, 'ssh_config'), '-oBatchMode=yes', '-oConnectTimeout=8', 'fleet-' + id];
  }
  async url(id: string): Promise<string> {
    this.device(id); // Check revocation/staleness even when a tunnel already exists.
    let pending = this.tunnels.get(id);
    if (!pending) {
      pending = this.start(id);
      this.tunnels.set(id, pending);
      pending.catch(() => { if (this.tunnels.get(id) === pending) this.tunnels.delete(id); });
    }
    return (await pending).url;
  }
  private async start(id: string) {
    const port = await new Promise<number>((resolve, reject) => {
      const reservation = createServer(); reservation.once('error', reject);
      reservation.listen(0, '127.0.0.1', () => {
        const port = (reservation.address() as { port: number }).port;
        reservation.close(() => resolve(port));
      });
    });
    const args = this.sshArgs(id);
    const child = Bun.spawn([this.ssh, ...args.slice(0, -1), '-N', '-oExitOnForwardFailure=yes',
      '-oServerAliveInterval=10', '-oServerAliveCountMax=2', '-L', `127.0.0.1:${port}:127.0.0.1:4777`, args.at(-1)!],
      { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe', env: process.env });
    // Drain errors without printing credentials or retaining unbounded logs.
    let failure = '';
    void (async () => { const reader = (child.stderr as ReadableStream<Uint8Array>).getReader(); try { while (true) { const {done, value} = await reader.read(); if (done) break; failure = (failure + new TextDecoder().decode(value)).slice(-1500); } } finally { reader.releaseLock(); } })().catch(() => {});
    void child.exited.then(() => { const current = this.tunnels.get(id); void current?.then(t => { if (t.child === child && this.tunnels.get(id) === current) this.tunnels.delete(id); }).catch(() => {}); });
    const deadline = Date.now() + 10_000;
    try {
      while (true) {
        if (child.exitCode !== null) throw new Error('Probe SSH tunnel failed: ' + failure.trim());
        const listening = await new Promise<boolean>(resolve => {
          const socket = connect({ host: '127.0.0.1', port });
          const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
          socket.once('connect', () => done(true)); socket.once('error', () => done(false)); socket.setTimeout(250, () => done(false));
        });
        if (listening) return { url: `http://127.0.0.1:${port}`, child };
        if (Date.now() > deadline) throw new Error('Probe SSH tunnel timed out');
        await Bun.sleep(50); // Poll actual listener readiness; never assume a startup delay means success.
      }
    } catch (e) { child.kill(); throw e; }
  }
  close() { for (const promise of this.tunnels.values()) void promise.then(t => t.child.kill()).catch(() => {}); this.tunnels.clear(); }
}

let transport: ProbeTransport | null = null;
const bindings = new Map<string, string>();
export function configureProbeTransport(settings?: { enabled?: boolean; stateDir?: string }) {
  transport?.close(); bindings.clear();
  transport = settings?.enabled ? new ProbeTransport(settings.stateDir ?? join(homedir(), '.config/probe-network')) : null;
}
export function closeProbeTransport() { transport?.close(); }
export function probeSnapshot() {
  if (!transport) return { enabled: false, paired: false, devices: [] as Device[] };
  try {
    const { fleet, fresh } = transport.directory();
    return { enabled: true, paired: true, account: fleet.account, device: fleet.device, relay: fleet.broker.host, fresh,
      devices: fleet.devices.map(d => ({ id: d.id, name: d.name, port: d.sshPort || d.port, online: fresh && d.online })) };
  } catch { return { enabled: true, paired: false, devices: [] as Device[] }; }
}
export function bindProbeNodes(db: Database) {
  if (!transport) return;
  for (const node of db.query('SELECT id,name FROM nodes WHERE probe_device IS NULL').all() as { id: string; name: string }[]) {
    const device = transport.match(node.name);
    if (device) db.query('UPDATE nodes SET probe_device=? WHERE id=?').run(device.id, node.id);
  }
  for (const row of db.query('SELECT name,probe_device FROM nodes WHERE probe_device IS NOT NULL').all() as { name: string; probe_device: string }[]) bindings.set(name(row.name), row.probe_device);
}
export async function peerBaseUrl(peer: Peer): Promise<string> {
  if (!peer.probe_device) return peer.url;
  if (!transport) throw new Error('Probe networking is not enabled on this node');
  return transport.url(peer.probe_device);
}
export async function transportFetch(peer: Peer & { token: string }, path: string, init?: RequestInit) {
  const base = await peerBaseUrl(peer);
  if (init?.signal?.aborted) throw init.signal.reason;
  return fetch(base + path, { ...init, redirect: 'error',
    headers: { ...(init?.headers as Record<string, string>), authorization: `Bearer ${peer.token}` },
    signal: init?.signal ?? AbortSignal.timeout(15_000) });
}
export function probeSshArgs(host: string): string[] | null {
  const id = bindings.get(name(host)) ?? transport?.match(host)?.id;
  if (!id) return null;
  if (!transport) throw new Error('Probe networking is not enabled on this node');
  return transport.sshArgs(id);
}

export async function probeConsoleTicket() {
  if (!transport) throw new Error('Probe networking is not enabled');
  const membership = JSON.parse(readFileSync(join(transport.state, 'device.json'), 'utf8'));
  const server = new URL(membership.server);
  if (server.protocol !== 'https:') throw new Error('Probe requires HTTPS');
  const response = await fetch(membership.server + '/console-ticket', { method: 'POST', redirect: 'error',
    headers: { authorization: 'Bearer ' + membership.token, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error('Could not approve the fleet console sign-in');
  return response.json();
}
