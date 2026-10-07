/**
 * Campaña encadenada — Archivo 1 en bloques
 * ============================================
 * Mismo principio que la "campaña de lunes" de cloudrun-impi-fonetico
 * (orquestador.gs de ese proyecto): en vez de un solo ejecutarArchivo1()
 * gigante que arriesga pasarse del límite de ejecución de Apps Script,
 * se parte en bloques chicos encadenados por trigger de una sola vez, cada
 * uno dejando resultados parciales reales en el Sheet.
 *
 * Decisión del usuario (7 oct 2026): bloques de 100 resultados de MARCia /
 * 20 validados por bloque. Con ese tamaño, el peor caso de un bloque (los
 * 100 candidatos nuevos necesitan el respaldo lento de MARCANET, ~4s cada
 * uno) es de ~7 minutos — muy por debajo del límite de 30 min de
 * ejecución (cuenta Workspace), así que a diferencia de la campaña de
 * lunes del otro proyecto, AQUÍ NO hace falta un chequeo de tiempo a
 * mitad de bloque — el tamaño del bloque ya es la salvaguarda.
 *
 * Reanudación: en vez de guardar un índice/cursor, cada bloque relee
 * Validados_Jalisco + Sin_CP del Sheet para saber qué titulares ya se
 * procesaron (ver obtenerTitularesYaRegistrados_() en orquestador.gs) —
 * así la campaña es resumible sin importar cuántos bloques lleve, y
 * correr un bloque dos veces por error no genera filas duplicadas.
 */

const ARCHIVO1_TAMANO_BLOQUE_MARCIA = 100;
const ARCHIVO1_OBJETIVO_POR_BLOQUE = 20;
const ARCHIVO1_TRIGGER_HANDLER = 'ejecutarBloqueArchivo1_';
const ARCHIVO1_ESPERA_ENTRE_BLOQUES_MS = 60 * 1000; // 1 minuto de colchón entre bloques.

/**
 * Arranca (o reinicia) la campaña encadenada.
 * @param {Object} [opciones]
 * @param {Array<string>} [opciones.clases] Default ['37'].
 * @param {string} [opciones.fechaDesde] 'YYYY-MM-DD', default hoy-10 años.
 * @param {string} [opciones.fechaHasta] 'YYYY-MM-DD', default hoy-5 años.
 * @param {number} [opciones.maxMarciaTotal] Default 1000.
 * @param {number} [opciones.objetivoTotal] Default 100.
 */
function iniciarArchivo1Encadenado(opciones) {
  opciones = opciones || {};
  const props = PropertiesService.getScriptProperties();
  props.setProperty('ARCHIVO1_CLASES', JSON.stringify(opciones.clases || ['37']));
  props.setProperty('ARCHIVO1_FECHA_DESDE', opciones.fechaDesde || '');
  props.setProperty('ARCHIVO1_FECHA_HASTA', opciones.fechaHasta || '');
  props.setProperty('ARCHIVO1_MAX_MARCIA_TOTAL', String(opciones.maxMarciaTotal || 1000));
  props.setProperty('ARCHIVO1_OBJETIVO_TOTAL', String(opciones.objetivoTotal || 100));
  props.setProperty('ARCHIVO1_BLOQUE_ACTUAL', '1');

  limpiarTriggersArchivo1_();
  Logger.log('Campaña encadenada iniciada — corriendo el bloque 1 ahora mismo.');
  ejecutarBloqueArchivo1_();
}

/** Corre un bloque; si hace falta otro, se programa solo vía trigger. No
 *  llamar manualmente salvo para depurar — usar iniciarArchivo1Encadenado(). */
