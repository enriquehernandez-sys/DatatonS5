/** Controles de acceso de la API de verificación. */
import { createHash, timingSafeEqual } from 'node:crypto';

/** Autenticación por llave de API. En la configuración solo se guarda el SHA-256 de cada llave. */
export function apiKeyAuth(allowedHashesHex) {
  const allowed = allowedHashesHex.map((h) => Buffer.from(h.toLowerCase(), 'hex')).filter((b) => b.length === 32);
  if (allowed.length === 0) throw new Error('Configure al menos una llave en API_KEYS_SHA256');
  return (req, res, next) => {
    const key = req.get('x-api-key');
    if (typeof key === 'string' && key.length >= 32 && key.length <= 256) {
      const digest = createHash('sha256').update(key).digest();
      // Se comparan todas para no revelar por tiempo cuál coincidió.
      let ok = false;
      for (const h of allowed) ok = timingSafeEqual(digest, h) || ok;
      if (ok) {
        req.apiKeyId = digest.toString('hex').slice(0, 16); // identifica al consumidor sin exponer la llave
        return next();
      }
    }
    res.status(401).json({ error: 'No autorizado' });
  };
}

/** Lista blanca de IPs (red interna de la PDN / servidores autorizados). */
export function ipAllowlist(ips) {
  if (ips.length === 0) return (_req, _res, next) => next();
  const set = new Set(ips.flatMap((ip) => [ip, `::ffff:${ip}`]));
  return (req, res, next) => (set.has(req.ip) ? next() : res.status(403).json({ error: 'Origen no permitido' }));
}
