"""Carga manual de trámites descargados desde CeroFilas con el navegador.

Mientras el WAF de CeroFilas pida CAPTCHA, la plataforma no puede consultar su API.
El superusuario descarga los trámites desde su propio navegador (marcador «Descargar
trámites», ver static/js/importar.js) y sube aquí el archivo. Formato:

    {"origen": "cerofilas", "modo": "cambios" | "completo", "desde": <unix ts>,
     "generado": "<iso>", "items": [<trámite tal como lo entrega /backend/api/tramites>]}

  - modo "cambios": trámites modificados desde «desde»; se combinan con lo guardado.
  - modo "completo": todos los trámites creados desde «desde»; esos años se reemplazan.
"""
import gzip
import json
import time
from collections import defaultdict
from datetime import datetime

from django.core.cache import cache

from . import tramites_cache as tc
from .core import _parse_date_flexible, es_tramite_visible, normalize_tramite

CLAVE_ULTIMA = 'cerofilas:ultima_importacion'
MAX_BYTES = 200 * 1024 * 1024


class ArchivoInvalido(ValueError):
    pass


def leer_archivo(contenido: bytes):
    if contenido[:2] == b'\x1f\x8b':
        contenido = gzip.decompress(contenido)
    if len(contenido) > MAX_BYTES:
        raise ArchivoInvalido('El archivo es demasiado grande.')
    try:
        datos = json.loads(contenido.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ArchivoInvalido('El archivo no es un JSON válido.')
    if not isinstance(datos, dict) or datos.get('origen') != 'cerofilas' or not isinstance(datos.get('items'), list):
        raise ArchivoInvalido('El archivo no viene del marcador «Descargar trámites» de CeroFilas.')
    if datos.get('modo') not in ('cambios', 'completo'):
        raise ArchivoInvalido('Modo de descarga desconocido.')
    return datos


def _anio(raw):
    f = raw.get('fecha_inicio') or raw.get('created_at')
    if isinstance(f, (int, float)):
        return datetime.fromtimestamp(f, tc.TZ).year
    d = _parse_date_flexible(f)
    return d.year if d else None


def importar(datos, usuario=''):
    from .fetcher import actualizar_desde_importacion

    crudos = {}
    for raw in datos['items']:
        if isinstance(raw, dict) and isinstance(raw.get('id'), int):
            crudos[raw['id']] = raw                      # el último gana (páginas repetidas)

    por_anio, normalizados = defaultdict(dict), []
    for tid, raw in crudos.items():
        anio = _anio(raw)
        if anio is None:
            continue
        norm = normalize_tramite(raw)
        normalizados.append(norm)
        por_anio[anio][tid] = norm

    ahora = time.time()
    completo = datos['modo'] == 'completo'
    desde_anio = datetime.fromtimestamp(int(datos.get('desde') or 0), tc.TZ).year if completo else None
    anios = sorted(set(por_anio) | (set(range(desde_anio, datetime.now(tc.TZ).year + 1)) if completo else set()))

    for anio in anios:
        nuevos = por_anio.get(anio, {})
        if completo and anio >= desde_anio:
            base = {}
        else:
            base = {t['id']: t for t in ((tc.cache.get(tc._clave(anio, anio)) or {}).get('data') or [])}
        for tid, norm in nuevos.items():
            if es_tramite_visible(norm):
                base[tid] = norm
            else:
                base.pop(tid, None)
        tc.guardar_anio(anio, sorted(base.values(), key=lambda t: t.get('fecha_inicio') or '', reverse=True), ahora)
        for tid in nuevos:
            cache.delete(f'adjuntos:tramite:{tid}')

    n_hist, n_comp = actualizar_desde_importacion(normalizados)
    resumen = {
        'ts': ahora, 'modo': datos['modo'], 'desde': datos.get('desde'),
        'tramites': len(crudos), 'anios': anios, 'usuario': usuario,
        'historico': n_hist, 'cumplimiento': n_comp,
    }
    cache.set(CLAVE_ULTIMA, resumen, None)
    return resumen


def ultima():
    return cache.get(CLAVE_ULTIMA)
