/**
 * Registra en "pendientes" cada cambio real en el contenido de una denuncia.
 * Todas las observaciones se procesan en serie para que las versiones sean
 * consecutivas y no haya condiciones de carrera.
 */
import { makeEntry } from '../core/block.js';
import { hashDenuncia } from '../core/hash.js';
import { createMutex } from '../ledger/ledger.js';
import { recordAlert } from '../ledger/alerts.js';

export class Recorder {
  constructor({ store, source, hashOptions, logger, onEntry = () => {} }) {
    this.store = store;
    this.source = source;
    this.hashOptions = hashOptions;
    this.logger = logger;
    this.onEntry = onEntry;
    this.lock = createMutex();
  }

  /**
   * @param {object} obs
   * @param {*}      obs.id          _id original (para releer del S5)
   * @param {string} obs.denunciaId  _id como texto
   * @param {object|null|undefined} obs.doc  documento; null = borrado; undefined = releer
   * @param {'flujo'|'conciliacion'} obs.origen
   */
  observe(obs) {
    return this.lock(() => this.#observe(obs));
  }

  async #observe({ id, denunciaId, doc, origen }) {
    // Releer dentro del candado garantiza registrar el estado más reciente.
    if (doc === undefined) doc = await this.source.findById(id);

    const hashDocumento = doc ? hashDenuncia(doc, this.hashOptions) : null;
    const estado = await this.store.getEstado(denunciaId);
    const anterior = estado?.hashDocumento ?? null;
    if (hashDocumento === anterior) return null; // sin cambios de contenido

    // alta = aparece (o reaparece tras una baja); baja = desaparece; modificacion = cambia.
    const operacion = hashDocumento === null ? 'baja' : anterior === null ? 'alta' : 'modificacion';
    const entry = makeEntry({
      denunciaId,
      version: (estado?.version ?? 0) + 1,
      operacion,
      hashDocumento,
      observadoEn: new Date().toISOString(),
      origen,
    });

    await this.store.addPending(entry);
    await this.store.setEstado(denunciaId, { hashDocumento, version: entry.version, actualizadoEn: new Date() });

    if (origen === 'conciliacion' && estado) {
      // Cambio que NO llegó por el flujo de eventos: posible manipulación directa
      // de la base del S5 mientras este servicio estaba detenido. Debe revisarse.
      this.logger?.warn('ALERTA: cambio detectado por conciliación', {
        denunciaId, operacion: entry.operacion, version: entry.version,
      });
      await recordAlert(this.store, this.logger, {
        tipo: 'cambio_por_conciliacion',
        clave: `${denunciaId}|${entry.version}|${hashDocumento}`,
        origen: 'worker',
        denunciaId,
        detalle: {
          operacion: entry.operacion,
          version: entry.version,
          hashAnterior: anterior,
          hashNuevo: hashDocumento,
          entryId: entry.entryId,
        },
      });
    }
    this.onEntry(entry);
    return entry;
  }
}
