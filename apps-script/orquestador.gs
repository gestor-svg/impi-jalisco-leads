/**
 * Orquestador — Archivo 1 (lista validada de Jalisco)
 * ======================================================
 * Encadena: DENUE (Jalisco + estrato 4-5, descarga única) -> MARCia
 * (Clase de Niza + Registrado + fecha de registro 5-10 años, hasta N) ->
 * por cada titular único y persona moral: match contra DENUE primero
 * (rápido, gratis, en memoria); si no hay match, fallback a MARCANET "por
 * registro" (Cloud Run) para leer el CP del titular. Se detiene al juntar
 * el objetivo de validados en Jalisco o al agotar los resultados de MARCia
 * — lo que pase primero (decisión del 6 oct 2026).
 *
 * Sin candados de fila, sin cola, sin flujo operativo — es solo generar la
 * lista (a diferencia de cloudrun-impi-fonetico).
 */

const ORQ_DELAY_MARCANET_MS = 3000; // MARCANET degrada con peticiones rápidas consecutivas — mismo hallazgo que impi.gs del otro proyecto.

/**
 * @param {Object} [opciones]
 * @param {Array<string>} [opciones.clases] Clases de Niza — default ['37'] (construcción).
 * @param {string} [opciones.fechaDesde] 'YYYY-MM-DD' — default hoy-10 años.
 * @param {string} [opciones.fechaHasta] 'YYYY-MM-DD' — default hoy-5 años.
 * @param {number} [opciones.maxResultadosMarcia] Default 1000.
 * @param {number} [opciones.objetivoJalisco] Default 100.
 * @returns {Object} Resumen de la corrida.
 */
function ejecutarArchivo1(opciones) {
  opciones = opciones || {};
  const clases = opciones.clases || ['37'];
  const hoy = new Date();
  const fechaHasta = opciones.fechaHasta || formatearFechaISO_(sumarAnios_(hoy, -5));
  const fechaDesde = opciones.fechaDesde || formatearFechaISO_(sumarAnios_(hoy, -10));
  const maxResultadosMarcia = opciones.maxResultadosMarcia || 1000;
  const objetivoJalisco = opciones.objetivoJalisco || 100;

  inicializarWorkbook();

  Logger.log('Paso 1/3: descargando DENUE Jalisco estrato 4-5 (sin filtro de giro)...');
  const registrosDenue = buscarDenue({ entidad: 'Jalisco', estrato: [4, 5], maxResultados: 50000 });
  Logger.log('DENUE: %s establecimientos.', registrosDenue.length);
  const indiceDenue = construirIndiceDenue_(registrosDenue);
  const setCPsJalisco = construirSetCPsJalisco_(registrosDenue);

  Logger.log('Paso 2/3: buscando en MARCia (clases=%s, %s a %s)...', clases.join(','), fechaDesde, fechaHasta);
  const resultadoMarcia = buscarMarcia({
    clases: clases,
    estatus: ['REGISTRADO'],
    fechaTipo: 'DATE_REGISTRATION',
    fechaDesde: fechaDesde,
    fechaHasta: fechaHasta,
    maxResultados: maxResultadosMarcia,
  });
  Logger.log('MARCia: %s disponibles en total, %s traídos para este lote.', resultadoMarcia.totalDisponibles, resultadoMarcia.resultados.length);

  Logger.log('Paso 3/3: procesando candidatos (objetivo: %s validados en Jalisco)...', objetivoJalisco);
  const resumen = {
    totalDisponiblesMarcia: resultadoMarcia.totalDisponibles,
    totalTraidosMarcia: resultadoMarcia.resultados.length,
    procesados: 0,
    descartadosSinTitular: 0,
    descartadosNoPersonaMoral: 0,
    descartadosDuplicadoTitular: 0,
    validadosPorDenue: 0,
    validadosPorMarcanet: 0,
    descartadosNoJalisco: 0,
    archivadosSinCP: 0,
    erroresMarcanet: 0,
    detenidoPorObjetivo: false,
  };

  const titularesVistos = {};
  let validados = contarValidadosJalisco_();

  for (let i = 0; i < resultadoMarcia.resultados.length; i++) {
    if (validados >= objetivoJalisco) {
      Logger.log('Objetivo de %s alcanzado en Validados_Jalisco, deteniendo.', objetivoJalisco);
      resumen.detenidoPorObjetivo = true;
      break;
    }

    const resultado = resultadoMarcia.resultados[i];
    resumen.procesados++;

    const titular = ((resultado.owners && resultado.owners[0]) || '').trim();
    if (!titular) {
      resumen.descartadosSinTitular++;
      continue;
    }

    if (!esPersonaMoral_(titular)) {
      resumen.descartadosNoPersonaMoral++;
      continue;
    }

    const claveTitular = normalizarNombreEmpresa_(titular);
    if (titularesVistos[claveTitular]) {
      resumen.descartadosDuplicadoTitular++;
      continue;
    }
    titularesVistos[claveTitular] = true;

    const base = {
      denominacion: resultado.title,
      titular: titular,
      expediente: resultado.applicationNumber,
      registro: resultado.registrationNumber,
      clase_niza: (resultado.classes && resultado.classes.length ? resultado.classes.join(',') : clases.join(',')),
      fecha_presentacion: (resultado.dates && resultado.dates.application) || '',
      fecha_procesado: formatearFechaISO_(new Date()),
    };

    // --- Intento 1: match contra DENUE (rápido, en memoria) ---
    const matchDenue = buscarMatchTitularEnDenue_(titular, indiceDenue);
    if (matchDenue) {
      agregarFilaValidada_(Object.assign({}, base, {
        fecha_concesion: '',
        antiguedad_anios: calcularAntiguedadAnios_(base.fecha_presentacion),
        fuente_fecha_antiguedad: 'fecha_presentacion (MARCia) — no se consultó MARCANET, DENUE ya confirmó Jalisco',
        fuente_confirmacion_jalisco: 'DENUE',
        codigo_postal: matchDenue.CP || '',
        poblacion: matchDenue.Municipio || '',
        denue_razon_social_match: matchDenue.Razon_social || '',
        denue_municipio: matchDenue.Municipio || '',
        denue_cp: matchDenue.CP || '',
      }));
      resumen.validadosPorDenue++;
      validados++;
      continue;
    }

    // --- Intento 2 (fallback): MARCANET "por registro" vía Cloud Run ---
    Utilities.sleep(ORQ_DELAY_MARCANET_MS);
    let resultadoCP;
    try {
      resultadoCP = llamarCpTitular_(base.registro, base.expediente);
    } catch (e) {
      Logger.log('Error MARCANET para "%s" (registro %s): %s', titular, base.registro, e.message);
      resumen.erroresMarcanet++;
      continue; // error técnico, no "sin CP" — no se archiva, se puede reintentar en otra corrida.
    }

    if (!resultadoCP.encontrado || !resultadoCP.codigo_postal) {
      agregarFilaSinCP_(Object.assign({}, base, {
        motivo: resultadoCP.error || 'CP vacío o mal formado en MARCANET, sin match en DENUE.',
      }));
      resumen.archivadosSinCP++;
      continue;
    }

    if (!esCpDeJalisco_(resultadoCP.codigo_postal, setCPsJalisco)) {
      resumen.descartadosNoJalisco++;
      continue;
    }

    const fechaAntiguedad = resultadoCP.fecha_concesion || base.fecha_presentacion;
    agregarFilaValidada_(Object.assign({}, base, {
      fecha_concesion: resultadoCP.fecha_concesion || '',
      antiguedad_anios: calcularAntiguedadAnios_(fechaAntiguedad),
      fuente_fecha_antiguedad: resultadoCP.fecha_concesion ? 'fecha_concesion (MARCANET)' : 'fecha_presentacion (MARCia)',
      fuente_confirmacion_jalisco: 'MARCANET (CP del titular)',
      codigo_postal: resultadoCP.codigo_postal,
      poblacion: resultadoCP.poblacion || '',
      denue_razon_social_match: '',
      denue_municipio: '',
      denue_cp: '',
    }));
    resumen.validadosPorMarcanet++;
    validados++;
  }

  Logger.log('Resumen final: %s', JSON.stringify(resumen, null, 2));
  return resumen;
}

