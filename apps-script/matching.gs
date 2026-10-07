/**
 * Módulo de cruce titular (IMPI) ↔ Razón Social (DENUE)
 * ========================================================
 * Reutiliza el algoritmo de "elemento común" ya construido y probado en
 * cloudrun-impi-fonetico/apps-script/places.gs (función
 * extraerNombreComunGrupo_, sección 6 de ese proyecto) — comparación de
 * nombres PALABRA POR PALABRA desde el inicio, no substring ni Levenshtein,
 * para no fusionar negocios que solo comparten una palabra genérica.
 *
 * Diferencia importante respecto al uso original: allá, el algoritmo
 * comparaba nombres comerciales DENTRO de un grupo ya pre-filtrado por la
 * MISMA Razón_social exacta (para distinguir sucursales de una cadena).
 * Aquí se usa para decidir si DOS ENTIDADES DISTINTAS (titular de IMPI vs.
 * establecimiento de DENUE) son la misma empresa — un problema más exigente.
 * Por eso se añade un paso de normalización nuevo (quitarSufijoCorporativo_)
 * antes de aplicar el algoritmo: sin esto, "ACME, S.A. DE C.V." y
 * "ACME SERVICIOS, S.A. DE C.V." comparten el prefijo trivial "ACME" igual
 * que "ACME, S. DE R.L." — pero también dos empresas DISTINTAS que por
 * coincidencia ambas sean "S.A. DE C.V." sin más info compartirían CERO
 * palabras reales de nombre si no se quita antes el tipo societario (ya
 * que el tipo societario rara vez empieza la razón social, así que no es
 * el caso más riesgoso — el riesgo real es el opuesto: que la razón social
 * sea muy corta y el primer nombre real coincida con otra empresa distinta
 * por ser una palabra común, ej. "GRUPO"). Dado que la decisión fue "rigor
 * estricto", se exige además un mínimo de 2 palabras de elemento común (o
 * 1 sola palabra si esa palabra por sí sola tiene 6+ caracteres) para
 * descartar coincidencias de una sola palabra corta/genérica.
 */

// Tipos societarios y palabras de relleno a ignorar al inicio o dentro del
// nombre para la comparación — NO se usan para mostrar el nombre, solo para
// decidir si hay match.
const MATCHING_SUFIJOS_SOCIETARIOS = [
  'SA DE CV', 'SA DE C V', 'S A DE C V', 'S A P I DE C V', 'SAPI DE CV',
  'S DE R L DE C V', 'S DE RL DE CV', 'S DE RL', 'S C', 'SC',
  'S A', 'SA', 'A C', 'AC',
];

