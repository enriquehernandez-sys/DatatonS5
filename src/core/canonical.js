/**
 * Serialización canónica (determinista).
 *
 * Un mismo documento debe producir SIEMPRE la misma secuencia de bytes,
 * sin importar el orden de las llaves ni el proceso que lo lea. Sin esto,
 * el hash de una denuncia cambiaría aunque su contenido no cambie.
 */
import { BSON } from 'mongodb';

/** Ordena recursivamente las llaves de objetos planos. */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

/**
 * JSON estable para estructuras propias del ledger (solo cadenas, enteros,
 * booleanos, null, arreglos y objetos). Es fácil de replicar en otros
 * lenguajes para auditorías independientes.
 */
export function stableStringify(value) {
  return JSON.stringify(sortKeys(value));
}

/**
 * Serialización canónica de un documento de MongoDB del S5.
 * Usa Extended JSON *canónico* para preservar tipos BSON
 * (ObjectId, Date, Decimal128, Long, Binary…) y después ordena llaves.
 */
export function canonicalDocument(doc) {
  const ejson = BSON.EJSON.serialize(doc, { relaxed: false });
  return stableStringify(ejson);
}

/** Convierte un identificador de MongoDB a texto estable. */
export function idToString(id) {
  if (id === null || id === undefined) throw new Error('Identificador vacío');
  if (typeof id === 'string') return id;
  if (id instanceof BSON.ObjectId || id?._bsontype === 'ObjectId') return id.toHexString();
  if (typeof id === 'number') return String(id);
  return canonicalDocument({ id });
}
