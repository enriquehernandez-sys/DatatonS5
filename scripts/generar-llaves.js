/**
 * Genera el par de llaves Ed25519 de firma de bloques.
 *   node scripts/generar-llaves.js [directorio]   (por defecto ./llaves)
 *
 * - llaves/firma-privada.pem  → SOLO en el servidor worker (permisos 600). Respaldar en bóveda/HSM.
 * - llaves/confianza/<id>.pem → llave pública: se distribuye a la API y a auditores externos.
 */
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { keyIdOf } from '../src/core/signer.js';

const dir = resolve(process.argv[2] ?? 'llaves');
const privPath = join(dir, 'firma-privada.pem');
if (existsSync(privPath)) {
  console.error(`Ya existe ${privPath}. No se sobrescribe; para rotar, muévala primero.`);
  process.exit(1);
}
mkdirSync(join(dir, 'confianza'), { recursive: true, mode: 0o700 });

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const keyId = keyIdOf(publicKey);
writeFileSync(privPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
const pubPath = join(dir, 'confianza', `${keyId}.pem`);
writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644 });

console.log(`Llave generada (keyId ${keyId})`);
console.log(`  privada: ${privPath}`);
console.log(`  pública: ${pubPath}`);
