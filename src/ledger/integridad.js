/**
 * Compara el documento VIGENTE de una denuncia en el S5 con su última huella sellada.
 * Lo usan la API de verificación y el panel, para que ambos den exactamente la misma respuesta.
 */
import { hashDenuncia } from '../core/hash.js';
import { recordAlert } from './alerts.js';

/**
 * @returns {Promise<{status:number, body:object}>}
 */
export async function checkIntegridad({ id, denunciaId, source, ledger, store, hashOptions, logger, origen }) {
  const doc = await source.findById(id);
  const hashActual = doc ? hashDenuncia(doc, hashOptions) : null;
  const { selladas, pendientes } = await ledger.history(denunciaId);
  const ultima = selladas.at(-1) ?? null;

  if (!ultima) {
    return {
      status: doc ? 202 : 404,
      body: {
        denunciaId,
        integra: null,
        mensaje: doc ? 'La denuncia aún no ha sido sellada' : 'Denuncia inexistente',
        pendientes: pendientes.length,
      },
    };
  }

  const integra = ultima.hashDocumento === hashActual;
  const pendienteCoincide = pendientes.some((p) => p.hashDocumento === hashActual);
  if (!integra && !pendienteCoincide) {
    logger?.warn('ALERTA: documento del S5 no coincide con la cadena', { denunciaId });
    await recordAlert(store, logger, {
      tipo: 'documento_no_coincide',
      clave: `${denunciaId}|${hashActual}|${ultima.entryId}`,
      origen,
      denunciaId,
      bloque: ultima.bloque,
      detalle: {
        hashActual,
        ultimoHashSellado: ultima.hashDocumento,
        versionSellada: ultima.version,
        entryId: ultima.entryId,
        documentoExiste: Boolean(doc),
      },
    });
  }

  return {
    status: 200,
    body: {
      denunciaId,
      integra,
      hashActual,
      ultimoHashSellado: ultima.hashDocumento,
      version: ultima.version,
      bloque: ultima.bloque,
      selladoEn: ultima.selladoEn,
      mensaje: integra
        ? 'El documento vigente coincide con la cadena'
        : pendienteCoincide
          ? 'Cambio reciente registrado, pendiente de sellar'
          : 'El documento vigente NO coincide con la última versión sellada',
    },
  };
}
