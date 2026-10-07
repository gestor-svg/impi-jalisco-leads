/**
 * Módulo Sheets — Archivo 1 (lista validada)
 * =============================================
 * A diferencia de cloudrun-impi-fonetico, este proyecto NO necesita cola,
 * candados de fila, ni flujo operativo — es solo generar una lista (ver
 * conversación del 6-7 oct 2026: "no necesito que haya candados de fila o
 * procesamiento, es generar la lista"). Dos pestañas únicamente:
 *
 *   - Validados_Jalisco: empresas que pasaron el filtro completo (clase de
 *     Niza + antigüedad 5-10 años + persona moral + confirmación de Jalisco
 *     por DENUE o por CP de MARCANET).
 *   - Sin_CP: empresas que pasaron todos los demás filtros pero donde
 *     MARCANET no trajo código postal del titular (vacío o mal formado) Y
 *     tampoco hubo match en DENUE — se archivan para revisión manual en vez
 *     de perderse (decisión del 6 oct 2026).
 */

const SHEETS_NOMBRE_WORKBOOK = 'IMPI Jalisco Leads — Maestro';

const SHEETS_PESTANAS = {
  VALIDADOS_JALISCO: 'Validados_Jalisco',
  SIN_CP: 'Sin_CP',
};

// Nota sobre fechas: MARCia regresa "fecha de presentación" (siempre
// disponible, de la lista de resultados) pero NO la fecha de concesión en
// esa misma llamada — esa solo se consigue abriendo el detalle en MARCANET.
// Como MARCANET solo se visita cuando DENUE no confirmó Jalisco (regla del
// 6 oct 2026, para no gastar tiempo de más), fecha_concesion queda vacía en
// las filas confirmadas por DENUE — antiguedad_anios se calcula de
// fecha_concesion cuando existe, si no de fecha_presentacion (columna
// fuente_fecha_antiguedad indica cuál se usó).
const ENCABEZADOS = {};
ENCABEZADOS[SHEETS_PESTANAS.VALIDADOS_JALISCO] = [
  'denominacion', 'titular', 'expediente', 'registro', 'clase_niza',
  'fecha_presentacion', 'fecha_concesion', 'antiguedad_anios', 'fuente_fecha_antiguedad',
  'fuente_confirmacion_jalisco', 'codigo_postal', 'poblacion',
  'denue_razon_social_match', 'denue_municipio', 'denue_cp', 'fecha_procesado',
];
ENCABEZADOS[SHEETS_PESTANAS.SIN_CP] = [
  'denominacion', 'titular', 'expediente', 'registro', 'clase_niza',
  'fecha_presentacion', 'motivo', 'fecha_procesado',
];

// ---------------------------------------------------------------------------
// Workbook
// ---------------------------------------------------------------------------

function inicializarWorkbook() {
  const props = PropertiesService.getScriptProperties();
  let spreadsheetId = props.getProperty('WORKBOOK_ID');

  let ss;
  if (spreadsheetId) {
    try {
      ss = SpreadsheetApp.openById(spreadsheetId);
      Logger.log('Workbook existente reutilizado: %s', ss.getUrl());
    } catch (e) {
      Logger.log('WORKBOOK_ID guardado ya no es válido, se crea uno nuevo.');
      spreadsheetId = null;
    }
  }

  if (!spreadsheetId) {
    ss = SpreadsheetApp.create(SHEETS_NOMBRE_WORKBOOK);
    props.setProperty('WORKBOOK_ID', ss.getId());
    Logger.log('Workbook nuevo creado: %s', ss.getUrl());
  }

  Object.keys(ENCABEZADOS).forEach(function (nombrePestana) {
    let hoja = ss.getSheetByName(nombrePestana);
    if (!hoja) {
      hoja = ss.insertSheet(nombrePestana);
      Logger.log('Pestaña creada: %s', nombrePestana);
    }
    const encabezados = ENCABEZADOS[nombrePestana];
    const rango = hoja.getRange(1, 1, 1, encabezados.length);
    rango.setValues([encabezados]);
    hoja.setFrozenRows(1);
    rango.setFontWeight('bold');

    // codigo_postal y denue_cp como texto plano — mismo bug ya conocido del
    // otro proyecto con el "+" de teléfonos, aquí por los ceros a la
    // izquierda de algunos CP (ej. "01210" se podría leer como número y
    // perder el cero inicial).
    ['codigo_postal', 'denue_cp'].forEach(function (nombreCol) {
      const idx = encabezados.indexOf(nombreCol);
      if (idx !== -1) {
        hoja.getRange(2, idx + 1, Math.max(hoja.getMaxRows() - 1, 1), 1).setNumberFormat('@');
      }
    });
  });

  const hojaDefault = ss.getSheetByName('Hoja 1') || ss.getSheetByName('Sheet1');
  if (hojaDefault && hojaDefault.getLastRow() === 0) {
    ss.deleteSheet(hojaDefault);
  }

  Logger.log('Workbook listo: %s', ss.getUrl());
  return ss.getId();
}

