/**
 * Lógica de la cadena: génesis, sellado de bloques, verificación integral
 * y pruebas de inclusión de una denuncia.
 */
import { createBlock, entryLeaf, GENESIS_PREV_HASH, verifyBlock, blockHeader } from '../core/block.js';
import { merkleProof } from '../core/merkle.js';
import { primerBloqueConError, recordAlert } from './alerts.js';

/** Exclusión mutua simple dentro del proceso. */
export function createMutex() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

export const publicHeader = (b) => ({ ...blockHeader(b), hash: b.hash, signature: b.signature });

/** Registra (una sola vez por conjunto de errores) que la verificación integral falló. */
export function alertaCadenaInvalida(store, logger, result, origen) {
  return recordAlert(store, logger, {
    tipo: 'cadena_invalida',
    clave: result.errores.join('\n'),
    origen,
    bloque: primerBloqueConError(result.errores),
    detalle: {
      errores: result.errores.slice(0, 200),
      totalErrores: result.errores.length,
      bloquesVerificados: result.bloques,
      cabeza: result.cabeza ? { index: result.cabeza.index, hash: result.cabeza.hash } : null,
    },
  });
}

/** Resumen compacto de una verificación integral (se guarda en `control`). */
export const resumenVerificacion = (r) => ({
  valida: r.valida,
  bloques: r.bloques,
  entradas: r.entradas,
  errores: r.errores.length,
  cabeza: r.cabeza ? { index: r.cabeza.index, hash: r.cabeza.hash, timestamp: r.cabeza.timestamp } : null,
  verificadoEn: r.verificadoEn,
});

export class Ledger {
  constructor({ store, signer = null, trustedKeys, logger, maxEntries = 500 }) {
    this.store = store;
    this.signer = signer;
    this.trustedKeys = trustedKeys;
    this.logger = logger;
    this.maxEntries = maxEntries;
    this.lock = createMutex();
  }

  #requireSigner() {
    if (!this.signer) throw new Error('Este proceso no tiene llave de firma (ROL=api)');
    return this.signer;
  }

  /** Crea el bloque génesis si la cadena está vacía. */
  async ensureGenesis() {
    return this.lock(async () => {
      const head = await this.store.head();
      if (head) return head;
      const genesis = createBlock({ index: 0, prevHash: GENESIS_PREV_HASH, entries: [], signer: this.#requireSigner() });
      await this.store.insertBlock(genesis);
      this.logger?.info('Bloque génesis creado', { hash: genesis.hash });
      return genesis;
    });
  }

  /** Tras una caída entre "insertar bloque" y "borrar pendientes", limpia los ya sellados. */
  async recover() {
    const head = await this.store.head();
    if (head?.entradas?.length) {
      const { deletedCount } = await this.store.removePendingByEntryIds(head.entradas.map((e) => e.entryId));
      if (deletedCount) this.logger?.warn('Recuperación: pendientes ya sellados eliminados', { deletedCount });
    }
  }

  /** Sella hasta `maxEntries` entradas pendientes en un nuevo bloque firmado. */
  async seal({ allowEmpty = false } = {}) {
    return this.lock(async () => {
      const signer = this.#requireSigner();
      const pending = await this.store.takePending(this.maxEntries);
      if (pending.length === 0 && !allowEmpty) return null;
      const head = await this.store.head();
      if (!head) throw new Error('Cadena sin génesis');

      // El tiempo nunca retrocede aunque el reloj del servidor lo haga.
      const now = new Date().toISOString();
      const timestamp = now > head.timestamp ? now : head.timestamp;
      const block = createBlock({ index: head.index + 1, prevHash: head.hash, entries: pending, signer, timestamp });

      const errores = verifyBlock(block, head, this.trustedKeys);
      if (errores.length) throw new Error(`Bloque generado inválido: ${errores.join('; ')}`);

      await this.store.insertBlock(block); // índice único: imposible bifurcar
      await this.store.removePendingByIds(pending.map((p) => p._id));
      this.logger?.info('Bloque sellado', { index: block.index, entradas: block.entryCount, hash: block.hash });
      return block;
    });
  }

  /** Recorre TODA la cadena verificando hashes, firmas, raíces de Merkle y enlaces. */
  async verifyChain() {
    const errores = [];
    let prev = null;
    let count = 0;
    let entradas = 0;
    for await (const block of this.store.iterateBlocks()) {
      errores.push(...verifyBlock(block, count === 0 ? null : prev, this.trustedKeys));
      prev = block;
      count += 1;
      entradas += block.entryCount ?? 0;
    }
    if (count === 0) errores.push('La cadena está vacía');
    return {
      valida: errores.length === 0,
      bloques: count,
      entradas,
      cabeza: prev ? publicHeader(prev) : null,
      errores,
      verificadoEn: new Date().toISOString(),
    };
  }

  /** Historial sellado (y pendiente) de una denuncia. */
  async history(denunciaId) {
    const blocks = await this.store.findBlocksWith({ 'entradas.denunciaId': denunciaId });
    const selladas = [];
    for (const b of blocks) {
      b.entradas.forEach((e, leafIndex) => {
        if (e.denunciaId === denunciaId) {
          selladas.push({ ...e, bloque: b.index, hoja: leafIndex, selladoEn: b.timestamp, hashBloque: b.hash });
        }
      });
    }
    const pendientes = (await this.store.findPending({ denunciaId })).map(({ _id, ...e }) => e);
    return { denunciaId, selladas, pendientes };
  }

  /** Prueba de inclusión verificable fuera de línea (ver scripts/verificar-prueba.js). */
  async proof(denunciaId, entryId = null) {
    const { selladas } = await this.history(denunciaId);
    const target = entryId ? selladas.find((e) => e.entryId === entryId) : selladas.at(-1);
    if (!target) return null;
    const block = await this.store.getBlock(target.bloque);
    const leaves = block.entradas.map(entryLeaf);
    const entrada = block.entradas[target.hoja];
    return {
      entrada,
      hoja: { indice: target.hoja, hash: leaves[target.hoja] },
      prueba: merkleProof(leaves, target.hoja),
      bloque: publicHeader(block),
    };
  }
}
