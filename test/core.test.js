import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BSON } from 'mongodb';
import { canonicalDocument, idToString } from '../src/core/canonical.js';
import { hashDenuncia } from '../src/core/hash.js';
import { EMPTY_ROOT, leafHash, merkleProof, merkleRoot, verifyProof } from '../src/core/merkle.js';
import { createBlock, GENESIS_PREV_HASH, makeEntry, verifyBlock } from '../src/core/block.js';
import { newSigner } from './helpers.js';

const oid = new BSON.ObjectId('6543210fedcba98765432100');

test('canónico: el orden de llaves no altera la huella', () => {
  const a = { _id: oid, folio: 'S5-1', fecha: new Date('2026-01-01T00:00:00Z'), datos: { b: 1, a: [2, { y: 1, x: 2 }] } };
  const b = { datos: { a: [2, { x: 2, y: 1 }], b: 1 }, fecha: new Date('2026-01-01T00:00:00Z'), folio: 'S5-1', _id: oid };
  assert.equal(canonicalDocument(a), canonicalDocument(b));
  assert.equal(hashDenuncia(a), hashDenuncia(b));
});

test('canónico: preserva tipos BSON (ObjectId ≠ texto)', () => {
  assert.notEqual(hashDenuncia({ x: oid }), hashDenuncia({ x: oid.toHexString() }));
  assert.equal(idToString(oid), '6543210fedcba98765432100');
});

test('huella: cualquier cambio de contenido la modifica; campos excluidos no', () => {
  const doc = { _id: oid, hechos: 'texto', vistas: 1 };
  assert.notEqual(hashDenuncia(doc), hashDenuncia({ ...doc, hechos: 'texto.' }));
  assert.equal(hashDenuncia(doc, { exclude: ['vistas'] }), hashDenuncia({ ...doc, vistas: 9 }, { exclude: ['vistas'] }));
  assert.notEqual(hashDenuncia(doc), hashDenuncia(doc, { pepper: 'x'.repeat(32) }));
});

test('Merkle: pruebas válidas para árboles de 1 a 40 hojas', () => {
  assert.equal(merkleRoot([]), EMPTY_ROOT);
  for (let n = 1; n <= 40; n++) {
    const leaves = Array.from({ length: n }, (_, i) => leafHash(`hoja-${i}`));
    const root = merkleRoot(leaves);
    for (let i = 0; i < n; i++) {
      const proof = merkleProof(leaves, i);
      assert.ok(verifyProof(leaves[i], proof, root), `n=${n} i=${i}`);
      if (n > 1) assert.ok(!verifyProof(leafHash('falsa'), proof, root));
    }
  }
});

test('Merkle: hoja y nodo tienen dominios separados', () => {
  const l = [leafHash('a'), leafHash('b')];
  assert.notEqual(merkleRoot(l), leafHash(Buffer.from(l.join(''), 'hex')));
});

function sampleEntries(n) {
  return Array.from({ length: n }, (_, i) =>
    makeEntry({ denunciaId: `d${i}`, version: 1, operacion: 'alta', hashDocumento: hashDenuncia({ i }), observadoEn: '2026-11-03T00:00:00.000Z', origen: 'flujo' }));
}

test('bloque: se crea, firma y verifica; se detecta cualquier alteración', () => {
  const { signer, trustedKeys } = newSigner();
  const genesis = createBlock({ index: 0, prevHash: GENESIS_PREV_HASH, entries: [], signer });
  const b1 = createBlock({ index: 1, prevHash: genesis.hash, entries: sampleEntries(5), signer });
  assert.deepEqual(verifyBlock(genesis, null, trustedKeys), []);
  assert.deepEqual(verifyBlock(b1, genesis, trustedKeys), []);

  const tampered = structuredClone(b1);
  tampered.entradas[2].hashDocumento = 'f'.repeat(64);
  assert.ok(verifyBlock(tampered, genesis, trustedKeys).some((e) => /alterada/.test(e)));

  const recomputed = structuredClone(b1); // atacante recalcula entryId pero no puede refirmar
  recomputed.entradas[2] = makeEntry({ ...recomputed.entradas[2], hashDocumento: 'f'.repeat(64) });
  const errs = verifyBlock(recomputed, genesis, trustedKeys);
  assert.ok(errs.some((e) => /Merkle/.test(e)));

  assert.ok(verifyBlock({ ...b1, prevHash: 'a'.repeat(64) }, genesis, trustedKeys).length > 0);
  assert.ok(verifyBlock(b1, genesis, newSigner().trustedKeys).some((e) => /firma/.test(e)));
});

test('bloque: un atacante con OTRA llave no puede reescribir la cadena', () => {
  const real = newSigner();
  const evil = newSigner();
  const genesis = createBlock({ index: 0, prevHash: GENESIS_PREV_HASH, entries: [], signer: real.signer });
  const forged = createBlock({ index: 1, prevHash: genesis.hash, entries: sampleEntries(1), signer: evil.signer });
  assert.ok(verifyBlock(forged, genesis, real.trustedKeys).some((e) => /no confiable/.test(e)));
});
