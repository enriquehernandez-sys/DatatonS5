/**
 * Demostración del panel SIN MongoDB: datos simulados en memoria (30 días de actividad,
 * anomalías de cada tipo y su seguimiento). Útil para capacitación y revisión de la interfaz.
 *
 *   npm run demo-panel            → http://127.0.0.1:8444
 *
 * Crea dos cuentas de demostración y muestra sus contraseñas aleatorias en la consola.
 * NUNCA use este modo en producción.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { createBlock, GENESIS_PREV_HASH, makeEntry } from '../src/core/block.js';
import { createSigner, keyIdOf } from '../src/core/signer.js';
import { sha256Hex } from '../src/core/hash.js';
import { makeAlert } from '../src/ledger/alerts.js';
import { Ledger, resumenVerificacion } from '../src/ledger/ledger.js';
import { createPanelApp } from '../src/panel/app.js';
import { hashPassword } from '../src/panel/auth.js';
import { logger } from '../src/logger.js';
import { MemorySource, MemoryStore } from '../test/helpers.js';

const PORT = Number(process.env.PANEL_PORT || 8444);
const DAY = 86_400_000;
let seed = 20261105;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = (n) => Math.floor(rand() * n);

const { privateKey } = generateKeyPairSync('ed25519');
const signer = createSigner(privateKey.export({ type: 'pkcs8', format: 'pem' }));
const trustedKeys = new Map([[keyIdOf(signer.publicKey), signer.publicKey]]);
const store = new MemoryStore();
const docs = [];
const ledger = new Ledger({ store, signer, trustedKeys, logger });

// ---- 1) Cadena simulada: ~6 bloques por día durante 30 días
const now = Date.now();
let prev = createBlock({ index: 0, prevHash: GENESIS_PREV_HASH, entries: [], signer, timestamp: new Date(now - 31 * DAY).toISOString() });
await store.insertBlock(prev);
const version = new Map();
let folio = 1000;
for (let d = 30; d >= 0; d -= 1) {
  const blocks = 4 + pick(5);
  for (let b = 0; b < blocks; b += 1) {
    const ts = new Date(now - d * DAY + (b + 1) * (DAY / (blocks + 1)) - DAY / 2);
    if (ts > now) break;
    const entries = [];
    const n = 1 + pick(d % 6 === 0 ? 3 : 9);
    for (let i = 0; i < n; i += 1) {
      const nuevo = rand() < 0.55 || version.size < 20;
      const id = nuevo ? `${(++folio).toString(16).padStart(24, '0')}` : [...version.keys()][pick(version.size)];
      const v = (version.get(id) ?? 0) + 1;
      const baja = !nuevo && rand() < 0.08;
      const doc = { _id: id, folio: `S5-${folio}`, hechos: randomBytes(8).toString('hex') };
      version.set(id, v);
      if (!baja) docs.push(doc);
      entries.push(makeEntry({
        denunciaId: id, version: v, operacion: nuevo ? 'alta' : baja ? 'baja' : 'modificacion',
        hashDocumento: baja ? null : sha256Hex(JSON.stringify(doc)), observadoEn: ts.toISOString(),
        origen: !nuevo && rand() < 0.03 ? 'conciliacion' : 'flujo',
      }));
    }
    prev = createBlock({ index: prev.index + 1, prevHash: prev.hash, entries, signer, timestamp: ts.toISOString() });
    await store.insertBlock(prev);
  }
}
// Algunos cambios pendientes de sellar.
for (let i = 0; i < 3; i += 1) {
  const id = [...version.keys()][pick(version.size)];
  await store.addPending(makeEntry({ denunciaId: id, version: version.get(id) + 1, operacion: 'modificacion', hashDocumento: sha256Hex(`p${i}`), observadoEn: new Date(now - (4 - i) * 60_000).toISOString(), origen: 'flujo' }));
}

// ---- 2) Anomalías de ejemplo con seguimiento
const someId = () => [...version.keys()][pick(version.size)];
const alerta = (tipo, diasAtras, extra) => makeAlert({ tipo, clave: randomBytes(8).toString('hex'), origen: 'worker', detectadaEn: new Date(now - diasAtras * DAY), ...extra });
const h64 = () => randomBytes(32).toString('hex');
const a1 = alerta('cambio_por_conciliacion', 0.2, { denunciaId: someId(), detalle: { operacion: 'modificacion', version: 3, hashAnterior: h64(), hashNuevo: h64(), entryId: h64() } });
const a2 = alerta('documento_no_coincide', 2.4, { origen: 'api', denunciaId: someId(), bloque: 42, detalle: { hashActual: h64(), ultimoHashSellado: h64(), versionSellada: 2, entryId: h64(), documentoExiste: true } });
const a3 = alerta('historial_perdido', 9.1, { detalle: { codigo: 286, en: new Date(now - 9.1 * DAY).toISOString() } });
const a4 = alerta('cambio_por_conciliacion', 17.5, { denunciaId: someId(), detalle: { operacion: 'baja', version: 4, hashAnterior: h64(), hashNuevo: null, entryId: h64() } });
for (const a of [a1, a2, a3, a4]) await store.insertAlert(a);
const seg = (a, estado, dias, nota, usuario = 'contralor.demo', rol = 'contralor') =>
  store.addSeguimiento({ alertaId: a._id, estado, nota, usuario, rol, en: new Date(now - dias * DAY) });
await seg(a2, 'en_revision', 2.1, 'Se solicitó al área de sistemas la bitácora de MongoDB del S5 del día de la detección (oficio CI/0123/2026).');
await seg(a3, 'en_revision', 9.0, 'Se revisa la ventana de mantenimiento del replica set.', 'admin.demo', 'administrador');
await seg(a3, 'atendida', 8.2, 'Mantenimiento programado excedió la ventana del oplog. Se amplió el oplog a 50 GB; la conciliación completa no encontró cambios no explicados.', 'admin.demo', 'administrador');
await seg(a4, 'falso_positivo', 16.9, 'La baja corresponde a la depuración autorizada mediante acuerdo del comité; se anexa evidencia al expediente.');

// ---- 3) Estado operativo
await store.setControl('latido', { en: new Date().toISOString(), intervaloMs: 60_000 });
await store.setControl('ultimaVerificacion', resumenVerificacion(await ledger.verifyChain()));
await store.setControl('ultimaConciliacion', { denuncias: docs.length, cambios: 0, ms: 1840, en: new Date(now - 3 * 3_600_000).toISOString() });

// ---- 4) Cuentas de demostración
const pw = () => randomBytes(9).toString('base64url');
const cuentas = { 'contralor.demo': ['contralor', 'Contraloría Interna (demo)', pw()], 'admin.demo': ['administrador', 'Administración (demo)', pw()] };
for (const [u, [rol, nombre, p]] of Object.entries(cuentas)) {
  store.usuarios.set(u, { _id: u, nombre, rol, activo: true, version: 1, hash: await hashPassword(`${p}-demo`) });
}

const config = {
  hash: {},
  panel: {
    sessionSecret: randomBytes(32).toString('hex'), sessionMinutes: 30, sessionMaxHours: 8, privilegedIps: [],
    publicPerMinute: 600, maxPendingAgeMs: 900_000, allowInsecureHttp: true, loginFailuresPerIp: 20,
  },
};
const source = new MemorySource(docs);
const app = createPanelApp({ config, store, ledger, source, logger });
app.listen(PORT, '127.0.0.1', () => {
  console.log(`\nPanel de demostración: http://127.0.0.1:${PORT}\n`);
  for (const [u, [rol, , p]] of Object.entries(cuentas)) console.log(`  ${rol.padEnd(14)} usuario: ${u.padEnd(16)} contraseña: ${p}-demo`);
  console.log('\nDatos simulados en memoria; se pierden al cerrar. No usar en producción.\n');
});
