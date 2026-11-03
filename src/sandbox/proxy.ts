/**
 * The only way out to the network for a sandboxed command. It runs outside the sandbox and checks
 * each connection's hostname. TLS is tunnelled untouched, so it sees names, not contents.
 */
import { lookup } from 'node:dns/promises';
import { connect, createServer, isIP } from 'node:net';
import type { Server, Socket } from 'node:net';

const MAX_HEADER_BYTES = 64 * 1024;

export interface ProxyPolicy {
  allowedDomains: string[];
  deniedDomains: string[];
}

export interface RunningProxy {
  port: number;
  close(): Promise<void>;
}

/** `example.com` matches only itself; `*.example.com` matches its subdomains. A port narrows either. */
function entryMatches(entry: string, host: string, port: number): boolean {
  const lowered = entry.toLowerCase();
  const colon = lowered.lastIndexOf(':');
  const hasPort = colon > 0 && /^\d+$/.test(lowered.slice(colon + 1));
  const name = hasPort ? lowered.slice(0, colon) : lowered;
  if (hasPort && Number(lowered.slice(colon + 1)) !== port) return false;
  if (name.startsWith('*.')) return host.endsWith(name.slice(1)) && host.length > name.length - 1;
  return host === name;
}

export function hostDecision(policy: ProxyPolicy, host: string, port: number): boolean {
  const lowered = host.toLowerCase();
  if (policy.deniedDomains.some((entry) => entryMatches(entry, lowered, port))) return false;
  return policy.allowedDomains.some((entry) => entryMatches(entry, lowered, port));
}

export function isLocalAddress(address: string): boolean {
  const v4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split('.').map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const lowered = address.toLowerCase();
  return lowered === '::1' || lowered === '::' || /^f[cd]/.test(lowered) || /^fe[89ab]/.test(lowered);
}

/** A public name that resolves to a local address could reach services on this machine. */
async function reachesOnlyLocal(host: string): Promise<boolean> {
  if (isIP(host)) return isLocalAddress(host);
  try {
    const addresses = await lookup(host, { all: true });
    return addresses.length === 0 || addresses.every((entry) => isLocalAddress(entry.address));
  } catch {
    return true;
  }
}

/** Closes fully. A half-closed socket here would keep the server, and so the session, from exiting. */
function refuse(client: Socket, status: string, why: string): void {
  client.end(`HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\nConnection: close\r\nX-Cairn-Sandbox: blocked\r\n\r\n${why}\n`, () => client.destroy());
}

function splitTarget(authority: string, defaultPort: number): { host: string; port: number } | null {
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(authority);
  if (!match) return null;
  return { host: match[1]!.replace(/^\[|\]$/g, ''), port: match[2] ? Number(match[2]) : defaultPort };
}

async function open(client: Socket, policy: ProxyPolicy, host: string, port: number, onConnected: (upstream: Socket) => void): Promise<void> {
  if (!hostDecision(policy, host, port)) {
    refuse(client, '403 Forbidden', `The sandbox does not allow connections to ${host}. Add it to sandbox.network.allowedDomains to allow it.`);
    return;
  }
  // An address written out in allowedDomains is a deliberate choice, as with a local service.
  const namedExactly = isIP(host) !== 0;
  if (!namedExactly && (await reachesOnlyLocal(host))) {
    refuse(client, '403 Forbidden', `The sandbox refused ${host} because it resolves only to local addresses.`);
    return;
  }
  const upstream = connect(port, host, () => onConnected(upstream));
  upstream.on('error', () => refuse(client, '502 Bad Gateway', `Could not connect to ${host}.`));
  // Once a tunnel ends on either side, nothing more can cross it.
  upstream.on('close', () => client.destroy());
  client.on('error', () => upstream.destroy());
  client.on('close', () => upstream.destroy());
}

function handle(client: Socket, policy: ProxyPolicy): void {
  let buffered = Buffer.alloc(0);
  client.on('error', () => {});
  const onData = (chunk: Buffer): void => {
    buffered = Buffer.concat([buffered, chunk]);
    const end = buffered.indexOf('\r\n\r\n');
    if (end === -1) {
      if (buffered.length > MAX_HEADER_BYTES) refuse(client, '431 Request Header Fields Too Large', 'Request head too large.');
      return;
    }
    client.off('data', onData);
    client.pause();
    const head = buffered.subarray(0, end).toString('latin1');
    const rest = buffered.subarray(end + 4);
    const [requestLine = '', ...headers] = head.split('\r\n');
    const [method = '', target = '', version = 'HTTP/1.1'] = requestLine.split(' ');

    if (method === 'CONNECT') {
      const parsed = splitTarget(target, 443);
      if (!parsed) return refuse(client, '400 Bad Request', 'Could not read the target.');
      void open(client, policy, parsed.host, parsed.port, (upstream) => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (rest.length > 0) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
      });
      return;
    }

    let url: URL;
    try {
      url = new URL(target);
    } catch {
      return refuse(client, '400 Bad Request', 'This is a proxy: it expects an absolute URL.');
    }
    if (url.protocol !== 'http:') return refuse(client, '400 Bad Request', 'Only http URLs can be forwarded. Use CONNECT for anything else.');
    void open(client, policy, url.hostname.replace(/^\[|\]$/g, ''), Number(url.port || 80), (upstream) => {
      // One request per connection, so a later request cannot reuse this one to reach another host.
      const kept = headers.filter((line) => !/^(proxy-connection|connection):/i.test(line));
      upstream.write(`${method} ${url.pathname}${url.search} ${version}\r\n${[...kept, 'Connection: close'].join('\r\n')}\r\n\r\n`);
      if (rest.length > 0) upstream.write(rest);
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
  };
  client.on('data', onData);
}

export function startProxy(policy: ProxyPolicy): Promise<RunningProxy> {
  return new Promise((resolve, reject) => {
    const clients = new Set<Socket>();
    const server: Server = createServer((client) => {
      clients.add(client);
      client.once('close', () => clients.delete(client));
      handle(client, policy);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address !== 'object' || address === null) {
        reject(new Error('The sandbox proxy did not get a port.'));
        return;
      }
      server.unref();
      resolve({
        port: address.port,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            for (const client of clients) client.destroy();
          }),
      });
    });
  });
}