function obtenerWorkbook_() {
  const spreadsheetId = PropertiesService.getScriptProperties().getProperty('WORKBOOK_ID');
  if (!spreadsheetId) {
    throw new Error('Workbook no inicializado — correr inicializarWorkbook() primero.');
  }
  return SpreadsheetApp.openById(spreadsheetId);
}

function obtenerPestana_(nombrePestana) {
  const hoja = obtenerWorkbook_().getSheetByName(nombrePestana);
  if (!hoja) throw new Error('Pestaña no encontrada: ' + nombrePestana);
  return hoja;
}

// ---------------------------------------------------------------------------
// Escritura de filas
// ---------------------------------------------------------------------------

/** Escribe una fila en Validados_Jalisco a partir de un objeto con las
 *  mismas claves que ENCABEZADOS[VALIDADOS_JALISCO] (las que falten
 *  quedan vacías). */
function agregarFilaValidada_(datos) {
  const hoja = obtenerPestana_(SHEETS_PESTANAS.VALIDADOS_JALISCO);
  const encabezados = ENCABEZADOS[SHEETS_PESTANAS.VALIDADOS_JALISCO];
  const fila = encabezados.map(function (col) { return datos[col] != null ? datos[col] : ''; });
  hoja.appendRow(fila);
}

/** Escribe una fila en Sin_CP. */
function agregarFilaSinCP_(datos) {
  const hoja = obtenerPestana_(SHEETS_PESTANAS.SIN_CP);
  const encabezados = ENCABEZADOS[SHEETS_PESTANAS.SIN_CP];
  const fila = encabezados.map(function (col) { return datos[col] != null ? datos[col] : ''; });
  hoja.appendRow(fila);
}

/** Cuenta cuántas filas de datos tiene ya Validados_Jalisco (sin contar el
 *  encabezado) — usado por el orquestador para saber cuándo llegó a 100. */
function contarValidadosJalisco_() {
  const hoja = obtenerPestana_(SHEETS_PESTANAS.VALIDADOS_JALISCO);
  return Math.max(hoja.getLastRow() - 1, 0);
}

/**
 * Lee la columna "titular" de Validados_Jalisco + Sin_CP y regresa un set
 * (normalizado, mismo normalizarNombreEmpresa_ que el resto del matching)
 * de los titulares que YA se procesaron en corridas anteriores — permite
 * que la campaña encadenada (campana.gs) sea resumible sin releer un
 * índice/cursor aparte: la fuente de verdad de "qué ya se hizo" es el
 * propio Sheet, no un contador en Script Properties que se podría
 * desincronizar.
 */
function obtenerTitularesYaRegistrados_() {
  const set = {};
  [SHEETS_PESTANAS.VALIDADOS_JALISCO, SHEETS_PESTANAS.SIN_CP].forEach(function (nombrePestana) {
    const hoja = obtenerPestana_(nombrePestana);
    const idxTitular = ENCABEZADOS[nombrePestana].indexOf('titular');
    const ultimaFila = hoja.getLastRow();
    if (ultimaFila < 2) return; // solo encabezado, sin datos.
    const valores = hoja.getRange(2, idxTitular + 1, ultimaFila - 1, 1).getValues();
    valores.forEach(function (fila) {
      const titular = String(fila[0] || '').trim();
      if (titular) set[normalizarNombreEmpresa_(titular)] = true;
    });
  });
  return set;
}
