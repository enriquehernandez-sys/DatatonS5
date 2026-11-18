/**
 * Autenticación del panel para los niveles privilegiados.
 *
 * Niveles de acceso:
 *   publico        – cualquier persona, sin sesión. Solo información agregada y anonimizada.
 *   contralor      – Contralor interno: acceso completo a la información de las anomalías
 *                    y registro de su seguimiento.
 *   administrador  – lo anterior + bitácora de accesos y estado operativo del servicio.
 *
 * Sesión: cookie HttpOnly + SameSite=Strict con un token firmado (HMAC-SHA256) que expira por
 * inactividad y por duración máxima. En cada petición se vuelve a consultar la cuenta, de modo
 * que desactivarla o cambiarle el rol surte efecto de inmediato.
 */
import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);
export const ROLES = Object.freeze(['contralor', 'administrador']);
export const COOKIE = 'panel_sesion';

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 32;

/** "scrypt$N$r$p$salt$hash" (base64url). */
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12) throw new Error('La contraseña debe tener al menos 12 caracteres');
  const salt = randomBytes(16);
  const dk = await scrypt(password.normalize('NFKC'), salt, KEYLEN, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), dk.toString('base64url')].join('$');
}

// Hash ficticio para gastar el mismo tiempo cuando el usuario no existe (evita enumerar cuentas).
const DUMMY = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export async function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = String(stored ?? DUMMY).split('$');
  if (alg !== 'scrypt' || typeof password !== 'string' || password.length > 1024) return false;
  const expected = Buffer.from(hash, 'base64url');
  const dk = await scrypt(password.normalize('NFKC'), Buffer.from(salt, 'base64url'), expected.length || KEYLEN, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
  });
  return expected.length === dk.length && timingSafeEqual(expected, dk);
}

/** Tokens de sesión firmados: base64url(JSON).firma */
export function createTokens(secret) {
  const sign = (data) => createHmac('sha256', secret).update(data).digest('base64url');
  return {
    issue(payload) {
      const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
      return `${data}.${sign(data)}`;
    },
    read(token) {
      if (typeof token !== 'string' || token.length > 2048) return null;
      const [data, sig] = token.split('.');
      if (!data || !sig) return null;
      const a = Buffer.from(sig);
      const b = Buffer.from(sign(data));
      if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
      try {
        return JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
      } catch {
        return null;
      }
    },
  };
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * Bloqueo por cuenta tras intentos fallidos (complementa el límite por IP).
 * En memoria: suficiente para una instancia; con varias réplicas use el límite del proxy.
 */
export function createLockout({ max = 5, windowMs = 15 * 60_000 } = {}) {
  const fails = new Map();
  return {
    locked(user) {
      const f = fails.get(user);
      if (!f) return false;
      if (Date.now() - f.first > windowMs) {
        fails.delete(user);
        return false;
      }
      return f.n >= max;
    },
    fail(user) {
      const f = fails.get(user);
      if (!f || Date.now() - f.first > windowMs) fails.set(user, { n: 1, first: Date.now() });
      else f.n += 1;
      if (fails.size > 10_000) fails.delete(fails.keys().next().value);
    },
    reset(user) {
      fails.delete(user);
    },
  };
}

export const USUARIO_RE = /^[a-z0-9._-]{3,64}$/;
