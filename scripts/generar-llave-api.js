/**
 * Genera una llave de API para un consumidor (p. ej. el backend del S5 o un auditor).
 * La llave se entrega al consumidor por un canal seguro; en la configuración
 * del servicio SOLO se guarda su SHA-256 (variable API_KEYS_SHA256).
 */
import { createHash, randomBytes } from 'node:crypto';

const key = randomBytes(32).toString('base64url');
console.log('Llave (entregar al consumidor, no se vuelve a mostrar):');
console.log(`  ${key}`);
console.log('SHA-256 (agregar a API_KEYS_SHA256):');
console.log(`  ${createHash('sha256').update(key).digest('hex')}`);