function normalizarNombreEmpresa_(nombre) {
  let normalizado = String(nombre || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // quita acentos
    .replace(/[^A-Z0-9 ]/g, ' ') // puntuación -> espacio (no la borra pegada)
    .replace(/\s+/g, ' ')
    .trim();
  return normalizado;
}

/** Quita el tipo societario (si aparece al final) para que la comparación
 *  de "elemento común" se concentre en el nombre real de la empresa. */
function quitarSufijoCorporativo_(nombreNormalizado) {
  let resultado = nombreNormalizado;
  // Probar los sufijos más largos primero para no dejar residuos parciales.
  const ordenados = MATCHING_SUFIJOS_SOCIETARIOS.slice().sort(function (a, b) { return b.length - a.length; });
  for (let i = 0; i < ordenados.length; i++) {
    const sufijo = ordenados[i];
    if (resultado === sufijo) continue; // el nombre completo es solo el sufijo -> no hay nombre real, no quitar.
    if (resultado.endsWith(' ' + sufijo)) {
      resultado = resultado.slice(0, resultado.length - sufijo.length - 1).trim();
      break; // un solo sufijo por nombre, el más largo que matcheó.
    }
  }
  return resultado;
}

/**
 * Mismo algoritmo de extraerNombreComunGrupo_ (cloudrun-impi-fonetico,
 * places.gs) adaptado para comparar exactamente DOS nombres ya normalizados
 * y sin sufijo societario. Devuelve el arreglo de palabras comunes (prefijo
 * desde el inicio), o [] si no hay ninguna.
 */
function palabrasComunes_(nombreA, nombreB) {
  const palabrasA = nombreA.split(' ').filter(Boolean);
  const palabrasB = nombreB.split(' ').filter(Boolean);
  const minPalabras = Math.min(palabrasA.length, palabrasB.length);

  const comunes = [];
  for (let i = 0; i < minPalabras; i++) {
    if (palabrasA[i] !== palabrasB[i]) break;
    comunes.push(palabrasA[i]);
  }
  return comunes;
}

/** Umbral de "rigor estricto" (decisión del 6 oct 2026): al menos 2 palabras
 *  de elemento común, o 1 sola palabra si tiene 6+ caracteres (evita que
 *  coincidencias de una palabra corta y genérica, ej. "GRUPO", "CASA",
 *  cuenten como match real). */
function esElementoComunSuficiente_(palabras) {
  if (palabras.length >= 2) return true;
  if (palabras.length === 1 && palabras[0].length >= 6) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Índice de DENUE por primera palabra (para no comparar contra todo el
// universo en cada titular — el pull de Jalisco+estrato 4-5 puede traer
// varios miles de establecimientos).
// ---------------------------------------------------------------------------

/**
 * @param {Array<Object>} registrosDenue Resultado crudo de buscarDenue().
 * @returns {Object} Mapa de primera-palabra-normalizada -> [registros].
 */
function construirIndiceDenue_(registrosDenue) {
  const indice = {};
  registrosDenue.forEach(function (registro) {
    const razonSocial = (registro.Razon_social || '').trim();
    if (!razonSocial) return; // sin Razón_social no se puede cruzar por nombre de persona moral.

    const normalizado = quitarSufijoCorporativo_(normalizarNombreEmpresa_(razonSocial));
    const primeraPalabra = normalizado.split(' ')[0];
    if (!primeraPalabra) return;

    if (!indice[primeraPalabra]) indice[primeraPalabra] = [];
    indice[primeraPalabra].push(registro);
  });
  return indice;
}

/**
 * Busca si el titular de una marca IMPI coincide (elemento común estricto)
 * con algún establecimiento del índice DENUE ya construido.
 *
 * @param {string} nombreTitular Nombre del titular tal como lo trae IMPI.
 * @param {Object} indiceDenue Resultado de construirIndiceDenue_().
 * @returns {Object|null} El registro DENUE que matchea, o null.
 */
function buscarMatchTitularEnDenue_(nombreTitular, indiceDenue) {
  const normalizado = quitarSufijoCorporativo_(normalizarNombreEmpresa_(nombreTitular));
  const primeraPalabra = normalizado.split(' ')[0];
  if (!primeraPalabra) return null;

  const candidatos = indiceDenue[primeraPalabra];
  if (!candidatos || candidatos.length === 0) return null;

  for (let i = 0; i < candidatos.length; i++) {
    const razonSocialCandidato = quitarSufijoCorporativo_(
      normalizarNombreEmpresa_(candidatos[i].Razon_social)
    );
    const comunes = palabrasComunes_(normalizado, razonSocialCandidato);
    if (esElementoComunSuficiente_(comunes)) return candidatos[i];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Filtro de persona moral (decisión del 6 oct 2026: solo personas morales)
// ---------------------------------------------------------------------------

const MATCHING_INDICADORES_PERSONA_MORAL = [
  'SA DE CV', 'S A DE C V', 'SAPI', 'S A P I',
  'S DE RL', 'S DE R L', 'SC', 'S C', 'AC', 'A C', 'SAB', 'S A B',
];

/** true si el nombre del titular trae indicios de ser persona moral (razón
 *  social con tipo societario), false si parece nombre de persona física. */
function esPersonaMoral_(nombreTitular) {
  const normalizado = normalizarNombreEmpresa_(nombreTitular);
  return MATCHING_INDICADORES_PERSONA_MORAL.some(function (indicador) {
    return normalizado.indexOf(indicador) !== -1;
  });
}

// ---------------------------------------------------------------------------
// Pruebas
// ---------------------------------------------------------------------------

function test_matchingElementoComun() {
  const casos = [
    { a: 'TURBOPARTES GDL, S.A. DE C.V.', b: 'TURBOPARTES GDL SA DE CV', esperado: true },
    { a: 'GRUPO LAMOSA, S.A.B. DE C.V.', b: 'GRUPO CONSTRUCTOR PEASA, S.A. DE C.V.', esperado: false }, // "GRUPO" solo, muy corto -> no basta
    { a: 'DAGLE CONSULTORES, S.A. DE C.V.', b: 'DAGLE CONSULTORES SA DE CV', esperado: true },
    { a: 'IMPERQUIMIA, S.A. DE C.V.', b: 'IMPERIAL QUIMICA SA DE CV', esperado: false },
  ];
  casos.forEach(function (c) {
    const normA = quitarSufijoCorporativo_(normalizarNombreEmpresa_(c.a));
    const normB = quitarSufijoCorporativo_(normalizarNombreEmpresa_(c.b));
    const comunes = palabrasComunes_(normA, normB);
    const resultado = esElementoComunSuficiente_(comunes);
    Logger.log('%s vs %s -> comunes=%s match=%s (esperado %s)', c.a, c.b, JSON.stringify(comunes), resultado, c.esperado);
    if (resultado !== c.esperado) {
      throw new Error('Caso de matching falló: "' + c.a + '" vs "' + c.b + '"');
    }
  });
  Logger.log('Todos los casos de matching OK.');
}

function test_esPersonaMoral() {
  if (!esPersonaMoral_('TURBOPARTES GDL, S.A. DE C.V.')) throw new Error('Debió detectar persona moral.');
  if (esPersonaMoral_('JUAN CARLOS RUIZ SIERRA')) throw new Error('No debió detectar persona moral.');
  Logger.log('test_esPersonaMoral OK.');
}
