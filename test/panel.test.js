import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPanelApp } from '../src/panel/app.js';
import { hashPassword } from '../src/panel/auth.js';
import { Ledger } from '../src/ledger/ledger.js';
import { checkIntegridad } from '../src/ledger/integridad.js';
import { Recorder } from '../src/sync/recorder.js';
import { silentLogger } from '../src/logger.js';
import { MemorySource, MemoryStore, newSigner } from './helpers.js';

const PASS = 'contrasena-larga-de-prueba-123';
const DENUNCIA = 'den-0001';
let server, base, store, ledger, source, config;

before(async () => {
  const { signer, trustedKeys } = newSigner();
  store = new MemoryStore();
  source = new MemorySource([{ _id: DENUNCIA, hechos: 'original', denunciante: 'Nombre Confidencial' }]);
  ledger = new Ledger({ store, signer, trustedKeys, logger: silentLogger });
  const recorder = new Recorder({ store, source, hashOptions: {}, logger: silentLogger });
  await ledger.ensureGenesis();
  await recorder.observe({ id: DENUNCIA, denunciaId: DENUNCIA, doc: undefined, origen: 'flujo' });
  await ledger.seal();
  // Edición directa en el S5 detectada por conciliación → alerta "cambio_por_conciliacion".
  source.docs.get(DENUNCIA).hechos = 'alterado';
  await recorder.observe({ id: DENUNCIA, denunciaId: DENUNCIA, doc: undefined, origen: 'conciliacion' });
  await ledger.seal();
  await store.setControl('ultimaVerificacion', { valida: true, bloques: 3, entradas: 2, errores: 0, verificadoEn: new Date().toISOString() });
  await store.setControl('latido', { en: new Date().toISOString(), intervaloMs: 60_000 });

  const h = await hashPassword(PASS);
  store.usuarios.set('contralor1', { _id: 'contralor1', nombre: 'Contralora Interna', rol: 'contralor', activo: true, version: 1, hash: h });
  store.usuarios.set('admin1', { _id: 'admin1', nombre: 'Admin', rol: 'administrador', activo: true, version: 1, hash: h });
  store.usuarios.set('inactivo', { _id: 'inactivo', nombre: 'X', rol: 'contralor', activo: false, version: 1, hash: h });

  config = {
    hash: {},
    panel: {
      sessionSecret: 's'.repeat(40), sessionMinutes: 30, sessionMaxHours: 8, privilegedIps: [],
      publicPerMinute: 10_000, loginFailuresPerIp: 1000, maxPendingAgeMs: 900_000, allowInsecureHttp: true,
    },
  };
  const app = createPanelApp({ config, store, ledger, source, logger: silentLogger });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const req = (path, { cookie, method = 'GET', body } = {}) => fetch(base + path, {
  method,
  headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), 'x-panel': '1' },
  body: body ? JSON.stringify(body) : undefined,
});
async function login(usuario) {
  const r = await req('/api/sesion', { method: 'POST', body: { usuario, contrasena: PASS } });
  assert.equal(r.status, 200);
  return r.headers.get('set-cookie').split(';')[0];
}
const SENSITIVE = [DENUNCIA, 'Nombre Confidencial', 'alterado'];
const assertNoPersonalData = (json) => {
  const s = JSON.stringify(json);
  for (const v of SENSITIVE) assert.ok(!s.includes(v), `la vista pública no debe contener "${v}"`);
  assert.ok(!/[0-9a-f]{64}/.test(s.replace(/"(hash|prevHash|merkleRoot)":"[0-9a-f]{64}"/g, '')), 'no debe exponer huellas de documentos');
};

