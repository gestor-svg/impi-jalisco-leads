# impi-jalisco-leads

Proyecto independiente de prospección: encuentra empresas (personas morales) con marcas registradas ante el IMPI entre 5 y 10 años de antigüedad, valida que su titular esté en Jalisco (cruzando MARCia + MARCANET + DENUE), y enriquece la lista con datos de contacto de directivos (Google + Apollo.io + Hunter.io).

No modifica ni depende de los otros proyectos del mismo autor (`cloudrun-impi-fonetico`, `makeecho-vocero-platform`) — corre en su propia infraestructura (Sheet nuevo, proyecto GCP nuevo, credenciales propias).

## Estado

Diseño cerrado, en construcción. Ver `CLAUDE.md` para el historial de decisiones (se añadirá conforme avance el proyecto, siguiendo el mismo formato que `cloudrun-impi-fonetico`).

## Arquitectura (resumen)

**Archivo 1 — Lista validada (obligatorio):**
1. Búsqueda en MARCia: Clase de Niza 37 (construcción), Estatus=Registrado, fecha de Registro entre hace 10 y hace 5 años → hasta 1,000 resultados.
2. Filtrar a solo personas morales, deduplicar por titular único.
3. Descarga única de DENUE: todo Jalisco, estrato 4-5 (31-100 empleados), sin filtro de giro.
4. Por cada titular: intentar match por nombre contra DENUE (algoritmo de "elemento común"); si no hay match, consultar MARCANET "por registro" y leer el código postal del titular.
5. Se detiene al juntar 100 empresas válidas en Jalisco o al agotar los 1,000 resultados de MARCia.
6. Filas con CP vacío/mal formado en MARCANET (y sin match en DENUE) se archivan en una pestaña aparte para revisión manual.

**Archivo 2 — Enriquecimiento de contacto (obligatorio):**
1. Google (Custom Search API) valida que la empresa siga activa/visible.
2. Si está activa, Apollo.io busca directivos (nombre, puesto, LinkedIn) — así se ahorran créditos en empresas que ya no existen o se movieron.
3. Si Apollo encontró un directivo, Hunter.io verifica que el email encontrado/inferido sea válido.
