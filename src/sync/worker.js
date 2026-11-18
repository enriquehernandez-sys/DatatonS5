/**
 * Orquestador del sellado:
 *  1. Garantiza el bloque génesis y se recupera de caídas.
 *  2. Escucha el change stream del S5 (o sondea periódicamente).
 *  3. Sella bloques por tiempo o por tamaño.
 *  4. Concilia/audita periódicamente todo el S5 contra el último estado conocido.
 */
import { idToString } from '../core/canonical.js';
import { hashDenuncia } from '../core/hash.js';
import { recordAlert } from '../ledger/alerts.js';
import { alertaCadenaInvalida, resumenVerificacion } from '../ledger/ledger.js';
import { S5Source } from './source.js';

const CHANGE_STREAM_HISTORY_LOST = 286;
const RESUME_TOKEN_KEY = 'resumeToken';

export class SyncWorker {
  constructor({ config, store, ledger, source, recorder, logger }) {
    Object.assign(this, { config, store, ledger, source, recorder, logger });
    this.stopped = false;
    this.timers = [];
    this.pendingSinceSeal = 0;
    this.reconciling = null;
    recorder.onEntry = () => {
      this.pendingSinceSeal += 1;
      if (this.pendingSinceSeal >= config.blocks.maxEntries) this.#seal();
    };
  }

  async start() {
    await this.ledger.ensureGenesis();
    await this.ledger.recover();
    this.pendingSinceSeal = await this.store.countPending();
    await this.#latido();
    await this.verify().catch((e) => this.#fail('verificación', e));

    const { blocks, s5 } = this.config;
    this.timers.push(setInterval(() => this.#seal(), blocks.intervalMs));
    this.timers.push(setInterval(() => this.reconcile().catch((e) => this.#fail('auditoría', e)), blocks.auditIntervalMs));
    this.timers.push(setInterval(() => this.verify().catch((e) => this.#fail('verificación', e)), blocks.verifyIntervalMs));

    if (s5.mode === 'sondeo') {
      this.timers.push(setInterval(() => this.reconcile().catch((e) => this.#fail('sondeo', e)), s5.pollIntervalMs));
      await this.reconcile();
      return;
    }
    this.streamLoop = this.#streamLoop();
  }

  async stop() {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    await this.stream?.close().catch(() => {});
    await this.reconciling?.catch(() => {});
    await this.#seal(); // sella lo que quede antes de salir
  }

  async #seal() {
    try {
      const block = await this.ledger.seal({ allowEmpty: this.config.blocks.sealEmpty });
      if (block) this.pendingSinceSeal = Math.max(0, this.pendingSinceSeal - block.entryCount);
    } catch (e) {
      this.#fail('sellado', e);
    }
    await this.#latido();
  }

  /** Señal de vida que el panel usa para saber si el sellado está activo. */
  async #latido() {
    try {
      await this.store.setControl('latido', { en: new Date().toISOString(), intervaloMs: this.config.blocks.intervalMs });
    } catch (e) {
      this.#fail('latido', e);
    }
  }

  /** Verificación integral periódica; su resumen queda disponible para el panel público. */
  async verify() {
    const result = await this.ledger.verifyChain();
    await this.store.setControl('ultimaVerificacion', resumenVerificacion(result));
    if (!result.valida) {
      this.logger.error('ALERTA: la cadena NO es íntegra', { errores: result.errores.slice(0, 20) });
      await alertaCadenaInvalida(this.store, this.logger, result, 'worker');
    }
    return result;
  }

  #fail(what, e) {
    this.logger.error(`Error en ${what}`, { error: e.message, code: e.code });
  }

  async #streamLoop() {
    let backoff = 1000;
    while (!this.stopped) {
      try {
        let token = await this.store.getControl(RESUME_TOKEN_KEY);
        // Primer arranque: se abre el stream ANTES de la conciliación completa,
        // así ningún cambio ocurrido durante el escaneo se pierde.
        this.stream = this.source.watch(token);
        const firstRun = !token;
        if (firstRun) {
          this.logger.info('Primer arranque: conciliación inicial del S5');
          await this.reconcile();
        }
        this.logger.info('Escuchando cambios del S5', { reanudado: !firstRun });
        for await (const event of this.stream) {
          if (event.operationType === 'drop' || event.operationType === 'invalidate') {
            this.logger.warn('ALERTA: la colección del S5 fue eliminada o invalidada', { op: event.operationType });
            await recordAlert(this.store, this.logger, {
              tipo: 'coleccion_invalidada',
              clave: `${event.operationType}|${JSON.stringify(event._id)}`,
              origen: 'worker',
              detalle: { operacion: event.operationType, coleccion: this.config.s5.collection, en: new Date().toISOString() },
            });
            await this.store.setControl(RESUME_TOKEN_KEY, null);
            await this.reconcile();
            break;
          }
          const obs = S5Source.eventToObservation(event);
          if (obs) await this.recorder.observe({ ...obs, origen: 'flujo' });
          token = event._id;
          await this.store.setControl(RESUME_TOKEN_KEY, token);
        }
        backoff = 1000;
      } catch (e) {
        if (this.stopped) return;
        if (e.code === CHANGE_STREAM_HISTORY_LOST) {
          // El oplog ya no tiene el punto de reanudación: hubo un hueco. Se concilia todo.
          this.logger.warn('ALERTA: se perdió el historial del oplog; conciliando todo el S5');
          const en = new Date().toISOString();
          await recordAlert(this.store, this.logger, {
            tipo: 'historial_perdido', clave: en, origen: 'worker', detalle: { codigo: e.code, en },
          });
          await this.store.setControl(RESUME_TOKEN_KEY, null);
        } else {
          this.#fail('change stream', e);
        }
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60_000);
      } finally {
        await this.stream?.close().catch(() => {});
      }
    }
  }

  /**
   * Compara TODAS las denuncias del S5 con la última huella registrada.
   * Detecta altas, cambios y bajas que no llegaron por el change stream.
   */
  reconcile() {
    if (this.reconciling) return this.reconciling;
    this.reconciling = (async () => {
      const inicio = Date.now();
      const vistos = new Set();
      let cambios = 0;
      for await (const doc of this.source.scan()) {
        if (this.stopped) return;
        const denunciaId = idToString(doc._id);
        vistos.add(denunciaId);
        const estado = await this.store.getEstado(denunciaId);
        if (estado?.hashDocumento === hashDenuncia(doc, this.config.hash)) continue;
        // doc: undefined → se relee dentro del candado para registrar el estado vigente.
        if (await this.recorder.observe({ id: doc._id, denunciaId, doc: undefined, origen: 'conciliacion' })) cambios += 1;
      }
      for await (const { _id: denunciaId } of this.store.iterateEstadoActivos()) {
        if (vistos.has(denunciaId)) continue;
        const id = this.source.parseId(denunciaId) ?? denunciaId;
        if (await this.recorder.observe({ id, denunciaId, doc: undefined, origen: 'conciliacion' })) cambios += 1;
      }
      const resumen = { denuncias: vistos.size, cambios, ms: Date.now() - inicio };
      this.logger.info('Conciliación terminada', resumen);
      await this.store.setControl('ultimaConciliacion', { ...resumen, en: new Date().toISOString() });
    })().finally(() => {
      this.reconciling = null;
    });
    return this.reconciling;
  }
}
