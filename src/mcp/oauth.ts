/**
 * Browser sign-in for remote MCP servers. Tokens are stored per server URL, so a config naming a
 * different URL cannot reuse them. They sit in a private file rather than the system keychain.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { OAuthClientMetadata, OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { APP_DISPLAY_NAME, appHome } from '../config/paths.ts';
import type { McpOAuthConfig } from './config.ts';

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

interface StoredAuth {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  /** The client registration is only good for the redirect address it was made with. */
  redirectUri?: string;
}

export function authFilePath(serverUrl: string): string {
  const id = createHash('sha256').update(serverUrl).digest('hex').slice(0, 24);
  return join(appHome(), 'mcp-auth', `${id}.json`);
}

function readStored(serverUrl: string): StoredAuth {
  try {
    return JSON.parse(readFileSync(authFilePath(serverUrl), 'utf8')) as StoredAuth;
  } catch {
    return {};
  }
}

function writeStored(serverUrl: string, stored: StoredAuth): void {
  const path = authFilePath(serverUrl);
  mkdirSync(join(appHome(), 'mcp-auth'), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
}

export function hasStoredTokens(serverUrl: string): boolean {
  return readStored(serverUrl).tokens !== undefined;
}

export function clearStoredAuth(serverUrl: string): boolean {
  const path = authFilePath(serverUrl);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

/**
 * Metadata from a server decides where this URL points. Only http and https go to the browser,
 * so a hostile server cannot make the machine open a local file or launch a custom handler.
 */
export function openInBrowser(url: URL): void {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Refusing to open a ${url.protocol} URL.`);
  }
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  const child = spawn(command, [url.href], { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
}

export class StoredOAuthProvider implements OAuthClientProvider {
  private readonly serverUrl: string;
  private readonly config: McpOAuthConfig | undefined;
  private readonly redirect: string | undefined;
  private readonly onAuthorize: (url: URL) => void | Promise<void>;
  private verifier = '';
  readonly expectedState = randomBytes(24).toString('hex');

  constructor(serverUrl: string, config: McpOAuthConfig | undefined, redirect: string | undefined, onAuthorize: (url: URL) => void | Promise<void> = () => {}) {
    this.serverUrl = serverUrl;
    this.config = config;
    this.redirect = redirect;
    this.onAuthorize = onAuthorize;
  }

  get redirectUrl(): string | undefined {
    return this.redirect ?? readStored(this.serverUrl).redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: APP_DISPLAY_NAME,
      redirect_uris: this.redirectUrl ? [this.redirectUrl] : [],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(this.config?.scopes ? { scope: this.config.scopes } : {}),
    };
  }

  state(): string {
    return this.expectedState;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    if (this.config?.clientId) return { client_id: this.config.clientId };
    const stored = readStored(this.serverUrl);
    // A new redirect port means a new registration. Otherwise the server rejects the redirect.
    if (this.redirect && stored.redirectUri !== this.redirect) return undefined;
    return stored.clientInformation;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    writeStored(this.serverUrl, {
      ...readStored(this.serverUrl),
      clientInformation,
      ...(this.redirect ? { redirectUri: this.redirect } : {}),
    });
  }

  tokens(): OAuthTokens | undefined {
    return readStored(this.serverUrl).tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    writeStored(this.serverUrl, { ...readStored(this.serverUrl), tokens, ...(this.redirect ? { redirectUri: this.redirect } : {}) });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.onAuthorize(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    return this.verifier;
  }
}

export interface CallbackListener {
  redirectUri: string;
  /** Resolves with the authorization code once the browser comes back with the right state. */
  code(expectedState: string, signal?: AbortSignal): Promise<string>;
  close(): void;
}

const CALLBACK_PAGE = `<!doctype html><meta charset="utf-8"><title>${APP_DISPLAY_NAME}</title><p>Signed in. You can close this window and return to the terminal.</p>`;
const CALLBACK_ERROR_PAGE = `<!doctype html><meta charset="utf-8"><title>${APP_DISPLAY_NAME}</title><p>Sign-in did not complete. Return to the terminal for details.</p>`;

/** Listens only on the loopback address, for the moment of a login. */
export async function listenForCallback(port = 0): Promise<CallbackListener> {
  let settle: { resolve: (query: URLSearchParams) => void } | undefined;
  const pendingQueries: URLSearchParams[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    const failed = url.searchParams.has('error') || !url.searchParams.has('code');
    res.writeHead(failed ? 400 : 200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(failed ? CALLBACK_ERROR_PAGE : CALLBACK_PAGE);
    if (settle) settle.resolve(url.searchParams);
    else pendingQueries.push(url.searchParams);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const actualPort = (server.address() as AddressInfo).port;

  return {
    redirectUri: `http://localhost:${actualPort}/callback`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
    code: (expectedState, signal) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for the browser sign-in.')), LOGIN_TIMEOUT_MS);
        timer.unref();
        const onAbort = (): void => {
          clearTimeout(timer);
          reject(new Error('Sign-in was cancelled.'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        const handle = (query: URLSearchParams): void => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          const error = query.get('error');
          if (error) {
            reject(new Error(`The server refused sign-in: ${error}${query.get('error_description') ? ` (${query.get('error_description')})` : ''}`));
          } else if (query.get('state') !== expectedState) {
            // Another site or process could be trying to complete a login it started itself.
            reject(new Error('Sign-in failed: the response did not match this request.'));
          } else {
            resolve(query.get('code') ?? '');
          }
        };
        const queued = pendingQueries.shift();
        if (queued) handle(queued);
        else settle = { resolve: handle };
      }),
  };
}
