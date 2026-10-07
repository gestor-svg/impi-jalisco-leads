"""
Servicio Cloud Run standalone — Código Postal del titular (MARCANET)
======================================================================
Expone impi_cp_titular.py como servicio HTTP aislado, mismo patrón de
protección que el servicio impi-fonetico del proyecto cloudrun-impi-fonetico
(header X-Internal-Secret, pensado para llamadas máquina-a-máquina desde
Apps Script, no para usuarios humanos).
"""

import os
import logging
from flask import Flask, request, jsonify

from impi_cp_titular import IMPIBuscadorPorRegistro

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)

SHARED_SECRET = os.environ.get("SHARED_SECRET", "")


@app.route("/health", methods=["GET"])
def health():
    """Endpoint público, sin secreto — usar para pings de uptime / warm-up."""
    return jsonify({"status": "ok"}), 200


@app.route("/cp-titular", methods=["POST"])
def cp_titular():
    secret_recibido = request.headers.get("X-Internal-Secret", "")
    if not SHARED_SECRET:
        logger.error("SHARED_SECRET no está configurado en el servicio.")
        return jsonify({"error": "servicio mal configurado"}), 500
    if secret_recibido != SHARED_SECRET:
        return jsonify({"error": "unauthorized"}), 401

    data = request.get_json(silent=True) or {}
    numero_registro = (data.get("numero_registro") or "").strip()
    numero_expediente = (data.get("numero_expediente") or "").strip()

    if not numero_registro or not numero_expediente:
        return jsonify({"error": "faltan 'numero_registro' y/o 'numero_expediente'"}), 400

    # Instancia nueva por request — mismo cuidado que el servicio fonético
    # original (session/viewstate son estado mutable de instancia, no debe
    # compartirse entre requests de un mismo contenedor "caliente").
    buscador = IMPIBuscadorPorRegistro()
    resultado = buscador.buscar_codigo_postal_titular(numero_registro, numero_expediente)

    return jsonify({
        "encontrado": resultado.encontrado,
        "codigo_postal": resultado.codigo_postal,
        "nombre_titular": resultado.nombre_titular,
        "poblacion": resultado.poblacion,
        "fecha_concesion": resultado.fecha_concesion,
        "error": resultado.error,
    }), 200


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port)
