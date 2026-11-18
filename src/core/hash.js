import { createHash, createHmac } from 'node:crypto';
import { canonicalDocument } from './canonical.js';

export const sha256 = (data) => createHash('sha256').update(data).digest();
export const sha256Hex = (data) => sha256(data).toString('hex');

/**
 * Huella digital de una denuncia del S5.
 *
 * - `exclude`: campos de primer nivel que NO forman parte del contenido
 *   protegido (p. ej. contadores de lectura o marcas técnicas volátiles).
 * - `pepper`: secreto opcional. Si se define se usa HMAC-SHA256, de modo
 *   que nadie sin el secreto pueda confirmar por fuerza bruta el contenido
 *   de una denuncia a partir de su hash (protección de denunciantes).
 */
export function hashDenuncia(doc, { exclude = [], pepper = null } = {}) {
  if (!doc || typeof doc !== 'object') throw new Error('Documento inválido');
  const copy = { ...doc };
  for (const field of exclude) delete copy[field];
  const data = canonicalDocument(copy);
  if (pepper) return createHmac('sha256', pepper).update(data).digest('hex');
  return sha256Hex(data);
}
