import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger/ledger.js';
import { Recorder } from '../src/sync/recorder.js';
import { SyncWorker } from '../src/sync/worker.js';
import { verifyProof } from '../src/core/merkle.js';
import { verifySignature } from '../src/core/signer.js';
import { computeBlockHash, blockHeader } from '../src/core/block.js';
import { silentLogger } from '../src/logger.js';
import { MemorySource, MemoryStore, newSigner } from './helpers.js';

function setup(docs = []) {
  const { signer, trustedKeys } = newSigner();
  const store = new MemoryStore();
  const source = new MemorySource(docs);
  const ledger = new Ledger({ store, signer, trustedKeys, logger: silentLogger, maxEntries: 3 });
  const recorder = new Recorder({ store, source, hashOptions: {}, logger: silentLogger });
  return { store, source, ledger, recorder, trustedKeys };
}

test('versionado: alta → modificación → sin cambio → baja → alta', async () => {
  const { store, recorder } = setup();
  const obs = (doc) => recorder.observe({ id: 'd1', denunciaId: 'd1', doc, origen: 'flujo' });
  assert.equal((await obs({ _id: 'd1', v: 1 })).operacion, 'alta');
  assert.equal((await obs({ _id: 'd1', v: 2 })).operacion, 'modificacion');
  assert.equal(await obs({ _id: 'd1', v: 2 }), null);
  const baja = await obs(null);
  assert.equal(baja.operacion, 'baja');
  assert.equal(baja.hashDocumento, null);
  const re = await obs({ _id: 'd1', v: 3 });
  assert.deepEqual([re.operacion, re.version], ['alta', 4]);
  assert.equal(await store.countPending(), 4);
});

test('sellado: bloques encadenados, verificación completa y pruebas de inclusión', async () => {
  const { store, ledger, recorder, trustedKeys } = setup();
  await ledger.ensureGenesis();
  for (let i = 0; i < 7; i++) await recorder.observe({ id: `d${i}`, denunciaId: `d${i}`, doc: { _id: `d${i}`, i }, origen: 'flujo' });
  while (await ledger.seal()) { /* sella en bloques de 3 */ }
  assert.equal(store.bloques.length, 4); // génesis + 3 + 3 + 1
  assert.equal(await store.countPending(), 0);

  const result = await ledger.verifyChain();
  assert.ok(result.valida, result.errores.join('\n'));
  assert.equal(result.entradas, 7);

  const p = await ledger.proof('d4');
  assert.ok(verifyProof(p.hoja.hash, p.prueba, p.bloque.merkleRoot));
  assert.equal(computeBlockHash(blockHeader(p.bloque)), p.bloque.hash);
  assert.ok(verifySignature(trustedKeys, p.bloque.keyId, p.bloque.hash, p.bloque.signature));
});

test('manipulación directa del ledger se detecta en la verificación', async () => {
  const { store, ledger, recorder } = setup();
  await ledger.ensureGenesis();
  for (let i = 0; i < 4; i++) await recorder.observe({ id: `d${i}`, denunciaId: `d${i}`, doc: { _id: `d${i}`, i }, origen: 'flujo' });
  await ledger.seal();
  await ledger.seal();
  store.bloques[1].entradas[0].hashDocumento = 'a'.repeat(64); // edición en la BD
  const r1 = await ledger.verifyChain();
  assert.equal(r1.valida, false);

  store.bloques.splice(1, 1); // borrar un bloque completo
  const r2 = await ledger.verifyChain();
  assert.ok(r2.errores.some((e) => /consecutivo|enlaza/.test(e)));
});

test('recuperación tras caída entre insertar bloque y borrar pendientes', async () => {
  const { store, ledger, recorder } = setup();
  await ledger.ensureGenesis();
  await recorder.observe({ id: 'd1', denunciaId: 'd1', doc: { _id: 'd1' }, origen: 'flujo' });
  const backup = structuredClone(store.pendientes);
  await ledger.seal();
  store.pendientes = backup; // simula la caída
  await ledger.recover();
  assert.equal(await store.countPending(), 0);
});

test('conciliación detecta cambios y bajas hechos directamente en el S5', async () => {
  const docs = [{ _id: 'a', t: 1 }, { _id: 'b', t: 1 }];
  const ctx = setup(docs);
  const config = { blocks: { maxEntries: 100, sealEmpty: false }, hash: {}, s5: {} };
  const worker = new SyncWorker({ config, ...ctx, logger: silentLogger });
  await ctx.ledger.ensureGenesis();
  await worker.reconcile();
  assert.equal(await ctx.store.countPending(), 2);

  ctx.source.docs.get('a').t = 2; // alteración directa en MongoDB
  ctx.source.docs.delete('b'); // borrado directo
  await worker.reconcile();
  const { pendientes } = await ctx.ledger.history('a');
  assert.deepEqual(pendientes.map((e) => e.operacion), ['alta', 'modificacion']);
  assert.equal(pendientes[1].origen, 'conciliacion');
  assert.equal((await ctx.ledger.history('b')).pendientes.at(-1).operacion, 'baja');
  await worker.reconcile();
  assert.equal(await ctx.store.countPending(), 4); // idempotente
});

test('el rol api no puede sellar', async () => {
  const { store, trustedKeys } = setup();
  const ledger = new Ledger({ store, trustedKeys, logger: silentLogger });
  await assert.rejects(ledger.ensureGenesis(), /llave de firma/);
});
