/**
 * Anomalías de integridad ("alertas").
 *
 * Cada alerta se guarda UNA vez en la colección `alertas` (solo inserción) y su atención
 * se registra como una secuencia de eventos en `alertas_seguimiento` (también solo inserción).
 *
 * Protección de datos:
 *  - El folio (_id) es ALEATORIO: no puede derivarse del número de una denuncia, así que
 *    publicar la lista de alertas no permite confirmar si una denuncia concreta fue alterada.
 *  - La deduplicación usa `clave` (SHA-256 de tipo + datos), que nunca sale del nivel privilegiado.
 *  - `resumenPublico` es un texto genérico por tipo; jamás incluye identificadores ni huellas.
 */
import { randomBytes } from 'node:crypto';
import { sha256Hex } from '../core/hash.js';

export const SEVERIDADES = Object.freeze(['critica', 'alta', 'media', 'baja']);
export const ESTADOS_ALERTA = Object.freeze(['abierta', 'en_revision', 'atendida', 'falso_positivo']);

export const TIPOS_ALERTA = Object.freeze({
  cadena_invalida: {
    severidad: 'critica',
    titulo: 'Inconsistencia en la cadena',
    resumenPublico: 'La verificación criptográfica detectó bloques cuyo contenido, firma o enlace no corresponde con lo sellado.',
    alcance: 'cadena',
  },
  coleccion_invalidada: {
    severidad: 'critica',
    titulo: 'Colección del S5 eliminada o invalidada',
    resumenPublico: 'La colección de denuncias del sistema de origen fue eliminada o invalidada; se ejecutó una conciliación completa.',
    alcance: 'sistema',
  },
  cambio_por_conciliacion: {
    severidad: 'alta',
    titulo: 'Cambio no reportado por el flujo de eventos',
    resumenPublico: 'Se detectó un cambio en una denuncia que no llegó por el canal normal de eventos (posible modificación directa en la base de datos).',
    alcance: 'denuncia',
  },
  documento_no_coincide: {
    severidad: 'alta',
    titulo: 'Documento vigente distinto al sellado',
    resumenPublico: 'El contenido vigente de una denuncia no coincide con su última huella sellada ni con un cambio pendiente de sellar.',
    alcance: 'denuncia',
  },
  historial_perdido: {
    severidad: 'media',
    titulo: 'Hueco en el flujo de cambios',
    resumenPublico: 'Se perdió el punto de reanudación del flujo de cambios del sistema de origen; se ejecutó una conciliación completa.',
    alcance: 'sistema',
  },
});

const HEX16 = /^[0-9a-f]{16}$/;
export const isAlertId = (v) => typeof v === 'string' && HEX16.test(v);
export const folioDe = (id) => `AL-${id.slice(0, 4)}-${id.slice(4, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}`.toUpperCase();
export function parseFolio(raw) {
  if (typeof raw !== 'string') return null;
  const id = raw.replace(/^AL-/i, '').replaceAll('-', '').toLowerCase();
  return isAlertId(id) ? id : null;
}

/**
 * Construye una alerta.
 * @param {object} a
 * @param {keyof TIPOS_ALERTA} a.tipo
 * @param {string} a.clave        datos que hacen única a la alerta (se guardan solo como hash)
 * @param {'worker'|'api'|'panel'} a.origen
 * @param {string|null} [a.denunciaId]
 * @param {number|null} [a.bloque]
 * @param {object} [a.detalle]    información técnica (solo nivel privilegiado)
 */
export function makeAlert({ tipo, clave, origen, denunciaId = null, bloque = null, detalle = {}, detectadaEn = new Date() }) {
  const def = TIPOS_ALERTA[tipo];
  if (!def) throw new Error(`Tipo de alerta desconocido: ${tipo}`);
  return {
    _id: randomBytes(8).toString('hex'),
    clave: sha256Hex(`${tipo}|${clave}`),
    tipo,
    severidad: def.severidad,
    origen,
    detectadaEn,
    denunciaId,
    bloque,
    detalle,
  };
}

/**
 * Registra una alerta sin interrumpir nunca el flujo principal.
 * Devuelve la alerta insertada, o null si ya existía (misma clave) o si no se pudo guardar.
 */
export async function recordAlert(store, logger, fields) {
  try {
    const alerta = makeAlert(fields);
    const nueva = await store.insertAlert(alerta);
    if (nueva) logger?.warn('Alerta registrada', { folio: folioDe(alerta._id), tipo: alerta.tipo, severidad: alerta.severidad });
    return nueva ? alerta : null;
  } catch (e) {
    logger?.error('No se pudo registrar la alerta', { tipo: fields?.tipo, error: e.message });
    return null;
  }
}

/** Primer índice de bloque mencionado en los errores de verifyChain ("Bloque N: ..."). */
export function primerBloqueConError(errores) {
  for (const e of errores) {
    const m = /^Bloque (\d+):/.exec(e);
    if (m) return Number(m[1]);
  }
  return null;
}

/** Estado vigente de una alerta a partir de su seguimiento (orden cronológico). */
export function estadoActual(seguimiento) {
  return seguimiento.at(-1)?.estado ?? 'abierta';
}

const soloFecha = (d) => new Date(d).toISOString().slice(0, 10);

/**
 * Vista PÚBLICA de una alerta: sin número de denuncia, sin huellas, sin notas ni usuarios,
 * y con la fecha reducida al día para dificultar correlaciones con hechos externos.
 */
export function vistaPublica(alerta, seguimiento = []) {
  const def = TIPOS_ALERTA[alerta.tipo] ?? {};
  return {
    folio: folioDe(alerta._id),
    tipo: alerta.tipo,
    titulo: def.titulo ?? alerta.tipo,
    severidad: alerta.severidad,
    alcance: def.alcance ?? 'sistema',
    resumen: def.resumenPublico ?? '',
    detectadaEl: soloFecha(alerta.detectadaEn),
    // El índice de bloque no es dato personal; solo se muestra en anomalías de la cadena.
    bloque: def.alcance === 'cadena' ? alerta.bloque : null,
    estado: estadoActual(seguimiento),
    cronologia: seguimiento.map((s) => ({ estado: s.estado, fecha: soloFecha(s.en) })),
  };
}

/** Vista COMPLETA (contralor interno / administrador). */
export function vistaCompleta(alerta, seguimiento = []) {
  return {
    ...vistaPublica(alerta, seguimiento),
    id: alerta._id,
    detectadaEn: new Date(alerta.detectadaEn).toISOString(),
    origen: alerta.origen,
    denunciaId: alerta.denunciaId,
    bloque: alerta.bloque,
    detalle: alerta.detalle,
    cronologia: seguimiento.map((s) => ({
      estado: s.estado, nota: s.nota, usuario: s.usuario, rol: s.rol, en: new Date(s.en).toISOString(),
    })),
  };
}
