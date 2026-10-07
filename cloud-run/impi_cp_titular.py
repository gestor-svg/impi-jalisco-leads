"""
IMPI — Búsqueda por Registro + Código Postal del Titular
==========================================================

Basado en el mismo mecanismo ya probado en producción en el proyecto
cloudrun-impi-fonetico (impi_fonetico_COMPLETO.py): MARCANET es una app
JSF/PrimeFaces con ViewState, que responde a peticiones AJAX parciales
(javax.faces.partial.ajax) con XML que trae bloques CDATA con HTML embebido.

Este módulo es NUEVO (no existe en el proyecto original) — hace dos cosas
que el buscador fonético no hace:
  1. Busca por NÚMERO DE REGISTRO en vez de por nombre/fonética
     (bsqRegistroCompleto.pgi, formulario frmBsqReg).
  2. Abre la ficha de detalle del expediente y extrae el Código Postal del
     TITULAR (no del apoderado — son campos separados en la ficha, y DEBEN
     tratarse distinto: el apoderado puede estar en otro estado aunque el
     titular sea local).

Hallazgo real validado en vivo el 6-7 oct 2026, navegando el sitio real (no
solo documentación), con un caso real (TURBOPARTES GDL, S.A. DE C.V.,
registro 22126, expediente 8215, clase 37 — autopartes/construcción,
Guadalajara, Jalisco, CP 44430):

  - El NÚMERO DE REGISTRO NO ES ÚNICO — el mismo registro 22126 regresó
    DOS expedientes distintos (8215 "TURBO PARTES GDL" clase 37, y 15720
    "OPERADORAS LADA..." clase 38). Por eso buscar_codigo_postal_titular()
    recibe también el número de expediente (que MARCia sí trae en cada
    resultado, campo applicationNumber) — es obligatorio para desambiguar
    cuál fila de la tabla de resultados es la correcta antes de abrir su
    detalle. Sin este chequeo se podría traer el CP de una empresa
    completamente distinta.

  - La ficha de detalle trae "Datos del titular" Y "Datos del apoderado"
    como secciones separadas, cada una con su propio Código postal — en el
    caso de prueba, el titular estaba en Guadalajara (44430) pero el
    apoderado en Zapopan (45110): direcciones distintas de la MISMA ficha,
    confirma que hay que leer la sección correcta, no la primera que
    aparezca con la etiqueta "Código postal".

  - Algunas fichas (según el tipo de solicitud) traen además una sección
    "Establecimiento" con su propio domicilio — no se usa aquí porque no
    está presente en todos los tipos de solicitud (en la ficha de BIMBO,
    un "REGISTRO DE MARCA" normal, no aparece; sí apareció en la de
    TURBOPARTES GDL, un "PUBLICACIÓN DE NOMBRE COMERCIAL"). El titular SÍ
    está presente siempre, así que es el campo confiable a usar.

✅ VALIDADO EN VIVO (7 oct 2026) — el primer intento SÍ falló como se temía
arriba, y confirmó exactamente la sospecha: el formulario de búsqueda por
registro (bsqRegistroCompleto.pgi) es un POST "clásico" de página completa
(sin cabeceras partial/ajax, sin CDATA) — a diferencia del click de detalle,
que SÍ es un postback AJAX parcial de PrimeFaces (confirmado con el
interceptor de XMLHttpRequest: cero peticiones XHR durante el submit del
formulario de búsqueda, pero la página completa se recargó con los
resultados — mientras que el click de detalle no dispara ninguna
navegación, solo actualiza el DOM in-place). Se corrigió _buscar_por_registro
para reflejar esto: POST plano, se parsea el HTML completo de la respuesta
(no CDATA), y se vuelve a extraer el ViewState de esa respuesta (JSF emite
un ViewState nuevo en cada render de página completa).
"""

import re
import time
import logging
from typing import Optional, Dict
from dataclasses import dataclass

import requests
from bs4 import BeautifulSoup

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)


class ConfigMarcanetRegistro:
    ORIGEN = "https://acervomarcas.impi.gob.mx:8181"
    BASE_URL = ORIGEN + "/marcanet/"
    URL_BUSQUEDA_REGISTRO = BASE_URL + "vistas/common/datos/bsqRegistroCompleto.pgi"

    HEADERS = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8',
        'Referer': BASE_URL,
    }
    HEADERS_AJAX = {
        'Faces-Request': 'partial/ajax',
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    }

    TIMEOUT_PETICION = 30
    MAX_REINTENTOS = 3
    DELAY_ENTRE_PETICIONES = 3.0  # mismo hallazgo que impi_fonetico_COMPLETO.py: MARCANET degrada con peticiones rápidas consecutivas.