// ---------------------------------------------------------------------------
// Utilidades de fecha
// ---------------------------------------------------------------------------

function sumarAnios_(fecha, anios) {
  const nueva = new Date(fecha.getTime());
  nueva.setFullYear(nueva.getFullYear() + anios);
  return nueva;
}

function formatearFechaISO_(fecha) {
  return Utilities.formatDate(fecha, 'America/Mexico_City', 'yyyy-MM-dd');
}

/** Parsea fechas en formato DD/MM/YYYY (como las regresa tanto MARCia como
 *  MARCANET) — puede traer hora pegada (ej. "25/11/2015 01:11:43 PM"), solo
 *  se usa la parte de fecha. */
function parsearFechaDDMMYYYY_(texto) {
  if (!texto) return null;
  const soloFecha = String(texto).trim().split(' ')[0];
  const partes = soloFecha.split('/');
  if (partes.length !== 3) return null;
  const dia = parseInt(partes[0], 10);
  const mes = parseInt(partes[1], 10) - 1;
  const anio = parseInt(partes[2], 10);
  if (isNaN(dia) || isNaN(mes) || isNaN(anio)) return null;
  return new Date(anio, mes, dia);
}

function calcularAntiguedadAnios_(fechaTexto) {
  const fecha = parsearFechaDDMMYYYY_(fechaTexto);
  if (!fecha) return '';
  const milisegundosPorAnio = 365.25 * 24 * 60 * 60 * 1000;
  const anios = (Date.now() - fecha.getTime()) / milisegundosPorAnio;
  return Math.round(anios * 10) / 10; // 1 decimal.
}

// ---------------------------------------------------------------------------
// Pruebas
// ---------------------------------------------------------------------------

function test_calcularAntiguedadAnios() {
  const resultado = calcularAntiguedadAnios_('04/04/2017');
  Logger.log('Antigüedad de 04/04/2017: %s años', resultado);
  if (resultado < 8 || resultado > 10) throw new Error('Antigüedad fuera de rango esperado: ' + resultado);
}

/** Corrida chica de prueba — 10 resultados de MARCia máximo, objetivo de
 *  3 validados, para no gastar tiempo/llamadas de más en la primera prueba
 *  end-to-end. Subir a maxResultadosMarcia:1000, objetivoJalisco:100 una
 *  vez confirmado que el flujo completo funciona. */
function test_ejecutarArchivo1Piloto() {
  const resumen = ejecutarArchivo1({ clases: ['37'], maxResultadosMarcia: 10, objetivoJalisco: 3 });
  Logger.log(JSON.stringify(resumen, null, 2));
}
