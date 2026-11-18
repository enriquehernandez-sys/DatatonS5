import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BSON } from 'mongodb';
import { createApp } from '../src/api/app.js';
import { Ledger } from '../src/ledger/ledger.js';
import { Recorder } from '../src/sync/recorder.js';
import { silentLogger } from '../src/logger.js';
import { MemorySource, MemoryStore, newSigner } from './helpers.js';

const KEY = 'llave-de-prueba-0123456789abcdef0123456789';
let server;
let base;
let source;

before(async () => {
  const { signer, trustedKeys } = newSigner();
  const store = new MemoryStore();
  source = new MemorySource([{ _id: 'd1', hechos: 'original' }]);
  const ledger = new Ledger({ store, signer, trustedKeys, logger: silentLogger });
  const recorder = new Recorder({ store, source, hashOptions: {}, logger: silentLogger });
  await ledger.ensureGenesis();
  await recorder.observe({ id: 'd1', denunciaId: 'd1', doc: undefined, origen: 'flujo' });
  await ledger.seal();

  const config = { hash: {}, api: { apiKeysSha256: [createHash('sha256').update(KEY).digest('hex')], allowedIps: [] } };
  const app = createApp({ config, store, ledger, source, logger: silentLogger });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const get = (path, key = KEY) => fetch(base + path, { headers: key ? { 'x-api-key': key } : {} });

test('sin llave → 401; llave incorrecta → 401', async () => {
  assert.equal((await get('/api/v1/cadena/cabeza', null)).status, 401);
  assert.equal((await get('/api/v1/cadena/cabeza', 'x'.repeat(40))).status, 401);
  assert.equal((await get('/salud', null)).status, 200);
});

test('cabeza y verificación de la cadena', async () => {
  const head = await (await get('/api/v1/cadena/cabeza')).json();
  assert.equal(head.index, 1);
  const res = await get('/api/v1/cadena/verificacion');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).valida, true);
});

test('integridad: detecta modificación directa en el S5', async () => {
  let r = await (await get('/api/v1/denuncias/d1/integridad')).json();
  assert.equal(r.integra, true);
  source.docs.get('d1').hechos = 'alterado';
  r = await (await get('/api/v1/denuncias/d1/integridad')).json();
  assert.equal(r.integra, false);
  source.docs.get('d1').hechos = 'original';
});

test('verificar documento exportado y validar entradas', async () => {
  const body = JSON.stringify({ documento: BSON.EJSON.serialize({ _id: 'd1', hechos: 'original' }, { relaxed: false }) });
  const res = await fetch(`${base}/api/v1/documentos/verificar`, { method: 'POST', headers: { 'x-api-key': KEY, 'content-type': 'application/json' }, body });
  const r = await res.json();
  assert.equal(r.sellado, true);
  assert.equal(r.coincidencias[0].denunciaId, 'd1');
  assert.equal((await get('/api/v1/denuncias/$where/historial')).status, 400);
  assert.equal((await get('/api/v1/cadena/bloques/-1')).status, 400);
});
