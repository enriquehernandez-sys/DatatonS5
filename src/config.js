import { readFileSync } from 'node:fs';

function required(env, name) {
  const v = env[name];
  if (v === undefined || v === '') throw new Error(`Falta la variable de entorno ${name}`);
  return v;
}
const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
function int(env, name, def) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} debe ser un entero positivo`);
  return n;
}
function oneOf(env, name, options, def) {
  const v = env[name] || def;
  if (!options.includes(v)) throw new Error(`${name} debe ser uno de: ${options.join(', ')}`);
  return v;
}

function secretFrom(env, name) {
  const path = required(env, name);
  const s = readFileSync(path, 'utf8').trim();
  if (s.length < 32) throw new Error(`${name}: el secreto debe tener al menos 32 caracteres`);
  return s;
}

/**
 * ROL del proceso:
 *  - worker : lee el S5, registra cambios y sella/firma bloques (tiene la llave privada).
 *  - api    : solo consulta y verifica (sin llave privada, usuario Mongo de solo lectura).
 *  - panel  : dashboard público de monitoreo (sin llave privada; S5 opcional).
 *  - todo   : todo en el mismo proceso (solo para desarrollo).
 */
export function loadConfig(env = process.env) {
  const rol = oneOf(env, 'ROL', ['worker', 'api', 'panel', 'todo'], 'todo');
  const needsWorker = rol === 'worker' || rol === 'todo';
  const needsApi = rol === 'api' || rol === 'todo';
  const needsPanel = rol === 'panel' || rol === 'todo';
  // El panel es público: puede operar SIN acceso al S5 (entonces omite la comparación en vivo).
  const s5Optional = rol === 'panel' && !env.S5_MONGO_URI;

  const pepperPath = env.HASH_PEPPER_PATH;
  const pepper = pepperPath ? readFileSync(pepperPath, 'utf8').trim() : null;
  if (pepperPath && pepper.length < 32) throw new Error('El pepper debe tener al menos 32 caracteres');

  return Object.freeze({
    rol,
    s5: s5Optional ? null : Object.freeze({
      uri: required(env, 'S5_MONGO_URI'),
      db: required(env, 'S5_DB'),
      collection: env.S5_COLLECTION || 'denuncias',
      idType: oneOf(env, 'S5_ID_TYPE', ['objectId', 'string'], 'objectId'),
      excludeFields: list(env.S5_EXCLUDE_FIELDS),
      mode: oneOf(env, 'S5_MODO', ['flujo', 'sondeo'], 'flujo'),
      fullDocument: oneOf(env, 'S5_FULL_DOCUMENT', ['updateLookup', 'whenAvailable', 'required'], 'updateLookup'),
      pollIntervalMs: int(env, 'S5_SONDEO_MS', 300_000),
    }),
    ledger: Object.freeze({
      uri: required(env, 'LEDGER_MONGO_URI'),
      db: env.LEDGER_DB || 's5_cadena',
    }),
    hash: Object.freeze({ pepper, exclude: list(env.S5_EXCLUDE_FIELDS) }),
    keys: Object.freeze({
      signingKeyPath: needsWorker ? required(env, 'LLAVE_FIRMA_PATH') : null,
      trustedKeysDir: required(env, 'LLAVES_CONFIANZA_DIR'),
    }),
    blocks: Object.freeze({
      maxEntries: int(env, 'BLOQUE_MAX_ENTRADAS', 500),
      intervalMs: int(env, 'BLOQUE_INTERVALO_MS', 60_000),
      auditIntervalMs: int(env, 'AUDITORIA_INTERVALO_MS', 21_600_000),
      verifyIntervalMs: int(env, 'VERIFICACION_INTERVALO_MS', 3_600_000),
      sealEmpty: env.BLOQUE_SELLAR_VACIOS === 'true',
    }),
    api: Object.freeze({
      enabled: needsApi,
      host: env.API_HOST || '127.0.0.1',
      port: int(env, 'API_PORT', 8443),
      tlsCert: env.TLS_CERT_PATH || null,
      tlsKey: env.TLS_KEY_PATH || null,
      tlsPfx: env.TLS_PFX_PATH || null, // alternativa a cert/key: archivo .pfx (Windows)
      tlsPfxPassFile: env.TLS_PFX_CLAVE_PATH || null,
      tlsCa: env.TLS_CA_PATH || null, // si se define, se exige certificado de cliente (mTLS)
      apiKeysSha256: list(env.API_KEYS_SHA256),
      allowedIps: list(env.IPS_PERMITIDAS),
      limitePorMinuto: int(env, 'API_LIMITE_POR_MINUTO', 6000),
      // IP o subred del proxy inverso (p. ej. 10.0.20.5); nunca "true"
      trustProxy: env.TRUST_PROXY || false,
      allowInsecureHttp: env.PERMITIR_HTTP_INSEGURO === 'true',
    }),
    panel: Object.freeze({
      enabled: needsPanel,
      host: env.PANEL_HOST || '127.0.0.1',
      port: int(env, 'PANEL_PORT', 8444),
      tlsCert: env.PANEL_TLS_CERT_PATH || env.TLS_CERT_PATH || null,
      tlsKey: env.PANEL_TLS_KEY_PATH || env.TLS_KEY_PATH || null,
      tlsPfx: env.PANEL_TLS_PFX_PATH || null, // alternativa a cert/key: archivo .pfx (Windows)
      tlsPfxPassFile: env.PANEL_TLS_PFX_CLAVE_PATH || null,
      tlsCa: null, // el panel es público: no exige certificado de cliente
      allowInsecureHttp: env.PERMITIR_HTTP_INSEGURO === 'true',
      trustProxy: env.PANEL_TRUST_PROXY || env.TRUST_PROXY || false,
      // Secreto (>=32 caracteres) para firmar las sesiones de contraloría/administración.
      sessionSecret: needsPanel ? secretFrom(env, 'PANEL_SECRETO_SESION_PATH') : null,
      sessionMinutes: int(env, 'PANEL_SESION_MINUTOS', 30), // inactividad
      sessionMaxHours: int(env, 'PANEL_SESION_MAX_HORAS', 8), // duración absoluta
      // Solo IPs de la red institucional pueden iniciar sesión privilegiada (vacío = cualquiera).
      privilegedIps: list(env.PANEL_IPS_PRIVILEGIADAS),
      publicPerMinute: int(env, 'PANEL_LIMITE_PUBLICO_POR_MINUTO', 120),
      loginFailuresPerIp: int(env, 'PANEL_INTENTOS_FALLIDOS_POR_IP', 10),
      maxPendingAgeMs: int(env, 'PANEL_MAX_ANTIGUEDAD_PENDIENTE_MS', 900_000),
    }),
  });
}
