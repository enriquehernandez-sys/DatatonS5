/**
 * Acceso de SOLO LECTURA a la colección de denuncias del S5.
 * El usuario de MongoDB debe tener únicamente el rol `read` (ver mongo/crear-usuario-s5.js).
 */
import { BSON } from 'mongodb';
import { idToString } from '../core/canonical.js';

export class S5Source {
  constructor({ db, collection, idType, fullDocument }) {
    this.coll = db.collection(collection);
    this.idType = idType;
    this.fullDocument = fullDocument;
  }

  /** Valida y convierte un identificador recibido como texto. */
  parseId(raw) {
    if (typeof raw !== 'string') return null;
    if (this.idType === 'objectId') {
      return /^[0-9a-fA-F]{24}$/.test(raw) ? BSON.ObjectId.createFromHexString(raw.toLowerCase()) : null;
    }
    return /^[\w.:-]{1,128}$/.test(raw) ? raw : null;
  }

  findById(id) {
    return this.coll.findOne({ _id: id });
  }

  /** Recorre todas las denuncias (para conciliación/auditoría). */
  async *scan() {
    yield* this.coll.find({}, { sort: { _id: 1 }, batchSize: 500 });
  }

  /** Abre un change stream. Requiere que el S5 corra como replica set. */
  watch(resumeAfter = null) {
    const options = { fullDocument: this.fullDocument };
    if (resumeAfter) options.resumeAfter = resumeAfter;
    return this.coll.watch(
      [{ $match: { operationType: { $in: ['insert', 'update', 'replace', 'delete', 'drop', 'invalidate'] } } }],
      options,
    );
  }

  static eventToObservation(event) {
    if (!event.documentKey) return null;
    const denunciaId = idToString(event.documentKey._id);
    if (event.operationType === 'delete') return { id: event.documentKey._id, denunciaId, doc: null };
    // Con updateLookup, si el documento fue borrado inmediatamente fullDocument es null
    // → se marca para releer y así nunca registrar un estado incierto.
    return { id: event.documentKey._id, denunciaId, doc: event.fullDocument ?? undefined };
  }
}
