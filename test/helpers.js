import { generateKeyPairSync } from 'node:crypto';
import { createSigner, keyIdOf } from '../src/core/signer.js';

export function newSigner() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const signer = createSigner(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  return { signer, trustedKeys: new Map([[keyIdOf(signer.publicKey), signer.publicKey]]) };
}

const clone = (o) => structuredClone(o);
const matches = (doc, filter) =>
  Object.entries(filter).every(([k, v]) => {
    if (k === 'entradas.denunciaId') return doc.entradas.some((e) => e.denunciaId === v);
    if (k === 'entradas.hashDocumento') return doc.entradas.some((e) => e.hashDocumento === v);
    return doc[k] === v;
  });

/** Implementación en memoria de LedgerStore para pruebas. */
export class MemoryStore {
  constructor() {
    this.bloques = [];
    this.pendientes = [];
    this.estado = new Map();
    this.control = new Map();
    this.seq = 0;
  }
  async head() { return this.bloques.length ? clone(this.bloques.at(-1)) : null; }
  async getBlock(i) { const b = this.bloques.find((x) => x.index === i); return b ? clone(b) : null; }
  async *iterateBlocks() { for (const b of [...this.bloques].sort((a, c) => a.index - c.index)) yield clone(b); }
  async insertBlock(b) {
    if (this.bloques.some((x) => x.index === b.index)) throw Object.assign(new Error('duplicado'), { code: 11000 });
    this.bloques.push(clone(b));
  }
  async findBlocksWith(f) { return this.bloques.filter((b) => matches(b, f)).map(clone); }
  async addPending(e) { this.pendientes.push({ _id: ++this.seq, ...clone(e) }); }
  async takePending(limit) { return this.pendientes.slice(0, limit).map(clone); }
  async countPending() { return this.pendientes.length; }
  async findPending(f) { return this.pendientes.filter((p) => matches(p, f)).map(clone); }
  async removePendingByIds(ids) { const n = this.pendientes.length; this.pendientes = this.pendientes.filter((p) => !ids.includes(p._id)); return { deletedCount: n - this.pendientes.length }; }
  async removePendingByEntryIds(ids) { const n = this.pendientes.length; this.pendientes = this.pendientes.filter((p) => !ids.includes(p.entryId)); return { deletedCount: n - this.pendientes.length }; }
  async getEstado(id) { return this.estado.get(id) ?? null; }
  async setEstado(id, d) { this.estado.set(id, { _id: id, ...this.estado.get(id), ...d }); }
  async *iterateEstadoActivos() { for (const [id, e] of this.estado) if (e.hashDocumento !== null) yield { _id: id }; }
  async getControl(k) { return clone(this.control.get(k) ?? null); }
  async setControl(k, v) { this.control.set(k, clone(v)); }

  // --- Panel ---
  alertas = [];
  seguimiento = [];
  bitacora = [];
  usuarios = new Map();
  async blockHeaders({ limit = 20, antesDe = null } = {}) {
    return [...this.bloques].sort((a, b) => b.index - a.index)
      .filter((b) => antesDe === null || b.index < antesDe).slice(0, limit)
      .map(({ entradas, ...h }) => ({
        ...clone(h),
        operaciones: Object.fromEntries(['alta', 'modificacion', 'baja'].map((op) => [op, entradas.filter((e) => e.operacion === op).length])),
      }));
  }
  async statsDiarias(desde) {
    const bl = new Map();
    const en = new Map();
    for (const b of this.bloques) {
      if (b.timestamp < desde) continue;
      const dia = b.timestamp.slice(0, 10);
      bl.set(dia, (bl.get(dia) ?? 0) + 1);
      for (const e of b.entradas) {
        const k = `${dia}|${e.operacion}|${e.origen}`;
        en.set(k, (en.get(k) ?? 0) + 1);
      }
    }
    return {
      bloques: [...bl].map(([dia, n]) => ({ dia, n })),
      entradas: [...en].map(([k, n]) => { const [dia, operacion, origen] = k.split('|'); return { dia, operacion, origen, n }; }),
    };
  }
  async oldestPending() { return this.pendientes[0]?.observadoEn ?? null; }
  async insertAlert(a) {
    if (this.alertas.some((x) => x.clave === a.clave)) return false;
    this.alertas.push(clone(a));
    return true;
  }
  async getAlert(id) { const a = this.alertas.find((x) => x._id === id); return a ? clone(a) : null; }
  async listAlerts({ limit = 50, skip = 0 } = {}) {
    return [...this.alertas].sort((a, b) => b.detectadaEn - a.detectadaEn).slice(skip, skip + limit).map(clone);
  }
  async listAlertsLight() { return this.alertas.map(({ _id, tipo, severidad, detectadaEn }) => ({ _id, tipo, severidad, detectadaEn })); }
  async addSeguimiento(e) { this.seguimiento.push({ _id: ++this.seq, ...clone(e) }); }
  async listSeguimiento(ids) {
    return this.seguimiento.filter((s) => ids.includes(s.alertaId)).sort((a, b) => a.en - b.en || a._id - b._id).map(clone);
  }
  async estadosAlertas() {
    const m = new Map();
    for (const s of [...this.seguimiento].sort((a, b) => a.en - b.en || a._id - b._id)) m.set(s.alertaId, s.estado);
    return m;
  }
  async addBitacora(e) { this.bitacora.push(clone(e)); }
  async listBitacora({ limit = 100, skip = 0 } = {}) { return [...this.bitacora].reverse().slice(skip, skip + limit).map(clone); }
  async getPanelUser(u) { return clone(this.usuarios.get(u) ?? null); }
}

/** Fuente S5 en memoria. */
export class MemorySource {
  constructor(docs = []) { this.docs = new Map(docs.map((d) => [String(d._id), d])); }
  parseId(raw) { return /^[\w.:-]{1,128}$/.test(raw) ? raw : null; }
  async findById(id) { return this.docs.get(String(id)) ?? null; }
  async *scan() { for (const d of this.docs.values()) yield d; }
}
