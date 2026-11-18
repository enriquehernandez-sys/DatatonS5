/**
 * Verificación FUERA DE LÍNEA de una prueba de inclusión, sin acceso a ninguna base de datos.
 *
 *   node scripts/verificar-prueba.js prueba.json llave-publica.pem [documento.ejson.json]
 *
 * prueba.json es la respuesta de GET /api/v1/denuncias/:id/prueba.
 * Si se da el documento (Extended JSON canónico), también se comprueba que su
 * huella sea la registrada. Requiere el mismo pepper si el servicio lo usa
 * (variable HASH_PEPPER_PATH).
 *
 * Para demostrar que el bloque pertenece a la cadena oficial, compare además
 * su hash con un punto de control publicado (ver README, "Anclaje externo").
 */
import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { BSON } from 'mongodb';
import { blockHeader, computeBlockHash, entryLeaf, makeEntry } from '../src/core/block.js';
import { hashDenuncia } from '../src/core/hash.js';
import { verifyProof } from '../src/core/merkle.js';
import { keyIdOf, verifySignature } from '../src/core/signer.js';

const [proofPath, keyPath, docPath] = process.argv.slice(2);
if (!proofPath || !keyPath) {
  console.error('Uso: node scripts/verificar-prueba.js prueba.json llave-publica.pem [documento.json]');
  process.exit(1);
}

const p = JSON.parse(readFileSync(proofPath, 'utf8'));
const key = createPublicKey(readFileSync(keyPath));
const checks = [];
const check = (name, ok) => checks.push({ name, ok: Boolean(ok) });

check('entryId de la entrada es correcto', makeEntry(p.entrada).entryId === p.entrada.entryId);
check('hash de hoja corresponde a la entrada', entryLeaf(p.entrada) === p.hoja.hash);
check('la hoja está incluida en la raíz de Merkle', verifyProof(p.hoja.hash, p.prueba, p.bloque.merkleRoot));
check('hash del bloque es correcto', computeBlockHash(blockHeader(p.bloque)) === p.bloque.hash);
check('firma Ed25519 del bloque es válida',
  verifySignature(new Map([[keyIdOf(key), key]]), p.bloque.keyId, p.bloque.hash, p.bloque.signature));

if (docPath) {
  const doc = BSON.EJSON.deserialize(JSON.parse(readFileSync(docPath, 'utf8')), { relaxed: false });
  const pepper = process.env.HASH_PEPPER_PATH ? readFileSync(process.env.HASH_PEPPER_PATH, 'utf8').trim() : null;
  const exclude = (process.env.S5_EXCLUDE_FIELDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  check('el documento coincide con la huella sellada', hashDenuncia(doc, { pepper, exclude }) === p.entrada.hashDocumento);
}

for (const c of checks) console.log(`${c.ok ? '✔' : '✘'} ${c.name}`);
const ok = checks.every((c) => c.ok);
console.log(ok
  ? `\nPRUEBA VÁLIDA: denuncia ${p.entrada.denunciaId} v${p.entrada.version} sellada en el bloque ${p.bloque.index} (${p.bloque.timestamp})`
  : '\nPRUEBA INVÁLIDA');
process.exit(ok ? 0 : 2);
