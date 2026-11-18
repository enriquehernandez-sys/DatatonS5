/**
 * Panel de monitoreo de la integridad de la cadena (uso PÚBLICO).
 *
 * Principio rector: el nivel público ve el estado del sistema, nunca el de una persona.
 *
 *   /api/publico/*  – sin sesión. Solo datos agregados, encabezados de bloque (huellas sin
 *                     contenido) y alertas anonimizadas: sin número de denuncia, sin huellas de
 *                     documentos, sin notas, sin usuarios, fecha reducida al día y conteos
 *                     pequeños suprimidos (< UMBRAL_SUPRESION).
 *   /api/privado/*  – Contralor interno y Administrador. Detalle completo de cada anomalía,
 *                     historial de la denuncia afectada y registro del seguimiento.
 *                     CADA consulta queda en la bitácora de accesos.
 *   /api/admin/*    – solo Administrador: bitácora de accesos y estado operativo.
 */
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { verifyBlock } from '../core/block.js';
import { idToString } from '../core/canonical.js';
import {
  ESTADOS_ALERTA, TIPOS_ALERTA, estadoActual, folioDe, isAlertId, parseFolio, vistaCompleta, vistaPublica,
} from '../ledger/alerts.js';
import { checkIntegridad } from '../ledger/integridad.js';
import { alertaCadenaInvalida, publicHeader } from '../ledger/ledger.js';
import { COOKIE, ROLES, USUARIO_RE, createLockout, createTokens, parseCookies, verifyPassword } from './auth.js';

export const UMBRAL_SUPRESION = 5;
const DIAS_HISTORICO = 30;
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const ABIERTAS = new Set(['abierta', 'en_revision']);

/** Conteos pequeños se publican como null (suprimido) para impedir identificar casos aislados. */
export const suprimir = (n) => (n > 0 && n < UMBRAL_SUPRESION ? null : n);

