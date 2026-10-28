#!/usr/bin/env bun
import { createServer, connect } from 'node:net';
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
const spec = args[args.indexOf('-L') + 1]!;
if (!/^127\.0\.0\.1:\d+:127\.0\.0\.1:4777$/.test(spec) || !args.includes('-F') || !args.includes('-oExitOnForwardFailure=yes')) process.exit(2);
appendFileSync(process.env.PROBE_TEST_LAUNCHES!, String(process.pid) + '\n');
const sockets = new Set<import('node:net').Socket>();
const server = createServer(local => {
  const remote = connect(Number(process.env.PROBE_TEST_TARGET!), '127.0.0.1');
  sockets.add(local); sockets.add(remote); local.pipe(remote); remote.pipe(local);
  local.on('error', () => remote.destroy()); remote.on('error', () => local.destroy());
  local.on('close', () => { remote.destroy(); sockets.delete(local); sockets.delete(remote); });
});
server.listen(Number(spec.split(':')[1]), '127.0.0.1');
process.on('SIGTERM', () => { for (const s of sockets) s.destroy(); server.close(); process.exit(0); });
