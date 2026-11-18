/**
 * Estructura de entradas y bloques de la cadena digital del S5.
 *
 * Entrada  = evidencia de que la denuncia X tenía la huella H en el momento T.
 * Bloque   = conjunto de entradas + raíz de Merkle + hash del bloque anterior,
 *            firmado con Ed25519. Alterar cualquier entrada o bloque pasado
 *            rompe la raíz, el hash, la firma y el enlace con el siguiente.
 */
import { stableStringify } from './canonical.js';
import { sha256Hex } from './hash.js';
import { leafHash, merkleRoot } from './merkle.js';
import { verifySignature } from './signer.js';

export const BLOCK_VERSION = 1;
export const GENESIS_PREV_HASH = '0'.repeat(64);
export const OPERACIONES = Object.freeze(['alta', 'modificacion', 'baja']);
export const ORIGENES = Object.freeze(['flujo', 'conciliacion']);

const HEX64 = /^[0-9a-f]{64}$/;

function entryBody({ denunciaId, version, operacion, hashDocumento, observadoEn, origen }) {
  return { denunciaId, version, operacion, hashDocumento, observadoEn, origen };
}

export function makeEntry(fields) {
  const body = entryBody(fields);
  if (typeof body.denunciaId !== 'string' || !body.denunciaId) throw new Error('denunciaId inválido');
  if (!Number.isInteger(body.version) || body.version < 1) throw new Error('version inválida');
  if (!OPERACIONES.includes(body.operacion)) throw new Error('operacion inválida');
  if (!ORIGENES.includes(body.origen)) throw new Error('origen inválido');
  if (body.hashDocumento !== null && !HEX64.test(body.hashDocumento)) throw new Error('hashDocumento inválido');
  return { entryId: sha256Hex(stableStringify(body)), ...body };
}

/** Hash de hoja de una entrada (lo que entra al árbol de Merkle). */
export function entryLeaf(entry) {
  return leafHash(stableStringify({ entryId: entry.entryId, ...entryBody(entry) }));
}

export function blockHeader(block) {
  const { version, index, timestamp, prevHash, merkleRoot: root, entryCount, keyId } = block;
  return { version, index, timestamp, prevHash, merkleRoot: root, entryCount, keyId };
}

export function computeBlockHash(header) {
  return sha256Hex(stableStringify(header));
}

export function createBlock({ index, prevHash, entries, signer, timestamp = new Date().toISOString() }) {
  const entradas = entries.map((e) => ({ entryId: e.entryId, ...entryBody(e) }));
  const header = {
    version: BLOCK_VERSION,
    index,
    timestamp,
    prevHash,
    merkleRoot: merkleRoot(entradas.map(entryLeaf)),
    entryCount: entradas.length,
    keyId: signer.keyId,
  };
  const hash = computeBlockHash(header);
  return { ...header, hash, signature: signer.sign(hash), entradas };
}

/**
 * Verifica un bloque de manera aislada y, si se da, su enlace con el anterior.
 * Devuelve la lista de errores encontrados (vacía = bloque válido).
 */
export function verifyBlock(block, prevBlock, trustedKeys) {
  const errores = [];
  const err = (m) => errores.push(`Bloque ${block?.index}: ${m}`);
  if (!block || typeof block !== 'object') return ['Bloque ausente o mal formado'];

  if (block.version !== BLOCK_VERSION) err('versión no soportada');
  const entradas = Array.isArray(block.entradas) ? block.entradas : [];
  if (entradas.length !== block.entryCount) err('entryCount no coincide con las entradas');

  for (const [i, e] of entradas.entries()) {
    try {
      if (makeEntry(e).entryId !== e.entryId) err(`entrada ${i} alterada (entryId no coincide)`);
    } catch (ex) {
      err(`entrada ${i} inválida: ${ex.message}`);
    }
  }

  if (merkleRoot(entradas.map(entryLeaf)) !== block.merkleRoot) err('raíz de Merkle no coincide');
  if (computeBlockHash(blockHeader(block)) !== block.hash) err('hash del bloque no coincide');
  if (!verifySignature(trustedKeys, block.keyId, block.hash, block.signature)) {
    err(`firma inválida o llave no confiable (${block.keyId})`);
  }

  if (prevBlock === null) {
    if (block.index !== 0) err('el primer bloque debe tener índice 0');
    if (block.prevHash !== GENESIS_PREV_HASH) err('prevHash del génesis inválido');
  } else if (prevBlock) {
    if (block.index !== prevBlock.index + 1) err(`índice no consecutivo (esperado ${prevBlock.index + 1})`);
    if (block.prevHash !== prevBlock.hash) err('no enlaza con el hash del bloque anterior');
    if (block.timestamp < prevBlock.timestamp) err('marca de tiempo anterior al bloque previo');
  }
  return errores;
}