@dataclass
class ResultadoCP:
    encontrado: bool
    codigo_postal: Optional[str] = None
    nombre_titular: Optional[str] = None
    poblacion: Optional[str] = None
    fecha_concesion: Optional[str] = None
    error: Optional[str] = None


class IMPIBuscadorPorRegistro:
    """Cliente para buscar por número de registro en MARCANET y extraer el
    Código Postal del titular de un expediente específico."""

    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update(ConfigMarcanetRegistro.HEADERS)
        self.viewstate = None

    def buscar_codigo_postal_titular(self, numero_registro: str, numero_expediente: str) -> ResultadoCP:
        """
        @param numero_registro Número de registro (de MARCia: registrationNumber).
        @param numero_expediente Número de expediente (de MARCia: applicationNumber)
               — OBLIGATORIO para desambiguar, un mismo registro puede traer
               varios expedientes de marcas distintas (hallazgo arriba).

        BUG REAL encontrado en la primera corrida a escala (7 oct 2026, lote
        de 100): 35 de 39 candidatos que necesitaban este respaldo fallaron
        con "no trajo ningún expediente" — pero NO era degradación de
        MARCANET por volumen (se confirmó reproduciendo un caso fallido en
        aislamiento, sin lote, y volvió a fallar igual). La causa real:
        cuando un número de registro tiene UN SOLO expediente coincidente
        (el caso más común — el caso con 2 coincidencias, como TURBOPARTES
        GDL/registro 22126, que fue el único probado a mano antes, resultó
        ser el caso MENOS común), MARCANET NO regresa una tabla de
        resultados — regresa un 302 redirect DIRECTO a la ficha de detalle
        (`requests` lo sigue solo, así que _buscar_por_registro() ya
        aterriza en esa ficha). El código original siempre esperaba una
        tabla con un link que clickear, así que en el caso de un solo
        match no encontraba ningún `<a>` con el texto del expediente (la
        ficha de detalle no tiene ese link, es texto plano) y reportaba
        error aunque los datos sí estaban ahí. Verificado con un caso real
        (registro 97361, expediente 91274): el detail page ya traía
        "Número de expediente: 91274" exacto.
        """
        try:
            self._obtener_viewstate()
            resultado_busqueda = self._buscar_por_registro(numero_registro)

            if self._es_pagina_detalle(resultado_busqueda):
                # Caso común: un solo expediente coincidente, MARCANET ya
                # redirigió directo a la ficha — no hace falta el 2do paso.
                texto_pagina = BeautifulSoup(resultado_busqueda, 'lxml').get_text('\n')
                expediente_en_pagina = self._extraer_campo(texto_pagina, 'Número de expediente')
                if str(expediente_en_pagina).strip() != str(numero_expediente).strip():
                    return ResultadoCP(
                        encontrado=False,
                        error=(
                            f'Registro {numero_registro} redirigió directo a un expediente distinto '
                            f'({expediente_en_pagina}) del esperado ({numero_expediente}) — no se usa, '
                            f'evita traer el CP de una empresa equivocada.'
                        )
                    )
                return self._extraer_cp_titular(resultado_busqueda)

            # Caso con varios expedientes coincidentes: sí hay tabla, se
            # busca el link del expediente correcto y se abre su detalle.
            source_id = self._encontrar_source_expediente(resultado_busqueda, numero_expediente)
            if not source_id:
                return ResultadoCP(
                    encontrado=False,
                    error=f'Registro {numero_registro} no trajo ningún expediente {numero_expediente} en MARCANET.'
                )

            time.sleep(ConfigMarcanetRegistro.DELAY_ENTRE_PETICIONES)
            detalle_html = self._abrir_detalle(source_id)
            return self._extraer_cp_titular(detalle_html)

        except Exception as e:
            logger.error(f'Error buscando CP para registro {numero_registro}/expediente {numero_expediente}: {e}', exc_info=True)
            return ResultadoCP(encontrado=False, error=str(e))

    # -------------------------------------------------------------------
    # Pasos internos
    # -------------------------------------------------------------------

    def _obtener_viewstate(self):
        respuesta = self._fetch_con_reintentos(
            lambda: self.session.get(ConfigMarcanetRegistro.URL_BUSQUEDA_REGISTRO, timeout=ConfigMarcanetRegistro.TIMEOUT_PETICION)
        )
        soup = BeautifulSoup(respuesta.content, 'html.parser')
        vs = soup.find('input', {'name': 'javax.faces.ViewState'})
        if not vs or not vs.get('value'):
            raise RuntimeError('No se encontró ViewState en bsqRegistroCompleto.pgi.')
        self.viewstate = vs.get('value')

    def _buscar_por_registro(self, numero_registro: str) -> str:
        """POST clásico (página completa, NO AJAX) del formulario de
        búsqueda por registro — ver nota de validación en vivo al inicio
        del archivo. Regresa el HTML completo de la respuesta, y de paso
        refresca self.viewstate con el que trae esta página nueva."""
        data = {
            'frmBsqReg': 'frmBsqReg',
            'frmBsqReg:registroId': str(numero_registro).strip(),
            'frmBsqReg:busquedaId': 'frmBsqReg:busquedaId',
            'javax.faces.ViewState': self.viewstate,
        }
        respuesta = self._fetch_con_reintentos(
            lambda: self.session.post(
                ConfigMarcanetRegistro.URL_BUSQUEDA_REGISTRO,
                data=data,
                headers=ConfigMarcanetRegistro.HEADERS,
                timeout=ConfigMarcanetRegistro.TIMEOUT_PETICION,
            )
        )
        html_completo = respuesta.text
        self._actualizar_viewstate_desde_html(html_completo)
        return html_completo

    def _actualizar_viewstate_desde_html(self, html: str) -> None:
        """JSF emite un ViewState nuevo en cada render de página completa —
        hay que usar el de la respuesta más reciente, no el de la carga
        inicial, para el siguiente postback (el click de detalle)."""
        soup = BeautifulSoup(html, 'html.parser')
        vs = soup.find('input', {'name': 'javax.faces.ViewState'})
        if vs and vs.get('value'):
            self.viewstate = vs.get('value')

    @staticmethod
    def _es_pagina_detalle(html: str) -> bool:
        """true si la respuesta de la búsqueda ya ES la ficha de detalle
        (caso de un solo expediente coincidente, MARCANET redirige directo
        sin pasar por una tabla de resultados) en vez de una lista para
        elegir de varias."""
        return 'Datos generales' in html and 'Datos del titular' in html

    def _encontrar_source_expediente(self, html_tabla: str, numero_expediente: str) -> Optional[str]:
        """Busca, dentro del HTML de resultados, el link cuyo texto visible
        es el número de expediente buscado, y regresa el id/source de su
        atributo onclick (PrimeFaces.ab({s:"...", ...}))."""
        soup = BeautifulSoup(html_tabla, 'lxml')
        for link in soup.find_all('a'):
            if link.get_text(strip=True) == str(numero_expediente).strip():
                onclick = link.get('onclick', '') or ''
                match = re.search(r's\s*:\s*"([^"]+)"', onclick)
                if match:
                    return match.group(1)
                # Respaldo: usar el id del propio link si no se pudo leer el onclick.
                if link.get('id'):
                    return link.get('id')
        return None

    def _abrir_detalle(self, source_id: str) -> str:
        """El click de detalle es un postback AJAX de PrimeFaces, pero —
        hallazgo real al depurar contra el sitio (7 oct 2026) — la
        respuesta AJAX NO trae el HTML del detalle embebido: solo trae una
        instrucción de redirect:
            <partial-response><redirect url="/marcanet/vistas/common/
            busquedas/detalleExpedienteParcial.pgi"></redirect></partial-response>
        El POST sí tiene un efecto real del lado del servidor (deja la
        sesión "apuntando" al expediente elegido), y el contenido real se
        obtiene con un GET normal a esa URL de redirect, usando las mismas
        cookies de sesión. Confirmado con curl plano contra el sitio real:
        sin el GET posterior, la página de detalle no trae nada útil."""
        data = {
            'javax.faces.partial.ajax': 'true',
            'javax.faces.source': source_id,
            'javax.faces.partial.execute': source_id,
            'javax.faces.partial.render': 'frmBsqReg',
            'frmBsqReg': 'frmBsqReg',
            source_id: source_id,
            'javax.faces.ViewState': self.viewstate,
        }
        respuesta_ajax = self._fetch_con_reintentos(
            lambda: self.session.post(
                ConfigMarcanetRegistro.URL_BUSQUEDA_REGISTRO,
                data=data,
                headers=ConfigMarcanetRegistro.HEADERS_AJAX,
                timeout=ConfigMarcanetRegistro.TIMEOUT_PETICION,
            )
        )

        match_redirect = re.search(r'<redirect url="([^"]+)"', respuesta_ajax.text)
        if not match_redirect:
            raise RuntimeError(
                'El postback de detalle no regresó una instrucción de redirect esperada: '
                + respuesta_ajax.text[:300]
            )
        url_detalle = ConfigMarcanetRegistro.ORIGEN + match_redirect.group(1)

        respuesta_detalle = self._fetch_con_reintentos(
            lambda: self.session.get(url_detalle, headers=ConfigMarcanetRegistro.HEADERS, timeout=ConfigMarcanetRegistro.TIMEOUT_PETICION)
        )
        return respuesta_detalle.text

    def _extraer_cp_titular(self, html_detalle: str) -> ResultadoCP:
        soup = BeautifulSoup(html_detalle, 'lxml')

        texto_completo = soup.get_text('\n')
        if 'Datos del titular' not in texto_completo:
            return ResultadoCP(encontrado=False, error='La ficha de detalle no trae sección "Datos del titular".')

        # "Fecha de concesión" vive en "Datos generales", ANTES de "Datos
        # del titular" — se lee del texto completo, no de la ventana
        # recortada de abajo.
        fecha_concesion = self._extraer_campo(texto_completo, 'Fecha de concesión')

        # La sección "Datos del titular" viene antes de "Establecimiento" o
        # "Datos del apoderado" (lo que aparezca primero) — se recorta el
        # texto a esa ventana para no leer el CP del apoderado por error.
        seccion_titular = texto_completo.split('Datos del titular', 1)[1]
        for corte in ['Establecimiento', 'Datos del apoderado', 'Productos y servicios']:
            if corte in seccion_titular:
                seccion_titular = seccion_titular.split(corte, 1)[0]
                break

        nombre = self._extraer_campo(seccion_titular, 'Nombre')
        poblacion = self._extraer_campo(seccion_titular, 'Población')
        cp = self._extraer_campo(seccion_titular, 'Código postal')

        if not cp:
            return ResultadoCP(encontrado=False, nombre_titular=nombre, poblacion=poblacion, fecha_concesion=fecha_concesion, error='Código postal vacío o no encontrado en la ficha.')

        return ResultadoCP(encontrado=True, codigo_postal=cp.strip(), nombre_titular=nombre, poblacion=poblacion, fecha_concesion=fecha_concesion)

    @staticmethod
    def _extraer_campo(texto: str, etiqueta: str) -> Optional[str]:
        """Extrae el valor que sigue a una etiqueta tipo "Código postal\\n44430\\n..."
        — la ficha de MARCANET se extrae como pares etiqueta/valor en líneas consecutivas."""
        lineas = [l.strip() for l in texto.split('\n') if l.strip()]
        for i, linea in enumerate(lineas):
            if linea == etiqueta and i + 1 < len(lineas):
                return lineas[i + 1]
        return None

    @staticmethod
    def _extraer_cdata_relevante(xml_texto: str, marcador: str) -> str:
        """Extrae el bloque CDATA que contiene el marcador buscado — mismo
        patrón de impi_fonetico_COMPLETO.py._parsear_resultados_fonetica."""
        bloques = re.findall(r'<!\[CDATA\[(.*?)\]\]>', xml_texto, re.DOTALL)
        for bloque in bloques:
            if marcador in bloque:
                return bloque
        # Si no hay CDATA (respuesta no-AJAX, HTML plano), regresar tal cual.
        return xml_texto

    def _fetch_con_reintentos(self, llamada):
        ultimo_error = None
        for intento in range(1, ConfigMarcanetRegistro.MAX_REINTENTOS + 1):
            try:
                respuesta = llamada()
                respuesta.raise_for_status()
                return respuesta
            except requests.RequestException as e:
                ultimo_error = e
                logger.warning(f'Intento {intento}/{ConfigMarcanetRegistro.MAX_REINTENTOS} falló: {e}')
                if intento < ConfigMarcanetRegistro.MAX_REINTENTOS:
                    time.sleep(ConfigMarcanetRegistro.DELAY_ENTRE_PETICIONES)
        raise ultimo_error