test('panel público: estado, actividad, bloques y alertas SIN datos personales', async () => {
  const resumen = await (await req('/api/publico/resumen')).json();
  assert.equal(resumen.estado, 'en_observacion'); // hay una alerta alta abierta
  assert.equal(resumen.alertas.abiertas, 1);
  assertNoPersonalData(resumen);

  const act = await (await req('/api/publico/actividad')).json();
  assert.equal(act.dias.length, 30);
  const hoy = act.dias.at(-1);
  assert.equal(hoy.altas, null, 'conteos menores al umbral se suprimen');
  assertNoPersonalData(act);

  const bloques = await (await req('/api/publico/bloques')).json();
  assert.equal(bloques[0].index, 2);
  assert.equal(bloques[0].entradas, undefined, 'el público no ve las entradas');
  assertNoPersonalData(bloques);

  const alertas = await (await req('/api/publico/alertas')).json();
  assert.equal(alertas.length, 1);
  const [a] = alertas;
  assert.match(a.folio, /^AL-[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
  assert.match(a.detectadaEl, /^\d{4}-\d{2}-\d{2}$/, 'solo la fecha, sin hora');
  for (const k of ['denunciaId', 'detalle', 'origen', 'id']) assert.equal(a[k], undefined, `no expone ${k}`);
  assertNoPersonalData(alertas);
  const det = await (await req(`/api/publico/alertas/${a.folio}`)).json();
  assertNoPersonalData(det);
});

test('el público no puede acceder a rutas privadas ni de administración', async () => {
  for (const p of ['/api/privado/alertas', `/api/privado/denuncias/${DENUNCIA}`, '/api/admin/bitacora', '/api/admin/operacion']) {
    assert.equal((await req(p)).status, 401, p);
  }
  const forged = 'panel_sesion=eyJ1IjoiYWRtaW4xIn0.firmafalsa';
  assert.equal((await req('/api/admin/bitacora', { cookie: forged })).status, 401);
});

test('inicio de sesión: credenciales incorrectas, cuenta inactiva y bloqueo', async () => {
  assert.equal((await req('/api/sesion', { method: 'POST', body: { usuario: 'contralor1', contrasena: 'mala-contrasena-xx' } })).status, 401);
  assert.equal((await req('/api/sesion', { method: 'POST', body: { usuario: 'inactivo', contrasena: PASS } })).status, 401);
  assert.equal((await req('/api/sesion', { method: 'POST', body: { usuario: 'noexiste', contrasena: PASS } })).status, 401);
  // Sin el encabezado anti-CSRF se rechaza.
  const r = await fetch(`${base}/api/sesion`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ usuario: 'contralor1', contrasena: PASS }) });
  assert.equal(r.status, 403);
  for (let i = 0; i < 5; i += 1) await req('/api/sesion', { method: 'POST', body: { usuario: 'admin1', contrasena: 'incorrecta-' + i + 'xxxx' } });
  assert.equal((await req('/api/sesion', { method: 'POST', body: { usuario: 'admin1', contrasena: PASS } })).status, 429, 'cuenta bloqueada');
});

test('Contralor interno: acceso completo a la anomalía y seguimiento; sin bitácora', async () => {
  const cookie = await login('contralor1');
  const sesion = await (await req('/api/sesion', { cookie })).json();
  assert.equal(sesion.rol, 'contralor');

  const [a] = await (await req('/api/privado/alertas', { cookie })).json();
  assert.equal(a.denunciaId, DENUNCIA);
  assert.equal(a.detalle.operacion, 'modificacion');
  assert.match(a.detalle.hashNuevo, /^[0-9a-f]{64}$/);

  const det = await (await req(`/api/privado/alertas/${a.id}`, { cookie })).json();
  assert.equal(det.contexto.historial.selladas.length, 2);
  assert.equal(det.contexto.integridadActual.integra, true, 'el cambio ya quedó sellado');

  let r = await req(`/api/privado/alertas/${a.id}/seguimiento`, { cookie, method: 'POST', body: { estado: 'en_revision', nota: 'corta' } });
  assert.equal(r.status, 400, 'nota obligatoria');
  r = await req(`/api/privado/alertas/${a.id}/seguimiento`, { cookie, method: 'POST', body: { estado: 'en_revision', nota: 'Se solicita al área de TI el registro de accesos a la base.' } });
  assert.equal(r.status, 201);
  assert.equal((await r.json()).estado, 'en_revision');

  // El público ve el cambio de estado, pero no la nota ni quién la escribió.
  const pub = await (await req(`/api/publico/alertas/${a.folio}`)).json();
  assert.equal(pub.estado, 'en_revision');
  assert.ok(!JSON.stringify(pub).includes('registro de accesos'));
  assert.ok(!JSON.stringify(pub).includes('contralor1'));

  assert.equal((await req('/api/admin/bitacora', { cookie })).status, 403, 'la bitácora es solo para administración');
});

test('Administrador: bitácora registra cada acceso a información reservada', async () => {
  const cookie = await login('admin1').catch(async () => {
    // admin1 pudo quedar bloqueado en la prueba anterior; se crea otra cuenta equivalente.
    store.usuarios.set('admin2', { ...store.usuarios.get('admin1'), _id: 'admin2' });
    return login('admin2');
  });
  const den = await (await req(`/api/privado/denuncias/${DENUNCIA}`, { cookie })).json();
  assert.equal(den.historial.denunciaId, DENUNCIA);
  const op = await (await req('/api/admin/operacion', { cookie })).json();
  assert.equal(op.accesoS5DesdePanel, true);
  const log = await (await req('/api/admin/bitacora', { cookie })).json();
  const acciones = log.map((l) => l.accion);
  for (const a of ['inicio_sesion', 'consulta_alertas', 'consulta_alerta', 'seguimiento_alerta', 'consulta_denuncia', 'acceso_denegado']) {
    assert.ok(acciones.includes(a), `bitácora incluye ${a}`);
  }
  assert.ok(log.some((l) => l.accion === 'consulta_denuncia' && l.objeto === DENUNCIA));
});

