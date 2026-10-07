/**
 * Llamada al servicio Cloud Run impi-cp-titular (Código Postal del titular
 * vía MARCANET "por registro") — mismo mecanismo de autenticación de dos
 * capas que ya usa cloudrun-impi-fonetico/apps-script/impi.gs: token de
 * identidad de Google (ScriptApp.getIdentityToken()) + header de secreto
 * compartido. Ver ese archivo para la guía completa de los 4 pasos de
 * configuración (audiencia personalizada + IAM invoker) — se repiten aquí
 * para este proyecto nuevo, mismo procedimiento.
 *
 * ⚠️ PENDIENTE — requiere que la audiencia personalizada de Cloud Run y el
 * permiso roles/run.invoker ya estén configurados para EL CLIENT ID DE ESTE
 * proyecto de Apps Script (distinto al de cloudrun-impi-fonetico, cada
 * proyecto de Apps Script tiene el suyo). Hasta completar esos pasos,
 * llamarCpTitular_() falla con 401/403 aunque el código esté correcto.
 */

const CP_TITULAR_SERVICE_URL = 'https://impi-cp-titular-633481477478.us-central1.run.app';
const CP_TITULAR_SHARED_SECRET = 'dbd5f8abb03b2952aa8ba0deb1d75161181f625fcd6647c42f7cc82c7bf5ccef';

/**
 * @param {string} numeroRegistro
 * @param {string} numeroExpediente Obligatorio — un mismo número de
 *        registro puede pertenecer a expedientes de marcas distintas
 *        (hallazgo real, ver impi_cp_titular.py) — sin esto se arriesga
 *        traer el CP de una empresa equivocada.
 * @returns {{encontrado:boolean, codigo_postal:?string, nombre_titular:?string, poblacion:?string, error:?string}}
 */
function llamarCpTitular_(numeroRegistro, numeroExpediente) {
  const idToken = ScriptApp.getIdentityToken();

  const respuesta = UrlFetchApp.fetch(CP_TITULAR_SERVICE_URL + '/cp-titular', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Authorization': 'Bearer ' + idToken,
      'X-Internal-Secret': CP_TITULAR_SHARED_SECRET,
    },
    payload: JSON.stringify({ numero_registro: String(numeroRegistro), numero_expediente: String(numeroExpediente) }),
    muteHttpExceptions: true,
  });

  const codigo = respuesta.getResponseCode();
  if (codigo === 401 || codigo === 403) {
    throw new Error(
      codigo + ' llamando a impi-cp-titular — revisar configuración de audiencia personalizada + IAM invoker ' +
      '(ver nota al inicio de cloudrun.gs). Respuesta: ' + respuesta.getContentText()
    );
  }
  if (codigo !== 200) {
    throw new Error('Error impi-cp-titular HTTP ' + codigo + ': ' + respuesta.getContentText());
  }

  return JSON.parse(respuesta.getContentText());
}

/**
 * Correr UNA VEZ a mano desde el editor de Apps Script (Ejecutar ->
 * diagnosticarClientId) — la primera ejecución pedirá autorizar los
 * scopes del proyecto (acepta el consentimiento). Imprime en el log el
 * Client ID que hay que registrar como audiencia personalizada en Cloud
 * Run (paso 3 de la guía en la nota de arriba de este archivo).
 */
function diagnosticarClientId() {
  const idToken = ScriptApp.getIdentityToken();
  const partes = idToken.split('.');
  const payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(partes[1])).getDataAsString());
  Logger.log('Client ID (audience) de este proyecto de Apps Script: %s', payload.aud);
  Logger.log('Cuenta efectiva: %s', payload.email || payload.sub);
}

function test_llamarCpTitular_TurbopartesGDL() {
  const r = llamarCpTitular_('22126', '8215');
  Logger.log(JSON.stringify(r, null, 2));
  if (r.codigo_postal !== '44430') {
    throw new Error('Esperaba CP 44430, llegó: ' + r.codigo_postal);
  }
  Logger.log('OK.');
}