export function createPanelApp({ config, store, ledger, source = null, logger, now = () => Date.now() }) {
  const cfg = config.panel;
  const tokens = createTokens(cfg.sessionSecret);
  const lockout = createLockout();
  const app = express();
  app.disable('x-powered-by');
  if (cfg.trustProxy) app.set('trust proxy', cfg.trustProxy);

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"], fontSrc: ["'self'"], manifestSrc: ["'self'"],
        baseUri: ["'none'"], formAction: ["'self'"], frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'no-referrer' },
  }));
  app.use((_req, res, next) => {
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
    next();
  });

  app.get('/salud', (_req, res) => res.json({ estado: 'ok' }));
  app.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: '1h', dotfiles: 'deny' }));

  const api = express.Router();
  api.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  api.use(rateLimit({
    windowMs: 60_000, limit: cfg.publicPerMinute, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Demasiadas consultas; intente en un minuto' },
  }));
  api.use(express.json({ limit: '16kb', strict: true }));
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

  // ===================== Público ==================================================

  async function resumenAlertas() {
    const [todas, estados] = await Promise.all([store.listAlertsLight(), store.estadosAlertas()]);
    const porSeveridad = Object.fromEntries(Object.keys(sevOrder).map((s) => [s, 0]));
    let abiertas = 0;
    let abiertasCriticas = 0;
    for (const a of todas) {
      if (ABIERTAS.has(estados.get(a._id) ?? 'abierta')) {
        abiertas += 1;
        porSeveridad[a.severidad] = (porSeveridad[a.severidad] ?? 0) + 1;
        if (a.severidad === 'critica') abiertasCriticas += 1;
      }
    }
    const desde = now() - DIAS_HISTORICO * 86_400_000;
    const ultimos30 = todas.filter((a) => new Date(a.detectadaEn).getTime() >= desde).length;
    return { total: todas.length, abiertas, abiertasCriticas, abiertasPorSeveridad: porSeveridad, ultimos30Dias: ultimos30 };
  }

  api.get('/publico/resumen', wrap(async (_req, res) => {
    const [head, pendientes, antiguoPendiente, verif, latido, alertas] = await Promise.all([
      store.head(),
      store.countPending(),
      store.oldestPending(),
      store.getControl('ultimaVerificacion'),
      store.getControl('latido'),
      resumenAlertas(),
    ]);
    const t = now();
    const edadLatido = latido?.en ? t - Date.parse(latido.en) : null;
    const sellado = latido
      ? edadLatido <= 3 * (latido.intervaloMs ?? 60_000) ? 'activo' : 'detenido'
      : 'desconocido';
    const edadPendiente = antiguoPendiente ? t - Date.parse(antiguoPendiente) : 0;

    let estado = 'integra';
    if (!verif) estado = 'sin_verificar';
    if (alertas.abiertas > 0 || sellado === 'detenido' || edadPendiente > cfg.maxPendingAgeMs) estado = 'en_observacion';
    if ((verif && !verif.valida) || alertas.abiertasCriticas > 0) estado = 'comprometida';

    res.json({
      estado,
      generadoEn: new Date(t).toISOString(),
      cadena: head ? { bloques: head.index + 1, cabeza: publicHeader(head) } : null,
      verificacion: verif ? { valida: verif.valida, bloques: verif.bloques, entradas: verif.entradas, errores: verif.errores, verificadoEn: verif.verificadoEn } : null,
      sellado: { estado: sellado, ultimoLatido: latido?.en ?? null, pendientes, pendienteMasAntiguoMin: Math.floor(edadPendiente / 60_000) },
      alertas,
    });
  }));

  api.get('/publico/actividad', wrap(async (_req, res) => {
    const desde = new Date(now() - (DIAS_HISTORICO - 1) * 86_400_000).toISOString().slice(0, 10);
    const { bloques, entradas } = await store.statsDiarias(desde);
    const dias = [];
    for (let i = DIAS_HISTORICO - 1; i >= 0; i -= 1) dias.push(new Date(now() - i * 86_400_000).toISOString().slice(0, 10));
    const by = (dia, f) => entradas.filter((e) => e.dia === dia && f(e)).reduce((s, e) => s + e.n, 0);
    res.json({
      umbralSupresion: UMBRAL_SUPRESION,
      dias: dias.map((dia) => ({
        dia,
        bloques: bloques.find((b) => b.dia === dia)?.n ?? 0,
        // Los conteos de denuncias se suprimen si son pequeños; los de bloques no son sensibles.
        altas: suprimir(by(dia, (e) => e.operacion === 'alta')),
        modificaciones: suprimir(by(dia, (e) => e.operacion === 'modificacion')),
        bajas: suprimir(by(dia, (e) => e.operacion === 'baja')),
        porConciliacion: suprimir(by(dia, (e) => e.origen === 'conciliacion')),
      })),
    });
  }));

  api.get('/publico/bloques', wrap(async (req, res) => {
    const antesDe = req.query.antesDe === undefined ? null : Number(req.query.antesDe);
    if (antesDe !== null && (!Number.isSafeInteger(antesDe) || antesDe < 0)) return res.status(400).json({ error: 'Parámetro inválido' });
    const rows = await store.blockHeaders({ limit: 15, antesDe });
    // En la vista pública los conteos por operación de un bloque se suprimen si son pequeños.
    res.json(rows.map((b) => ({
      ...b,
      operaciones: { alta: suprimir(b.operaciones.alta), modificacion: suprimir(b.operaciones.modificacion), baja: suprimir(b.operaciones.baja) },
    })));
  }));

  async function alertasConSeguimiento({ pagina, porPagina = 20 }) {
    const alertas = await store.listAlerts({ limit: porPagina, skip: (pagina - 1) * porPagina });
    const seg = await store.listSeguimiento(alertas.map((a) => a._id));
    return alertas.map((a) => [a, seg.filter((s) => s.alertaId === a._id)]);
  }
  const pagina = (req) => {
    const p = Number(req.query.pagina ?? 1);
    return Number.isSafeInteger(p) && p >= 1 && p <= 1000 ? p : null;
  };

  api.get('/publico/alertas', wrap(async (req, res) => {
    const p = pagina(req);
    if (!p) return res.status(400).json({ error: 'Página inválida' });
    res.json((await alertasConSeguimiento({ pagina: p })).map(([a, s]) => vistaPublica(a, s)));
  }));

  api.get('/publico/alertas/:folio', wrap(async (req, res) => {
    const id = parseFolio(req.params.folio);
    const alerta = id && (await store.getAlert(id));
    if (!alerta) return res.status(404).json({ error: 'Folio no encontrado' });
    res.json(vistaPublica(alerta, await store.listSeguimiento([id])));
  }));

  api.get('/publico/catalogo', (_req, res) => {
    res.json({
      tipos: Object.entries(TIPOS_ALERTA).map(([tipo, d]) => ({ tipo, titulo: d.titulo, severidad: d.severidad, alcance: d.alcance, descripcion: d.resumenPublico })),
      estados: ESTADOS_ALERTA,
      umbralSupresion: UMBRAL_SUPRESION,
    });
  });

  // ===================== Sesión ===================================================

  const secure = (req) => req.secure || !cfg.allowInsecureHttp;
  const setCookie = (req, res, value, maxAgeSec) => {
    res.append('Set-Cookie', [
      `${COOKIE}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`,
      ...(secure(req) ? ['Secure'] : []),
    ].join('; '));
  };
  const clearCookie = (req, res) => setCookie(req, res, '', 0);

  const bitacora = (req, accion, extra = {}) =>
    store.addBitacora({
      en: new Date(now()), accion, usuario: req.usuario?._id ?? extra.usuario ?? null, rol: req.usuario?.rol ?? null,
      ip: req.ip, objeto: extra.objeto ?? null, resultado: extra.resultado ?? 'ok',
    }).catch((e) => logger.error('No se pudo escribir la bitácora de accesos', { error: e.message }));

  const privilegedIps = new Set(cfg.privilegedIps.flatMap((ip) => [ip, `::ffff:${ip}`]));
  const desdeRedInstitucional = (req) => privilegedIps.size === 0 || privilegedIps.has(req.ip);

  /** Exige encabezado propio en peticiones que cambian estado (defensa CSRF junto con SameSite=Strict). */
  const csrf = (req, res, next) => (req.get('x-panel') === '1' ? next() : res.status(403).json({ error: 'Petición rechazada' }));

  const loginLimiter = rateLimit({
    windowMs: 15 * 60_000, limit: cfg.loginFailuresPerIp ?? 10, skipSuccessfulRequests: true,
    standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Demasiados intentos; espere 15 minutos' },
  });

  api.post('/sesion', loginLimiter, csrf, wrap(async (req, res) => {
    if (!desdeRedInstitucional(req)) {
      await bitacora(req, 'inicio_sesion', { resultado: 'red_no_autorizada' });
      return res.status(403).json({ error: 'El acceso restringido solo está disponible desde la red institucional' });
    }
    const usuario = typeof req.body?.usuario === 'string' ? req.body.usuario.trim().toLowerCase() : '';
    const contrasena = req.body?.contrasena;
    const fallo = async (resultado) => {
      await bitacora(req, 'inicio_sesion', { usuario: USUARIO_RE.test(usuario) ? usuario : null, resultado });
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    };
    if (!USUARIO_RE.test(usuario) || typeof contrasena !== 'string') return fallo('datos_invalidos');
    if (lockout.locked(usuario)) {
      await bitacora(req, 'inicio_sesion', { usuario, resultado: 'cuenta_bloqueada' });
      return res.status(429).json({ error: 'Cuenta bloqueada temporalmente por intentos fallidos' });
    }
    const user = await store.getPanelUser(usuario);
    const ok = await verifyPassword(contrasena, user?.hash); // siempre se calcula (tiempo constante)
    if (!ok || !user?.activo || !ROLES.includes(user.rol)) {
      lockout.fail(usuario);
      return fallo('credenciales_invalidas');
    }
    lockout.reset(usuario);
    const t = now();
    setCookie(req, res, tokens.issue({ u: user._id, v: user.version ?? 1, iat: t, act: t }), cfg.sessionMaxHours * 3600);
    req.usuario = user;
    await bitacora(req, 'inicio_sesion');
    res.json({ usuario: user._id, nombre: user.nombre, rol: user.rol });
  }));

  /** Carga la sesión: firma válida, sin expirar, cuenta activa y misma versión de credenciales. */
  async function loadSession(req, res) {
    const p = tokens.read(parseCookies(req.headers.cookie)[COOKIE]);
    if (!p) return null;
    const t = now();
    if (t - p.act > cfg.sessionMinutes * 60_000 || t - p.iat > cfg.sessionMaxHours * 3_600_000) {
      clearCookie(req, res);
      return null;
    }
    const user = await store.getPanelUser(p.u);
    if (!user?.activo || !ROLES.includes(user.rol) || (user.version ?? 1) !== p.v || !desdeRedInstitucional(req)) {
      clearCookie(req, res);
      return null;
    }
    // Renovación deslizante por actividad.
    setCookie(req, res, tokens.issue({ ...p, act: t }), Math.max(1, Math.floor((p.iat + cfg.sessionMaxHours * 3_600_000 - t) / 1000)));
    return user;
  }

  api.get('/sesion', wrap(async (req, res) => {
    const user = await loadSession(req, res);
    if (!user) return res.json({ rol: 'publico' });
    res.json({ usuario: user._id, nombre: user.nombre, rol: user.rol, inactividadMin: cfg.sessionMinutes });
  }));

  api.delete('/sesion', csrf, wrap(async (req, res) => {
    req.usuario = await loadSession(req, res);
    if (req.usuario) await bitacora(req, 'cierre_sesion');
    clearCookie(req, res);
    res.status(204).end();
  }));

  const privileged = express.Router();
  privileged.use(async (req, res, next) => {
    try {
      const user = await loadSession(req, res);
      if (!user) return res.status(401).json({ error: 'Sesión requerida' });
      req.usuario = user;
      next();
    } catch (e) {
      next(e);
    }
  });
  const onlyRoles = (...roles) => async (req, res, next) => {
    if (roles.includes(req.usuario.rol)) return next();
    await bitacora(req, 'acceso_denegado', { objeto: req.originalUrl.slice(0, 200), resultado: 'rol_insuficiente' });
    res.status(403).json({ error: 'Su rol no tiene acceso a esta sección' });
  };

  // ===================== Privado (Contralor interno y Administrador) ==============

  privileged.get('/privado/alertas', onlyRoles('contralor', 'administrador'), wrap(async (req, res) => {
    const p = pagina(req);
    if (!p) return res.status(400).json({ error: 'Página inválida' });
    const rows = await alertasConSeguimiento({ pagina: p });
    await bitacora(req, 'consulta_alertas', { objeto: `pagina ${p}` });
    res.json(rows.map(([a, s]) => vistaCompleta(a, s)));
  }));

  privileged.get('/privado/alertas/:id', onlyRoles('contralor', 'administrador'), wrap(async (req, res) => {
    const id = isAlertId(req.params.id) ? req.params.id : parseFolio(req.params.id);
    const alerta = id && (await store.getAlert(id));
    if (!alerta) return res.status(404).json({ error: 'Alerta no encontrada' });
    const seguimiento = await store.listSeguimiento([id]);
    const contexto = {};
    if (alerta.denunciaId) {
      contexto.historial = await ledger.history(alerta.denunciaId);
      contexto.integridadActual = await integridadEnVivo(alerta.denunciaId);
    }
    if (alerta.bloque !== null && alerta.bloque !== undefined) {
      const [b, prev] = await Promise.all([store.getBlock(alerta.bloque), alerta.bloque > 0 ? store.getBlock(alerta.bloque - 1) : null]);
      contexto.bloque = b
        ? { encabezado: publicHeader(b), erroresActuales: verifyBlock(b, alerta.bloque === 0 ? null : prev, ledger.trustedKeys) }
        : { encabezado: null, erroresActuales: ['El bloque ya no existe en la base del ledger'] };
    }
    await bitacora(req, 'consulta_alerta', { objeto: folioDe(id) });
    res.json({ ...vistaCompleta(alerta, seguimiento), contexto });
  }));

  privileged.post('/privado/alertas/:id/seguimiento', csrf, onlyRoles('contralor', 'administrador'), wrap(async (req, res) => {
    const id = isAlertId(req.params.id) ? req.params.id : null;
    const alerta = id && (await store.getAlert(id));
    if (!alerta) return res.status(404).json({ error: 'Alerta no encontrada' });
    const { estado, nota } = req.body ?? {};
    if (!ESTADOS_ALERTA.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
    if (typeof nota !== 'string' || nota.trim().length < 10 || nota.length > 2000) {
      return res.status(400).json({ error: 'La nota es obligatoria (10 a 2000 caracteres)' });
    }
    const previo = estadoActual(await store.listSeguimiento([id]));
    if (previo === estado) return res.status(409).json({ error: `La alerta ya está en estado "${estado}"` });
    await store.addSeguimiento({ alertaId: id, estado, nota: nota.trim(), usuario: req.usuario._id, rol: req.usuario.rol, en: new Date(now()) });
    await bitacora(req, 'seguimiento_alerta', { objeto: `${folioDe(id)}: ${previo} → ${estado}` });
    res.status(201).json(vistaCompleta(alerta, await store.listSeguimiento([id])));
  }));

  async function integridadEnVivo(denunciaId) {
    if (!source) return { disponible: false, mensaje: 'El panel no tiene acceso de lectura al S5; consulte la API interna' };
    const id = source.parseId(denunciaId);
    if (id === null) return { disponible: false, mensaje: 'Identificador no válido para el S5' };
    const { status, body } = await checkIntegridad({
      id, denunciaId, source, ledger, store, hashOptions: config.hash, logger, origen: 'panel',
    });
    return { disponible: true, status, ...body };
  }

  privileged.get('/privado/denuncias/:id', onlyRoles('contralor', 'administrador'), wrap(async (req, res) => {
    const raw = String(req.params.id);
    const parsed = source ? source.parseId(raw) : (/^[\w.:-]{1,128}$/.test(raw) ? raw : null);
    if (parsed === null) return res.status(400).json({ error: 'Identificador de denuncia inválido' });
    const denunciaId = idToString(parsed);
    const historial = await ledger.history(denunciaId);
    await bitacora(req, 'consulta_denuncia', { objeto: denunciaId });
    res.json({ historial, integridadActual: await integridadEnVivo(denunciaId) });
  }));

  // ===================== Administrador ===========================================

  privileged.get('/admin/bitacora', onlyRoles('administrador'), wrap(async (req, res) => {
    const p = pagina(req);
    if (!p) return res.status(400).json({ error: 'Página inválida' });
    const rows = await store.listBitacora({ limit: 50, skip: (p - 1) * 50 });
    await bitacora(req, 'consulta_bitacora', { objeto: `pagina ${p}` });
    res.json(rows);
  }));

  privileged.get('/admin/operacion', onlyRoles('administrador'), wrap(async (req, res) => {
    const [latido, conciliacion, verificacion, pendientes, antiguo] = await Promise.all([
      store.getControl('latido'), store.getControl('ultimaConciliacion'), store.getControl('ultimaVerificacion'),
      store.countPending(), store.oldestPending(),
    ]);
    await bitacora(req, 'consulta_operacion');
    res.json({
      latido, conciliacion, verificacion, pendientes, pendienteMasAntiguo: antiguo,
      llavesDeConfianza: [...ledger.trustedKeys.keys()],
      accesoS5DesdePanel: Boolean(source),
    });
  }));

  let verifying = null;
  privileged.post(
    '/admin/verificar',
    rateLimit({ windowMs: 60_000, limit: 2, standardHeaders: 'draft-8', legacyHeaders: false }),
    csrf,
    onlyRoles('administrador'),
    wrap(async (req, res) => {
      verifying ??= ledger.verifyChain().finally(() => { verifying = null; });
      const result = await verifying;
      if (!result.valida) await alertaCadenaInvalida(store, logger, result, 'panel');
      await bitacora(req, 'verificacion_manual', { resultado: result.valida ? 'valida' : 'invalida' });
      res.status(result.valida ? 200 : 409).json({ ...result, errores: result.errores.slice(0, 200) });
    }),
  );

  api.use(privileged);
  app.use('/api', api);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'No encontrado' }));
  app.use((_req, res) => res.status(404).type('text/plain').send('No encontrado'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
      return res.status(err.status ?? 400).json({ error: 'Cuerpo de la petición inválido' });
    }
    logger.error('Error no controlado en el panel', { error: err.message });
    res.status(500).json({ error: 'Error interno' });
  });
  return app;
}

const sevOrder = { critica: 0, alta: 1, media: 2, baja: 3 };
