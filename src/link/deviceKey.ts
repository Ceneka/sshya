import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDbPath } from '../database';

/**
 * This machine's own SSH key for linked servers. lazybackup never exports the
 * private keys it stores, so instead it installs this public key in each
 * server's authorized_keys (`POST /api/servers/:id/authorize-key`).
 */
export interface DeviceKey {
  path: string;
  publicKey: string;
  fingerprint: string;
}

export const getDeviceKeyPath = (): string => path.join(path.dirname(getDbPath()), 'keys', 'id_ed25519');

/** `SHA256:…` as `ssh-keygen -lf` prints it. */
export const publicKeyFingerprint = (publicKey: string): string | undefined => {
  const blob = publicKey.trim().split(/\s+/)[1];
  if (!blob) {
    return undefined;
  }
  const digest = createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
};

/** lazybackup only accepts `[A-Za-z0-9@._:+-]` in key comments. */
const keyComment = (): string => {
  const host = os.hostname().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return host ? `sshya@${host}` : 'sshya';
};

export const readDeviceKey = (keyPath: string = getDeviceKeyPath()): DeviceKey | undefined => {
  try {
    if (!fs.existsSync(keyPath)) {
      return undefined;
    }
    const publicKey = fs.readFileSync(`${keyPath}.pub`, 'utf8').trim();
    const fingerprint = publicKeyFingerprint(publicKey);
    return fingerprint ? { path: keyPath, publicKey, fingerprint } : undefined;
  } catch {
    return undefined;
  }
};

/** Read the device key, generating an ed25519 pair (no passphrase) on first use. */
export const ensureDeviceKey = (keyPath: string = getDeviceKeyPath()): DeviceKey => {
  const existing = readDeviceKey(keyPath);
  if (existing) {
    return existing;
  }
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  // A private key without its .pub (or vice versa) is unusable: start over.
  fs.rmSync(keyPath, { force: true });
  fs.rmSync(`${keyPath}.pub`, { force: true });
  try {
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', keyComment(), '-f', keyPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim();
    throw new Error(`Could not generate ${keyPath} with ssh-keygen${stderr ? `: ${stderr}` : ''}`);
  }
  const created = readDeviceKey(keyPath);
  if (!created) {
    throw new Error(`ssh-keygen did not produce ${keyPath}.pub`);
  }
  return created;
};
