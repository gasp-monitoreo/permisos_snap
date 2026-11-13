"""Caché de /api/tramites por rango de años (stale-while-revalidate).

Descargar los trámites de un año desde CeroFilas toma ~20 s (pagina de a 50).
Se guardan en la caché de Django (tabla en Postgres: compartida entre workers
y persistente entre reinicios):
  - menos de FRESCO_SEG de antigüedad → se sirven tal cual;
  - más antiguos → se sirven al instante y se refrescan en segundo plano;
  - sin datos → se descargan en el momento (solo la primera vez).
"""
import threading
import time
from datetime import datetime
from zoneinfo import ZoneInfo

from django.core.cache import cache

FRESCO_SEG   = 10 * 60          # 10 min
VIGENCIA_SEG = 365 * 24 * 3600  # se conserva un año (respaldo si CeroFilas cae o bloquea)
TZ = ZoneInfo('America/Santiago')

_en_curso = set()
_lock = threading.Lock()


def rango_anios(created_at_start, created_at_end):
    """Años del rango pedido. El margen de un día absorbe la zona horaria del navegador."""
    desde = datetime.fromtimestamp(int(created_at_start) + 86400, TZ).year
    hasta = datetime.fromtimestamp(int(created_at_end) - 86400, TZ).year
    return desde, hasta


def _clave(desde, hasta):
    return f'tramites:{desde}-{hasta}'


def _descargar(desde, hasta):
    from .core import es_tramite_visible, fetch_all_tramites, normalize_tramite
    ini = int(datetime(desde, 1, 1, tzinfo=TZ).timestamp())
    fin = int(datetime(hasta, 12, 31, 23, 59, 59, tzinfo=TZ).timestamp())
    raw = fetch_all_tramites(created_at_start=str(ini), created_at_end=str(fin),
                             date_cutoff=datetime.fromtimestamp(ini))
    data = [t for t in (normalize_tramite(x) for x in raw) if es_tramite_visible(t)]
    entrada = {'ts': time.time(), 'data': data}
    cache.set(_clave(desde, hasta), entrada, VIGENCIA_SEG)
    return entrada


def _refrescar_en_segundo_plano(desde, hasta):
    from .core import cerofilas_bloqueado
    if cerofilas_bloqueado():      # no insistir: consultar más alarga el bloqueo
        return
    clave = _clave(desde, hasta)
    with _lock:
        if clave in _en_curso:
            return
        _en_curso.add(clave)

    def run():
        try:
            _descargar(desde, hasta)
        except Exception as exc:  # se mantiene la versión anterior
            print(f'[tramites-cache] error refrescando {clave}: {exc}')
        finally:
            with _lock:
                _en_curso.discard(clave)

    threading.Thread(target=run, daemon=True).start()


def _guardado(desde, hasta):
    """Lo guardado para el rango. Un rango de varios años se arma con los años sueltos
    (que son los que actualiza la carga manual) si están todos y son más recientes."""
    entrada = cache.get(_clave(desde, hasta))
    if desde == hasta:
        return entrada
    anios = [cache.get(_clave(a, a)) for a in range(desde, hasta + 1)]
    if all(anios):
        compuesto = {'ts': min(a['ts'] for a in anios), 'data': [t for a in anios for t in a['data']]}
        if entrada is None or compuesto['ts'] >= entrada['ts']:
            return compuesto
    return entrada


def obtener(desde, hasta, forzar=False):
    """Retorna {'ts', 'data'} para el rango de años."""
    guardado = _guardado(desde, hasta)
    if guardado is not None and not forzar:
        if time.time() - guardado['ts'] > FRESCO_SEG:
            _refrescar_en_segundo_plano(desde, hasta)
        return guardado
    try:
        return _descargar(desde, hasta)
    except Exception:
        if guardado is None:
            raise
        return dict(guardado, aviso_bloqueo=True)   # Cero Filas no respondió: lo último guardado


def guardar_anio(anio, data, ts=None):
    cache.set(_clave(anio, anio), {'ts': ts or time.time(), 'data': data}, VIGENCIA_SEG)


def precalentar_anio_actual(anios_atras=2):
    """Al arrancar: deja listo el año en curso y los anteriores (usados por la presión
    sobre áreas protegidas). Un solo worker descarga."""
    from .core import cerofilas_bloqueado
    actual = datetime.now(TZ).year
    pendientes = [a for a in range(actual, actual - anios_atras - 1, -1) if cache.get(_clave(a, a)) is None]
    if cerofilas_bloqueado():
        return
    if not pendientes or not cache.add('tramites:precalentando', 1, 900):
        return
    try:
        for anio in pendientes:
            n = len(_descargar(anio, anio)['data'])
            print(f'[tramites-cache] {anio}: {n} trámites precargados')
    finally:
        cache.delete('tramites:precalentando')
