/**
 * Módulo MARCia — Apps Script
 * ============================
 * Cliente del API interna (no documentada) de https://marcia.impi.gob.mx —
 * la plataforma nueva de búsqueda de marcas del IMPI (distinta de MARCANET/
 * acervomarcas, que usa el otro proyecto `cloudrun-impi-fonetico`).
 *
 * A diferencia de MARCANET (JSF/PrimeFaces con ViewState, requiere Cloud Run
 * con Python+BeautifulSoup), MARCia es una SPA moderna respaldada por un API
 * JSON — reverse-engineered en vivo el 6-7 oct 2026 interceptando las
 * llamadas XHR reales del navegador (window.XMLHttpRequest, NO window.fetch
 * — el frontend de MARCia usa XHR, no fetch, hallazgo que costó una ronda
 * de intentos fallidos con el interceptor equivocado). Confirmado con curl
 * plano (sin navegador) que basta con:
 *
 *   1. GET /marcas/search/quick — establece sesión (cookies XSRF-TOKEN,
 *      SESSIONTOKEN [JWT, ~8h de vida], JSESSIONID). Sin login, es acceso
 *      público — MARCia no requiere autenticación de usuario para buscar.
 *   2. POST /marcas/search/internal/record — con el header X-XSRF-TOKEN
 *      (valor de la cookie homónima) y el payload de búsqueda estructurada
 *      (ver construirQueryMarcia_) — regresa { id, contextId, count, query }.
 *      El campo "id" es el searchId para los siguientes pasos.
 *   3. POST /marcas/search/internal/result — con { searchId, pageSize,
 *      pageNumber, statusFilter:[], viennaCodeFilter:[], niceClassFilter:[] }
 *      — regresa resultPage[] (hasta 100 por página, tope real de 10,000
 *      resultados totales por búsqueda, confirmado en la UI real).
 *
 * IMPORTANTE — primer intento fallido documentado para no repetirlo: el
 * payload NO lleva un wrapper extra `{"query": {...}}` — es directamente
 * `{"_type": "Search$Structured", "query": {...campos...}, "images": []}`
 * en el nivel superior. Un payload con un nivel de anidación de más regresa
 * HTTP 500 sin cuerpo de error (nada útil que depurar desde la respuesta).
 *
 * Riesgo aceptado: es un API interna sin documentación pública ni SLA —
 * puede cambiar sin aviso. Igual que con MARCANET, el pipeline debe tratar
 * cualquier error de MARCia como recuperable (reintentar, no tronar todo el
 * lote) y no asumir que el contrato es estable para siempre.
 */

// ---------------------------------------------------------------------------
// Sesión
// ---------------------------------------------------------------------------

const MARCIA_BASE_URL = 'https://marcia.impi.gob.mx';
const MARCIA_TAMANO_PAGINA = 100;
const MARCIA_MAX_RESULTADOS_API = 10000; // tope real observado en la UI de MARCia.

/**
 * Establece una sesión nueva contra MARCia (cookies + token CSRF). Se llama
 * una vez por corrida de búsqueda — la sesión dura ~8h (vida del JWT
 * SESSIONTOKEN), de sobra para paginar hasta 10,000 resultados (100
 * llamadas) dentro de una sola ejecución de Apps Script.
 */
function marciaIniciarSesion_() {
  const respuesta = UrlFetchApp.fetch(MARCIA_BASE_URL + '/marcas/search/quick', {
    muteHttpExceptions: true,
  });
  if (respuesta.getResponseCode() !== 200) {
    throw new Error('No se pudo abrir MARCia para iniciar sesión: HTTP ' + respuesta.getResponseCode());
  }

  const headers = respuesta.getAllHeaders();
  let setCookie = headers['Set-Cookie'] || headers['set-cookie'] || [];
  if (!Array.isArray(setCookie)) setCookie = [setCookie];

  const cookies = {};
  setCookie.forEach(function (linea) {
    const match = /^([^=]+)=([^;]*)/.exec(linea);
    if (match) cookies[match[1].trim()] = match[2];
  });

  if (!cookies['XSRF-TOKEN']) {
    throw new Error('MARCia no regresó cookie XSRF-TOKEN — ¿cambió el mecanismo de sesión?');
  }

  return {
    xsrfToken: cookies['XSRF-TOKEN'],
    cookieHeader: Object.keys(cookies)
      .map(function (nombre) { return nombre + '=' + cookies[nombre]; })
      .join('; '),
  };
}

