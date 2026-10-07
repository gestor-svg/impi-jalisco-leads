/**
 * Utilidades compartidas — Apps Script (Capa 2 del pipeline)
 * ==============================================================
 * Funciones usadas por más de un módulo (denue.gs, places.gs, niza.gs...).
 * Apps Script combina todos los archivos .gs de un proyecto en un solo
 * namespace global en tiempo de ejecución — cualquier función definida
 * aquí NO debe redefinirse en otro archivo (se pisarían silenciosamente).
 */

/** Mayúsculas, sin acentos, espacios colapsados. Uso general para
 *  comparar texto libre (colonias, entidades, giros, nombres de marca). */
function normalizarTexto_(texto) {
  return String(texto)
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // quita acentos (rango de diacríticos combinados)
    .trim()
    .replace(/\s+/g, ' ');
}
