/**
 * Almacén del ledger en un MongoDB SEPARADO del S5.
 *
 * Colecciones:
 *   bloques           – cadena firmada (solo inserción; ver mongo/crear-roles-ledger.js)
 *   pendientes        – entradas aún no selladas en un bloque
 *   estado_denuncias  – última huella conocida por denuncia (para detectar cambios)
 *   control           – token de reanudación del change stream, latido, última verificación…
 *   alertas           – anomalías detectadas (solo inserción, deduplicadas por `clave`)
 *   alertas_seguimiento – atención de cada alerta por contraloría/administración (solo inserción)
 *   bitacora_accesos  – quién consultó información reservada en el panel (solo inserción)
 *   usuarios_panel    – cuentas de Contralor interno y Administrador
 */
const ERR_UNAUTHORIZED = 13;
const ERR_NAMESPACE_EXISTS = 48;

export const BLOQUES_SCHEMA = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['version', 'index', 'timestamp', 'prevHash', 'merkleRoot', 'entryCount', 'keyId', 'hash', 'signature', 'entradas'],
    properties: {
      index: { bsonType: ['int', 'long'], minimum: 0 },
      prevHash: { bsonType: 'string', pattern: '^[0-9a-f]{64}$' },
      merkleRoot: { bsonType: 'string', pattern: '^[0-9a-f]{64}$' },
      hash: { bsonType: 'string', pattern: '^[0-9a-f]{64}$' },
      signature: { bsonType: 'string' },
      entradas: { bsonType: 'array' },
    },
  },
};

const noId = { projection: { _id: 0 } };

export class LedgerStore {
  constructor(db, logger) {
    this.db = db;
    this.logger = logger;
    this.bloques = db.collection('bloques');
    this.pendientes = db.collection('pendientes');
    this.estado = db.collection('estado_denuncias');
    this.control = db.collection('control');
    this.alertas = db.collection('alertas');
    this.seguimiento = db.collection('alertas_seguimiento');
    this.bitacora = db.collection('bitacora_accesos');
    this.usuarios = db.collection('usuarios_panel');
  }

  /** Crea colecciones e índices si el usuario tiene permiso; si no, asume que el DBA ya los creó. */
  async init() {
    try {
      await this.db.createCollection('bloques', { validator: BLOQUES_SCHEMA, validationLevel: 'strict' });
    } catch (e) {
      if (e.code !== ERR_NAMESPACE_EXISTS && e.code !== ERR_UNAUTHORIZED) throw e;
    }
    try {
      await this.bloques.createIndex({ index: 1 }, { unique: true }); // impide bifurcaciones
      await this.bloques.createIndex({ hash: 1 }, { unique: true });
      await this.bloques.createIndex({ 'entradas.denunciaId': 1 });
      await this.bloques.createIndex({ 'entradas.hashDocumento': 1 });
      await this.bloques.createIndex({ timestamp: 1 });
      await this.alertas.createIndex({ clave: 1 }, { unique: true }); // deduplicación
      await this.alertas.createIndex({ detectadaEn: -1 });
      await this.seguimiento.createIndex({ alertaId: 1, en: 1 });
      await this.bitacora.createIndex({ en: -1 });
    } catch (e) {
      if (e.code !== ERR_UNAUTHORIZED) throw e;
      this.logger?.warn('Sin permiso para crear índices; se asume que el DBA los creó');
    }
  }

  head() {
    return this.bloques.findOne({}, { sort: { index: -1 }, ...noId });
  }
  getBlock(index) {
    return this.bloques.findOne({ index }, noId);
  }
  iterateBlocks() {
    return this.bloques.find({}, { sort: { index: 1 }, ...noId });
  }
  insertBlock(block) {
    return this.bloques.insertOne({ ...block });
  }
  findBlocksWith(filter) {
    return this.bloques.find(filter, { sort: { index: 1 }, ...noId }).toArray();
  }

  addPending(entry) {
    return this.pendientes.insertOne({ ...entry });
  }
  takePending(limit) {
    return this.pendientes.find({}, { sort: { _id: 1 }, limit }).toArray();
  }
  countPending() {
    return this.pendientes.countDocuments();
  }
  findPending(filter) {
    return this.pendientes.find(filter, { sort: { _id: 1 } }).toArray();
  }
  removePendingByIds(ids) {
    return this.pendientes.deleteMany({ _id: { $in: ids } });
  }
  removePendingByEntryIds(entryIds) {
    return this.pendientes.deleteMany({ entryId: { $in: entryIds } });
  }