test('desactivar la cuenta invalida la sesión de inmediato', async () => {
  const cookie = await login('contralor1');
  store.usuarios.get('contralor1').activo = false;
  assert.equal((await req('/api/privado/alertas', { cookie })).status, 401);
  store.usuarios.get('contralor1').activo = true;
});

test('alertas: documento no coincide y cadena alterada (deduplicadas)', async () => {
  source.docs.get(DENUNCIA).hechos = 'manipulado sin pasar por el flujo';
  const args = { id: DENUNCIA, denunciaId: DENUNCIA, source, ledger, store, hashOptions: {}, logger: silentLogger, origen: 'api' };
  assert.equal((await checkIntegridad(args)).body.integra, false);
  await checkIntegridad(args); // segunda consulta: no duplica
  assert.equal(store.alertas.filter((a) => a.tipo === 'documento_no_coincide').length, 1);

  store.bloques[1].entradas[0].version = 99; // alteración directa del ledger
  const cookie = await login('contralor1');
  const ver = await ledger.verifyChain();
  assert.equal(ver.valida, false);
  const { alertaCadenaInvalida } = await import('../src/ledger/ledger.js');
  await alertaCadenaInvalida(store, silentLogger, ver, 'worker');
  await alertaCadenaInvalida(store, silentLogger, ver, 'worker');
  const cad = store.alertas.filter((a) => a.tipo === 'cadena_invalida');
  assert.equal(cad.length, 1);
  assert.equal(cad[0].bloque, 1);

  const resumen = await (await req('/api/publico/resumen')).json();
  assert.equal(resumen.estado, 'comprometida');
  const pub = await (await req('/api/publico/alertas')).json();
  const pc = pub.find((a) => a.tipo === 'cadena_invalida');
  assert.equal(pc.bloque, 1, 'el bloque afectado sí es público');
  assertNoPersonalData(pub);
  const det = await (await req(`/api/privado/alertas/${cad[0]._id}`, { cookie })).json();
  assert.ok(det.contexto.bloque.erroresActuales.length > 0);
  store.bloques[1].entradas[0].version = 1;
});

test('configuración: ROL=panel funciona sin S5 y exige secreto de sesión', async () => {
  const { loadConfig } = await import('../src/config.js');
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'panel-'));
  const secreto = join(dir, 's.txt');
  const env = { ROL: 'panel', LEDGER_MONGO_URI: 'mongodb://x', LLAVES_CONFIANZA_DIR: dir };
  assert.throws(() => loadConfig(env), /PANEL_SECRETO_SESION_PATH/);
  writeFileSync(secreto, 'corto');
  assert.throws(() => loadConfig({ ...env, PANEL_SECRETO_SESION_PATH: secreto }), /32 caracteres/);
  writeFileSync(secreto, 'x'.repeat(48));
  const c = loadConfig({ ...env, PANEL_SECRETO_SESION_PATH: secreto });
  assert.equal(c.s5, null);
  assert.equal(c.panel.enabled, true);
  assert.equal(c.api.enabled, false);
  assert.equal(c.keys.signingKeyPath, null, 'el panel nunca carga la llave privada');
});

test('worker: la verificación periódica guarda el resumen y registra la alerta crítica', async () => {
  const { SyncWorker } = await import('../src/sync/worker.js');
  const { signer, trustedKeys } = newSigner();
  const st = new MemoryStore();
  const lg = new Ledger({ store: st, signer, trustedKeys, logger: silentLogger });
  await lg.ensureGenesis();
  await lg.seal({ allowEmpty: true });
  const recorder = { onEntry: null };
  const w = new SyncWorker({ config: { blocks: { maxEntries: 10, intervalMs: 1000 }, s5: {}, hash: {} }, store: st, ledger: lg, source: null, recorder, logger: silentLogger });
  assert.equal((await w.verify()).valida, true);
  assert.equal((await st.getControl('ultimaVerificacion')).valida, true);
  assert.equal(st.alertas.length, 0);
  st.bloques[1].timestamp = '1999-01-01T00:00:00.000Z';
  assert.equal((await w.verify()).valida, false);
  assert.equal((await st.getControl('ultimaVerificacion')).valida, false);
  assert.equal(st.alertas[0].tipo, 'cadena_invalida');
});
