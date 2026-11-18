/**
 * Árbol de Merkle con separación de dominios (estilo RFC 6962):
 *   hoja  = SHA256(0x00 || datos)
 *   nodo  = SHA256(0x01 || izquierdo || derecho)
 * Cuando un nivel tiene un número impar de nodos, el último se PROMUEVE
 * sin duplicarse (evita la vulnerabilidad CVE-2012-2459 de Bitcoin).
 */
import { sha256 } from './hash.js';

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

export const EMPTY_ROOT = sha256(Buffer.alloc(0)).toString('hex');

export function leafHash(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  return sha256(Buffer.concat([LEAF_PREFIX, buf])).toString('hex');
}

export function nodeHash(leftHex, rightHex) {
  return sha256(
    Buffer.concat([NODE_PREFIX, Buffer.from(leftHex, 'hex'), Buffer.from(rightHex, 'hex')]),
  ).toString('hex');
}

function nextLevel(level) {
  const next = [];
  for (let i = 0; i < level.length; i += 2) {
    next.push(i + 1 < level.length ? nodeHash(level[i], level[i + 1]) : level[i]);
  }
  return next;
}

/** Raíz de Merkle a partir de hashes de hoja (hex). */
export function merkleRoot(leaves) {
  if (leaves.length === 0) return EMPTY_ROOT;
  let level = leaves;
  while (level.length > 1) level = nextLevel(level);
  return level[0];
}

/**
 * Prueba de inclusión de la hoja `index`.
 * Devuelve la lista de hermanos desde la hoja hasta la raíz.
 */
export function merkleProof(leaves, index) {
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) {
    throw new RangeError('Índice de hoja fuera de rango');
  }
  const proof = [];
  let level = leaves;
  let idx = index;
  while (level.length > 1) {
    const isRight = idx % 2 === 1;
    const sibling = isRight ? idx - 1 : idx + 1;
    if (sibling < level.length) {
      proof.push({ lado: isRight ? 'izquierda' : 'derecha', hash: level[sibling] });
    } // si no hay hermano, el nodo se promueve y no aporta paso a la prueba
    level = nextLevel(level);
    idx = Math.floor(idx / 2);
  }
  return proof;
}

/** Verifica una prueba de inclusión. */
export function verifyProof(leafHex, proof, rootHex) {
  let acc = leafHex;
  for (const step of proof) {
    if (!/^[0-9a-f]{64}$/.test(step.hash)) return false;
    if (step.lado === 'izquierda') acc = nodeHash(step.hash, acc);
    else if (step.lado === 'derecha') acc = nodeHash(acc, step.hash);
    else return false;
  }
  return acc === rootHex;
}