  getEstado(denunciaId) {
    return this.estado.findOne({ _id: denunciaId });
  }
  setEstado(denunciaId, data) {
    return this.estado.updateOne({ _id: denunciaId }, { $set: data }, { upsert: true });
  }
  iterateEstadoActivos() {
    return this.estado.find({ hashDocumento: { $ne: null } }, { projection: { _id: 1 } });
  }

  async getControl(key) {
    return (await this.control.findOne({ _id: key }))?.valor ?? null;
  }
  setControl(key, valor) {
    return this.control.updateOne({ _id: key }, { $set: { valor, actualizadoEn: new Date() } }, { upsert: true });
  }

  // --- Panel de monitoreo -------------------------------------------------------

  /** Encabezados de bloque (sin entradas) con el conteo por operación. Orden descendente. */
  blockHeaders({ limit = 20, antesDe = null } = {}) {
    const count = (op) => ({ $size: { $filter: { input: '$entradas', cond: { $eq: ['$$this.operacion', op] } } } });
    return this.bloques.aggregate([
      ...(antesDe === null ? [] : [{ $match: { index: { $lt: antesDe } } }]),
      { $sort: { index: -1 } },
      { $limit: limit },
      {
        $project: {
          _id: 0, version: 1, index: 1, timestamp: 1, prevHash: 1, merkleRoot: 1, entryCount: 1, keyId: 1, hash: 1, signature: 1,
          operaciones: { alta: count('alta'), modificacion: count('modificacion'), baja: count('baja') },
        },
      },
    ]).toArray();
  }

  /** Bloques y entradas por día (UTC) y por operación desde `desdeIso`. */
  async statsDiarias(desdeIso) {
    const [bloques, entradas] = await Promise.all([
      this.bloques.aggregate([
        { $match: { timestamp: { $gte: desdeIso } } },
        { $group: { _id: { $substrBytes: ['$timestamp', 0, 10] }, n: { $sum: 1 } } },
      ]).toArray(),
      this.bloques.aggregate([
        { $match: { timestamp: { $gte: desdeIso } } },
        { $unwind: '$entradas' },
        { $group: { _id: { dia: { $substrBytes: ['$timestamp', 0, 10] }, op: '$entradas.operacion', origen: '$entradas.origen' }, n: { $sum: 1 } } },
      ]).toArray(),
    ]);
    return {
      bloques: bloques.map((b) => ({ dia: b._id, n: b.n })),
      entradas: entradas.map((e) => ({ dia: e._id.dia, operacion: e._id.op, origen: e._id.origen, n: e.n })),
    };
  }

  /** Antigüedad de la entrada pendiente más vieja (para detectar sellado atrasado). */
  async oldestPending() {
    const p = await this.pendientes.findOne({}, { sort: { _id: 1 }, projection: { observadoEn: 1 } });
    return p?.observadoEn ?? null;
  }

  /** Inserta una alerta; devuelve false si ya existía otra con la misma clave. */
  async insertAlert(alerta) {
    try {
      await this.alertas.insertOne({ ...alerta });
      return true;
    } catch (e) {
      if (e.code === 11000) return false;
      throw e;
    }
  }
  getAlert(id) {
    return this.alertas.findOne({ _id: id });
  }
  listAlerts({ limit = 50, skip = 0 } = {}) {
    return this.alertas.find({}, { sort: { detectadaEn: -1 }, skip, limit }).toArray();
  }
  /** Solo tipo/severidad/fecha de TODAS las alertas (para conteos). */
  listAlertsLight() {
    return this.alertas.find({}, { projection: { tipo: 1, severidad: 1, detectadaEn: 1 } }).toArray();
  }
  addSeguimiento(evento) {
    return this.seguimiento.insertOne({ ...evento });
  }
  listSeguimiento(alertaIds) {
    return this.seguimiento.find({ alertaId: { $in: alertaIds } }, { sort: { en: 1, _id: 1 } }).toArray();
  }
  /** Último estado registrado de cada alerta con seguimiento: Map(alertaId → estado). */
  async estadosAlertas() {
    const rows = await this.seguimiento.aggregate([
      { $sort: { en: 1, _id: 1 } },
      { $group: { _id: '$alertaId', estado: { $last: '$estado' } } },
    ]).toArray();
    return new Map(rows.map((r) => [r._id, r.estado]));
  }

  addBitacora(evento) {
    return this.bitacora.insertOne({ ...evento });
  }
  listBitacora({ limit = 100, skip = 0 } = {}) {
    return this.bitacora.find({}, { sort: { en: -1, _id: -1 }, skip, limit, projection: { _id: 0 } }).toArray();
  }

  getPanelUser(usuario) {
    return this.usuarios.findOne({ _id: usuario });
  }
}
