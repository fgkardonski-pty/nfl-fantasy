/**
 * At-rest encryption for OAuth material.
 *
 * Yahoo refresh tokens are long-lived credentials to a real account. They are
 * AES-256-GCM encrypted with a key derived from ORACLE_SECRET before they ever
 * touch the database file.
 */
import crypto from 'node:crypto';

const SALT = 'gridiron-oracle/v1';

function deriveKey(secret) {
  if (!secret || secret.length < 16) {
    throw new Error(
      'ORACLE_SECRET must be set to at least 16 characters before storing credentials. ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return crypto.scryptSync(secret, SALT, 32);
}

export function encrypt(plaintext, secret) {
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
}

export function decrypt(payload, secret) {
  if (typeof payload !== 'string' || !payload.startsWith('v1.')) {
    throw new Error('Unrecognised ciphertext format');
  }
  const [, ivB, tagB, dataB] = payload.split('.');
  const key = deriveKey(secret);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

/** RFC 7636 PKCE pair. Yahoo supports S256; we always use it. */
export function pkcePair() {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge, method: 'S256' };
}

export const timingSafeEqual = (a, b) => {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
};