function ejecutarBloqueArchivo1_() {
  const props = PropertiesService.getScriptProperties();
  const clases = JSON.parse(props.getProperty('ARCHIVO1_CLASES') || '["37"]');
  const fechaDesde = props.getProperty('ARCHIVO1_FECHA_DESDE') || undefined;
  const fechaHasta = props.getProperty('ARCHIVO1_FECHA_HASTA') || undefined;
  const maxMarciaTotal = parseInt(props.getProperty('ARCHIVO1_MAX_MARCIA_TOTAL') || '1000', 10);
  const objetivoTotal = parseInt(props.getProperty('ARCHIVO1_OBJETIVO_TOTAL') || '100', 10);
  const bloqueActual = parseInt(props.getProperty('ARCHIVO1_BLOQUE_ACTUAL') || '1', 10);

  const validadosAntes = contarValidadosJalisco_();
  const objetivoEsteBloque = Math.min(validadosAntes + ARCHIVO1_OBJETIVO_POR_BLOQUE, objetivoTotal);
  const maxMarciaEsteBloque = Math.min(bloqueActual * ARCHIVO1_TAMANO_BLOQUE_MARCIA, maxMarciaTotal);

  Logger.log(
    '--- Bloque %s: hasta %s resultados de MARCia (tope total %s), objetivo %s validados (acumulado hoy: %s) ---',
    bloqueActual, maxMarciaEsteBloque, maxMarciaTotal, objetivoEsteBloque, validadosAntes
  );

  const resumen = ejecutarArchivo1({
    clases: clases,
    fechaDesde: fechaDesde,
    fechaHasta: fechaHasta,
    maxResultadosMarcia: maxMarciaEsteBloque,
    objetivoJalisco: objetivoEsteBloque,
  });

  const validadosDespues = contarValidadosJalisco_();
  Logger.log(
    'Bloque %s terminado: %s nuevos validados en este bloque (acumulado: %s/%s).',
    bloqueActual, validadosDespues - validadosAntes, validadosDespues, objetivoTotal
  );

  const alcanzoObjetivoTotal = validadosDespues >= objetivoTotal;
  const agotoMarcia = maxMarciaEsteBloque >= maxMarciaTotal;

  if (alcanzoObjetivoTotal || agotoMarcia) {
    Logger.log(
      'Campaña terminada — motivo: %s.',
      alcanzoObjetivoTotal ? ('objetivo de ' + objetivoTotal + ' validados alcanzado') : ('se llegó al tope de ' + maxMarciaTotal + ' resultados de MARCia')
    );
    limpiarTriggersArchivo1_();
    props.deleteProperty('ARCHIVO1_BLOQUE_ACTUAL');
    return;
  }

  props.setProperty('ARCHIVO1_BLOQUE_ACTUAL', String(bloqueActual + 1));
  ScriptApp.newTrigger(ARCHIVO1_TRIGGER_HANDLER).timeBased().after(ARCHIVO1_ESPERA_ENTRE_BLOQUES_MS).create();
  Logger.log('Bloque %s programado en ~1 minuto.', bloqueActual + 1);
}

function limpiarTriggersArchivo1_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === ARCHIVO1_TRIGGER_HANDLER) {
      ScriptApp.deleteTrigger(t);
    }
  });
}

/** Correr a mano desde el editor para parar la campaña a medio camino —
 *  lo ya validado en el Sheet se queda, solo se cancela lo que faltaba. */
function detenerArchivo1Encadenado() {
  limpiarTriggersArchivo1_();
  PropertiesService.getScriptProperties().deleteProperty('ARCHIVO1_BLOQUE_ACTUAL');
  Logger.log('Campaña encadenada detenida a mano. Progreso ya guardado en el Sheet, sin cambios.');
}

/** Corrida intermedia que pidió el usuario — 100 de MARCia, objetivo 20,
 *  UN SOLO bloque (sin encadenar) para medir el ritmo real antes de la
 *  campaña completa. */
function test_archivo1PruebaIntermedia() {
  const resumen = ejecutarArchivo1({ clases: ['37'], maxResultadosMarcia: 100, objetivoJalisco: 20 });
  Logger.log('Resumen prueba intermedia: %s', JSON.stringify(resumen, null, 2));
}
