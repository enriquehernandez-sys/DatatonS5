/**
 * Auditoría completa de la cadena desde la línea de comandos.
 * Útil para cron, para el Órgano Interno de Control o para auditores externos
 * con un usuario de solo lectura sobre el MongoDB del ledger.
 *
 *   LEDGER_MONGO_URI=... LLAVES_CONFIANZA_DIR=./llaves/confianza node scripts/verificar-cadena.js
 * Código de salida: 0 = íntegra, 2 = alterada, 1 = error.
 */
import { MongoClient } from 'mongodb';
import { loadTrustedKeys } from '../src/core/signer.js';
import { Ledger } from '../src/ledger/ledger.js';
import { LedgerStore } from '../src/ledger/store.js';

const uri = process.env.LEDGER_MONGO_URI;
const keysDir = process.env.LLAVES_CONFIANZA_DIR;
if (!uri || !keysDir) {
  console.error('Defina LEDGER_MONGO_URI y LLAVES_CONFIANZA_DIR');
  process.exit(1);
}

const client = new MongoClient(uri, { appName: 's5-cadena-auditoria' });
try {
  await client.connect();
  const store = new LedgerStore(client.db(process.env.LEDGER_DB || 's5_cadena'));
  const ledger = new Ledger({ store, trustedKeys: loadTrustedKeys(keysDir) });
  const r = await ledger.verifyChain();
  console.log(JSON.stringify(r, null, 2));
  process.exitCode = r.valida ? 0 : 2;
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exitCode = 1;
} finally {
  await client.close();
}
