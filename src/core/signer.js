/**
 * Firma digital Ed25519 de los bloques.
 *
 * La llave PRIVADA solo vive en el proceso "worker" (el sellador).
 * La API y los auditores externos solo necesitan llaves PÚBLICAS de confianza.
 * Soporta rotación: cada bloque guarda el `keyId` con el que fue firmado.
 */
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from './hash.js';

export function keyIdOf(publicKey) {
  return sha256Hex(publicKey.export({ type: 'spki', format: 'der' })).slice(0, 16);
}

export function createSigner(privateKeyPem) {
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('La llave de firma debe ser Ed25519');
  }
  const publicKey = createPublicKey(privateKey);
  const keyId = keyIdOf(publicKey);
  return {
    keyId,
    publicKey,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    sign: (hashHex) => sign(null, Buffer.from(hashHex, 'hex'), privateKey).toString('base64'),
  };
}

export function loadSigner(path, logger) {
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) {
    logger?.warn('La llave privada tiene permisos abiertos; use chmod 600', { path, mode: mode.toString(8) });
  }
  return createSigner(readFileSync(path));
}

/** Carga todas las llaves públicas *.pem de un directorio → Map(keyId → KeyObject). */
export function loadTrustedKeys(dir) {
  const keys = new Map();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.pem')) continue;
    const key = createPublicKey(readFileSync(join(dir, file)));
    if (key.asymmetricKeyType !== 'ed25519') continue;
    keys.set(keyIdOf(key), key);
  }
  if (keys.size === 0) throw new Error(`No hay llaves públicas Ed25519 en ${dir}`);
  return keys;
}

export function verifySignature(trustedKeys, keyId, hashHex, signatureB64) {
  const key = trustedKeys.get(keyId);
  if (!key || typeof signatureB64 !== 'string') return false;
  try {
    return verify(null, Buffer.from(hashHex, 'hex'), key, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}
