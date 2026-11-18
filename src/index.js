/**
 * Punto de entrada del servicio "Cadena Digital S5".
 * Se recomienda desplegarlo en un servidor DISTINTO al del S5:
 *   - Lee el MongoDB del S5 con un usuario de solo lectura.
 *   - Escribe en su propio MongoDB, al que el S5 no tiene acceso.
 */
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { MongoClient } from 'mongodb';
import { createApp } from './api/app.js';
import { createPanelApp } from './panel/app.js';
import { loadConfig } from './config.js';
import { loadSigner, loadTrustedKeys } from './core/signer.js';
import { Ledger } from './ledger/ledger.js';
import { LedgerStore } from './ledger/store.js';
import { logger } from './logger.js';
import { Recorder } from './sync/recorder.js';
import { S5Source } from './sync/source.js';
import { SyncWorker } from './sync/worker.js';

const MONGO_OPTS = { appName: 's5-cadena-digital', serverSelectionTimeoutMS: 15_000 };

function createServer(app, api, nombre = 'API') {
  // Certificado en formato PKCS#12 (.pfx), el que genera Windows (New-SelfSignedCertificate).
  if (api.tlsPfx) {
    const opts = { pfx: readFileSync(api.tlsPfx), minVersion: 'TLSv1.2' };
    if (api.tlsPfxPassFile) opts.passphrase = readFileSync(api.tlsPfxPassFile, 'utf8').trim();
    if (api.tlsCa) Object.assign(opts, { ca: readFileSync(api.tlsCa), requestCert: true, rejectUnauthorized: true });
    return https.createServer(opts, app);
  }
  if (api.tlsCert && api.tlsKey) {
    const opts = { cert: readFileSync(api.tlsCert), key: readFileSync(api.tlsKey), minVersion: 'TLSv1.2' };
    if (api.tlsCa) Object.assign(opts, { ca: readFileSync(api.tlsCa), requestCert: true, rejectUnauthorized: true });
    return https.createServer(opts, app);
  }
  if (!api.allowInsecureHttp) {
    throw new Error(`${nombre}: configure certificado TLS (o PERMITIR_HTTP_INSEGURO=true solo detrás de un proxy TLS)`);
  }
  logger.warn(`${nombre} en HTTP sin cifrar: úsese solo detrás de un proxy inverso con TLS`);
  return http.createServer(app);
}

async function main() {
  // --rol=worker|api|panel|todo  (multiplataforma; en Windows no funciona "ROL=x npm start")
  const argRol = process.argv.find((a) => a.startsWith('--rol='));
  const config = loadConfig(argRol ? { ...process.env, ROL: argRol.slice(6) } : process.env);
  const trustedKeys = loadTrustedKeys(config.keys.trustedKeysDir);
  const signer = config.keys.signingKeyPath ? loadSigner(config.keys.signingKeyPath, logger) : null;
  if (signer && !trustedKeys.has(signer.keyId)) {
    throw new Error(`La llave pública de firma (${signer.keyId}) no está en LLAVES_CONFIANZA_DIR`);
  }

  // El panel puede operar sin acceso al S5 (config.s5 === null).
  const s5Client = config.s5 ? new MongoClient(config.s5.uri, { ...MONGO_OPTS, readPreference: 'secondaryPreferred' }) : null;
  const ledgerClient = new MongoClient(config.ledger.uri, { ...MONGO_OPTS, writeConcern: { w: 'majority', j: true } });
  await Promise.all([s5Client?.connect(), ledgerClient.connect()]);

  const store = new LedgerStore(ledgerClient.db(config.ledger.db), logger);
  if (config.rol === 'worker' || config.rol === 'todo') await store.init();
  const source = s5Client ? new S5Source({ db: s5Client.db(config.s5.db), ...config.s5 }) : null;
  const ledger = new Ledger({ store, signer, trustedKeys, logger, maxEntries: config.blocks.maxEntries });

  let worker = null;
  if (config.rol === 'worker' || config.rol === 'todo') {
    const recorder = new Recorder({ store, source, hashOptions: config.hash, logger });
    worker = new SyncWorker({ config, store, ledger, source, recorder, logger });
    await worker.start();
  }

  let server = null;
  if (config.api.enabled) {
    server = createServer(createApp({ config, store, ledger, source, logger }), config.api);
    server.headersTimeout = 15_000;
    server.requestTimeout = 30_000;
    await new Promise((r) => server.listen(config.api.port, config.api.host, r));
    logger.info('API escuchando', { host: config.api.host, port: config.api.port });
  }

  let panelServer = null;
  if (config.panel.enabled) {
    panelServer = createServer(createPanelApp({ config, store, ledger, source, logger }), config.panel, 'Panel');
    panelServer.headersTimeout = 15_000;
    panelServer.requestTimeout = 30_000;
    await new Promise((r) => panelServer.listen(config.panel.port, config.panel.host, r));
    logger.info('Panel de monitoreo escuchando', { host: config.panel.host, port: config.panel.port, accesoS5: Boolean(source) });
  }
  logger.info('Servicio iniciado', { rol: config.rol, llave: signer?.keyId ?? null });

  const shutdown = async (signal) => {
    logger.info('Deteniendo servicio', { signal });
    server?.close();
    panelServer?.close();
    await worker?.stop();
    await Promise.allSettled([s5Client?.close(), ledgerClient.close()]);
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((e) => {
  logger.error('Fallo al iniciar', { error: e.message });
  process.exit(1);
});