/** POST autenticado con la sesión ya establecida. */
function marciaPost_(sesion, ruta, payload) {
  const respuesta = UrlFetchApp.fetch(MARCIA_BASE_URL + ruta, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'X-XSRF-TOKEN': sesion.xsrfToken,
      'Cookie': sesion.cookieHeader,
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const codigo = respuesta.getResponseCode();
  if (codigo !== 200) {
    throw new Error('MARCia HTTP ' + codigo + ' en ' + ruta + ': ' + respuesta.getContentText().substring(0, 300));
  }

  try {
    return JSON.parse(respuesta.getContentText());
  } catch (e) {
    throw new Error('Respuesta de MARCia no es JSON válido en ' + ruta + ': ' + respuesta.getContentText().substring(0, 200));
  }
}

// ---------------------------------------------------------------------------
// Construcción de la búsqueda estructurada
// ---------------------------------------------------------------------------

/**
 * Arma el payload "Search$Structured" que espera MARCia. Todos los campos
 * no usados deben ir explícitamente en null (no omitidos) — así es como el
 * frontend real los manda.
 *
 * @param {Object} opciones
 * @param {Array<string>} [opciones.clases] Clases de Niza (ej. ['37']).
 * @param {Array<string>} [opciones.estatus] ['REGISTRADO'] y/o ['EN_TRAMITE']
 *        — el valor real visto en la red es 'REGISTRADO' (sin tilde).
 * @param {string} [opciones.fechaTipo] 'DATE_REGISTRATION' | 'DATE_APPLICATION'
 *        | 'DATE_PUBLICATION' | 'DATE_TERMINATION' — nombres inferidos de
 *        las etiquetas de la UI (Registro/Presentación/Publicación/
 *        Terminación); solo 'DATE_REGISTRATION' quedó confirmado en vivo.
 * @param {string} [opciones.fechaDesde] 'YYYY-MM-DD'.
 * @param {string} [opciones.fechaHasta] 'YYYY-MM-DD'.
 */
function construirQueryMarcia_(opciones) {
  return {
    _type: 'Search$Structured',
    query: {
      number: null,
      classes: opciones.clases && opciones.clases.length ? opciones.clases : null,
      codes: null,
      title: null,
      titleOption: 'fuzzier',
      goodsAndServices: null,
      name: null,
      date: (opciones.fechaTipo && opciones.fechaDesde && opciones.fechaHasta) ? {
        types: [opciones.fechaTipo],
        date: { from: opciones.fechaDesde, to: opciones.fechaHasta },
      } : null,
      indicators: null,
      status: opciones.estatus && opciones.estatus.length ? opciones.estatus : null,
      markType: null,
      appType: null,
      wordSet: null,
    },
    images: [],
  };
}

// ---------------------------------------------------------------------------
// Búsqueda principal
// ---------------------------------------------------------------------------

/**
 * Busca en MARCia y pagina hasta juntar opciones.maxResultados (o el total
 * disponible, el que sea menor). No filtra por titular/persona moral ni
 * hace nada de negocio — eso vive en el orquestador.
 *
 * @returns {{ totalDisponibles: number, resultados: Array<Object> }}
 *          Cada resultado trae: id, applicationNumber, registrationNumber,
 *          title, status, appType, owners[], dates{application,cancellation,
 *          expiry}, classes[].
 */
function buscarMarcia(opciones) {
  opciones = opciones || {};
  const sesion = marciaIniciarSesion_();
  const query = construirQueryMarcia_(opciones);

  const record = marciaPost_(sesion, '/marcas/search/internal/record', query);
  const searchId = record.id;
  const totalDisponibles = record.count || 0;

  const tope = Math.min(opciones.maxResultados || totalDisponibles, totalDisponibles, MARCIA_MAX_RESULTADOS_API);

  const resultados = [];
  let pagina = 0;
  while (resultados.length < tope) {
    const body = {
      searchId: searchId,
      pageSize: MARCIA_TAMANO_PAGINA,
      pageNumber: pagina,
      statusFilter: [],
      viennaCodeFilter: [],
      niceClassFilter: [],
    };
    const respuestaPagina = marciaPost_(sesion, '/marcas/search/internal/result', body);
    const pagina_resultados = respuestaPagina.resultPage || [];
    if (pagina_resultados.length === 0) break;

    resultados.push.apply(resultados, pagina_resultados);
    if (pagina_resultados.length < MARCIA_TAMANO_PAGINA) break;
    pagina++;
  }

  return {
    totalDisponibles: totalDisponibles,
    resultados: resultados.slice(0, tope),
  };
}

// ---------------------------------------------------------------------------
// Pruebas
// ---------------------------------------------------------------------------

/** Mismo caso validado manualmente el 6 oct 2026 contra el sitio real:
 *  Clase 37, Registrado, fecha de Registro 2016-10-06 a 2021-10-06 -> 17,105. */
function test_contarMarciaClase37() {
  const resultado = buscarMarcia({
    clases: ['37'],
    estatus: ['REGISTRADO'],
    fechaTipo: 'DATE_REGISTRATION',
    fechaDesde: '2016-10-06',
    fechaHasta: '2021-10-06',
    maxResultados: 5,
  });
  Logger.log('Total disponibles: %s (esperado 17105 el 6 oct 2026, crece con el tiempo)', resultado.totalDisponibles);
  Logger.log('Primeros 5: %s', JSON.stringify(resultado.resultados, null, 2));
  if (resultado.totalDisponibles < 15000) {
    throw new Error('Total inesperadamente bajo — revisar si el payload sigue siendo válido.');
  }
}
