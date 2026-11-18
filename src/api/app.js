/**
 * API REST de consulta y verificación (solo lectura).
 * No expone NINGÚN dato personal de las denuncias: únicamente huellas, bloques y pruebas.
 */
import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { BSON } from 'mongodb';
import { idToString } from '../core/canonical.js';
import { hashDenuncia } from '../core/hash.js';
import { publicHeader, alertaCadenaInvalida } from '../ledger/ledger.js';
import { checkIntegridad } from '../ledger/integridad.js';
import { apiKeyAuth, ipAllowlist } from './security.js';

const VERIFY_CACHE_MS = 60_000;
const HEX64 = /^[0-9a-f]{64}$/;

export function createApp({ config, store, ledger, source, logger }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.api.trustProxy) app.set('trust proxy', config.api.trustProxy);

  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"] } } }));
  app.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // Salud sin autenticación (para el balanceador). No revela información.
  app.get('/salud', (_req, res) => res.json({ estado: 'ok' }));

  const api = express.Router();
  api.use(ipAllowlist(config.api.allowedIps));
  // 1) Anti fuerza bruta: por IP, solo cuentan las peticiones rechazadas.
  api.use(rateLimit({
    windowMs: 15 * 60_000, limit: 30, skipSuccessfulRequests: true,
    standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Demasiados intentos fallidos' },
  }));
  api.use(apiKeyAuth(config.api.apiKeysSha256));
  // 2) Cuota por CONSUMIDOR (llave de API), no por IP: el backend del S5 llega desde una sola IP.
  api.use(rateLimit({
    windowMs: 60_000, limit: config.api.limitePorMinuto ?? 6000, keyGenerator: (req) => req.apiKeyId,
    standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Cuota excedida' },
  }));
  api.use(express.json({ limit: '1mb', strict: true }));

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

  const parseDenunciaId = (req, res) => {
    const id = source.parseId(req.params.id);
    if (id === null) res.status(400).json({ error: 'Identificador de denuncia inválido' });
    return id;
  };

  // --- Cadena ---------------------------------------------------------------
  api.get('/cadena/cabeza', wrap(async (_req, res) => {
    const head = await store.head();
    if (!head) return res.status(404).json({ error: 'Cadena vacía' });
    res.json({ ...publicHeader(head), pendientes: await store.countPending() });
  }));

  api.get('/cadena/bloques/:index', wrap(async (req, res) => {
    const index = Number(req.params.index);
    if (!Number.isSafeInteger(index) || index < 0) return res.status(400).json({ error: 'Índice inválido' });
    const block = await store.getBlock(index);
    if (!block) return res.status(404).json({ error: 'Bloque no encontrado' });
    res.json(block);
  }));

  // Verificación integral: costosa, por eso se limita y se guarda en caché.
  let cache = null;
  api.get(
    '/cadena/verificacion',
    rateLimit({ windowMs: 60_000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false }),
    wrap(async (_req, res) => {
      if (!cache || Date.now() - cache.at > VERIFY_CACHE_MS) {
        cache = { at: Date.now(), promise: ledger.verifyChain() };
      }
      const result = await cache.promise;
      if (!result.valida) {
        logger.error('ALERTA: la cadena NO es íntegra', { errores: result.errores.slice(0, 20) });
        await alertaCadenaInvalida(store, logger, result, 'api');
      }
      res.status(result.valida ? 200 : 409).json(result);
    }),
  );

  // --- Denuncias --------------------------------------------------------------
  api.get('/denuncias/:id/historial', wrap(async (req, res) => {
    const id = parseDenunciaId(req, res);
    if (id === null) return;
    res.json(await ledger.history(idToString(id)));
  }));

  api.get('/denuncias/:id/prueba', wrap(async (req, res) => {
    const id = parseDenunciaId(req, res);
    if (id === null) return;
    const entryId = typeof req.query.entrada === 'string' && HEX64.test(req.query.entrada) ? req.query.entrada : null;
    const proof = await ledger.proof(idToString(id), entryId);
    if (!proof) return res.status(404).json({ error: 'La denuncia aún no tiene entradas selladas' });
    res.json(proof);
  }));

  /** ¿El documento VIGENTE en el S5 coincide con la última huella sellada en la cadena? */
  api.get('/denuncias/:id/integridad', wrap(async (req, res) => {
    const id = parseDenunciaId(req, res);
    if (id === null) return;
    const { status, body } = await checkIntegridad({
      id, denunciaId: idToString(id), source, ledger, store, hashOptions: config.hash, logger, origen: 'api',
    });
    res.status(status).json(body);
  }));

  /**
   * Verifica un documento exportado (Extended JSON) contra la cadena:
   * responde si esa versión exacta fue sellada y cuándo.
   */
  api.post('/documentos/verificar', wrap(async (req, res) => {
    const raw = req.body?.documento;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return res.status(400).json({ error: 'Envíe { "documento": { ... } } en Extended JSON' });
    }
    let doc;
    try {
      doc = BSON.EJSON.deserialize(raw, { relaxed: false });
    } catch {
      return res.status(400).json({ error: 'Extended JSON inválido' });
    }
    const hashDocumento = hashDenuncia(doc, config.hash);
    const blocks = await store.findBlocksWith({ 'entradas.hashDocumento': hashDocumento });
    const coincidencias = blocks.flatMap((b) =>
      b.entradas
        .filter((e) => e.hashDocumento === hashDocumento)
        .map((e) => ({ denunciaId: e.denunciaId, version: e.version, operacion: e.operacion, bloque: b.index, selladoEn: b.timestamp })),
    );
    res.json({ hashDocumento, sellado: coincidencias.length > 0, coincidencias });
  }));

  app.use('/api/v1', api);
  app.use((_req, res) => res.status(404).json({ error: 'No encontrado' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
      return res.status(err.status ?? 400).json({ error: 'Cuerpo de la petición inválido' });
    }
    logger.error('Error no controlado en la API', { error: err.message });
    res.status(500).json({ error: 'Error interno' }); // nunca se expone el stack
  });
  return app;
}
