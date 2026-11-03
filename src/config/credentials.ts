/**
 * API keys saved with `cairn provider key` or /provider, in ~/.cairn/credentials.json with mode
 * 0600. Keys never go into settings files, which a project may share.
 *
 * Each key is saved with the endpoint it was entered for, and is only ever sent there. Otherwise
 * a project's settings could point a provider name at another server and collect the key.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { credentialsPath } from './paths.ts';

export interface StoredKey {
  apiKey: string;
  /** Where requests went when the key was saved. */
  endpoint: string;
  savedAt: string;
}

interface CredentialsFile {
  providers: Record<string, StoredKey>;
}

function read(): CredentialsFile {
  const path = credentialsPath();
  if (!existsSync(path)) return { providers: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CredentialsFile>;
    return { providers: parsed.providers && typeof parsed.providers === 'object' ? parsed.providers : {} };
  } catch (error) {
    throw new Error(`${path} is not valid JSON (${(error as Error).message}). Fix or delete it.`);
  }
}

function write(file: CredentialsFile): void {
  const path = credentialsPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // A new file renamed into place, so the key is never in a file anyone else can read.
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

/** Endpoints compared without a trailing slash or letter case in the host. */
export function sameEndpoint(a: string, b: string): boolean {
  const normalize = (url: string): string => {
    try {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}`;
    } catch {
      return url.replace(/\/+$/, '');
    }
  };
  return normalize(a) === normalize(b);
}

export function storedKey(provider: string): StoredKey | undefined {
  const entry = read().providers[provider];
  return entry && typeof entry.apiKey === 'string' && entry.apiKey ? entry : undefined;
}

export function saveKey(provider: string, apiKey: string, endpoint: string): void {
  const file = read();
  file.providers[provider] = { apiKey, endpoint, savedAt: new Date().toISOString() };
  write(file);
}

export function deleteKey(provider: string): boolean {
  const file = read();
  if (!(provider in file.providers)) return false;
  delete file.providers[provider];
  write(file);
  return true;
}
