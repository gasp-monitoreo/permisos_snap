"""Cache management: compliance + portada historico. PostgreSQL-backed with 30-min in-memory TTL."""
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

from .core import (
    _add_months, _parse_date_flexible, api_get, normalize_tramite,
    fetch_all_tramites, extract_titulo, extract_texto_clasificacion, extract_colecta,
    tramite_normalizado,
    INVESTIGACION_PROCESO_IDS, TODOS_PROCESO_IDS,
)

_CACHE_STALE_HOURS = 24
_COMPLIANCE_TTL    = 1800   # 30 min in-memory
_HISTORICO_TTL     = 1800

_compliance_cache  = {'ts': None, 'data': None, 'revisados': 0}
_historico_cache   = {'ts': None, 'data': None}
_lock = threading.Lock()


# ── Compliance ────────────────────────────────────────────────────────────────

def _fila_compliance(norm, HOY):
    """Fila de cumplimiento (informe vencido) o None si no corresponde."""
    datos = norm.get('datos_raw', {}) or {}
    fta_str = (
        datos.get('fecha_termino_actividades') or datos.get('fecha_termino_actividad') or
        datos.get('fecha_fin_actividades') or datos.get('fecha_fin_investigacion') or
        datos.get('fecha_termino_trabajo_campo')
    )
    if not fta_str:
        return None
    fta_dt = _parse_date_flexible(fta_str)
    if fta_dt is None or _add_months(fta_dt, 36) >= HOY:
        return None
    titulo = extract_titulo(datos)
    return {
        'id':                        norm['id'],
        'proceso_id':                norm['proceso_id'],
        'estado':                    norm['estado'],
        'nombre_solicitante':        norm['nombre_solicitante'],
        'email_solicitante':         norm['email_solicitante'],
        'titulo_investigacion':      str(titulo).strip(),
        'texto_clasificacion':       extract_texto_clasificacion(datos, titulo).strip(),
        'colecta_muestras':          str(extract_colecta(datos)).strip(),
        'fecha_termino_actividades': str(fta_str).strip()[:10],
        'anios_transcurridos':       round((HOY - fta_dt).days / 365.25, 1),
        'fecha_modificacion':        norm.get('fecha_modificacion') or '',
        'region':                    norm.get('region') or '',
        'regiones_list':             norm.get('regiones_list') or [],
    }


def _registro_compliance(r):
    from .models import ComplianceRecord
    return ComplianceRecord(
        tramite_id=r['id'], proceso_id=r.get('proceso_id', 0),
        estado=r['estado'], nombre_solicitante=r['nombre_solicitante'],
        email_solicitante=r['email_solicitante'],
        titulo_investigacion=r['titulo_investigacion'],
        texto_clasificacion=r['texto_clasificacion'],
        colecta_muestras=r['colecta_muestras'],
        fecha_termino_actividades=r['fecha_termino_actividades'],
        anios_transcurridos=r['anios_transcurridos'],
        fecha_modificacion=r['fecha_modificacion'],
        region=r['region'], regiones_list=r['regiones_list'],
    )


def _guardar_compliance(resultados, revisados, HOY):
    from .models import ComplianceRecord, CacheStatus
    if not resultados and ComplianceRecord.objects.exists():
        print('[cache] compliance: resultado vacío; se mantienen los datos anteriores')
        return
    resultados.sort(key=lambda x: x.get('fecha_termino_actividades') or '')
    ComplianceRecord.objects.all().delete()
    ComplianceRecord.objects.bulk_create([_registro_compliance(r) for r in resultados], ignore_conflicts=True)
    CacheStatus.objects.update_or_create(name='compliance',
                                         defaults={'fetched_at': HOY, 'record_count': len(resultados)})
    with _lock:
        _compliance_cache.update({'ts': HOY, 'data': resultados, 'revisados': revisados})


def get_compliance_guardado():
    from .models import ComplianceRecord
    records = [r.to_dict() for r in ComplianceRecord.objects.all()]
    return records, len(records)


def _do_fetch_compliance():
    from .models import ComplianceRecord, CacheStatus

    HOY   = datetime.now()
    corte = _add_months(HOY, -36)
    corte_ts = str(int(corte.timestamp()))

    def _fetch_list(pid):
        try:
            return fetch_all_tramites(proceso_id=pid, created_at_end=corte_ts)
        except Exception:
            return []

    all_raw = []
    with ThreadPoolExecutor(max_workers=len(INVESTIGACION_PROCESO_IDS)) as ex:
        for items in ex.map(_fetch_list, INVESTIGACION_PROCESO_IDS):
            all_raw.extend(items)

    if not all_raw:      # Cero Filas no respondió: se conserva lo guardado
        print('[cache] compliance: Cero Filas no respondió; se mantienen los datos anteriores')
        return get_compliance_guardado()

    seen_ids, candidatos = set(), []
    for t in all_raw:
        tid = t.get('id')
        if tid and tid not in seen_ids:
            seen_ids.add(tid)
            candidatos.append(tid)

    def _check(tid):
        try:
            return _fila_compliance(tramite_normalizado(tid), HOY)
        except Exception:
            return None

    resultados = []
    if candidatos:
        with ThreadPoolExecutor(max_workers=min(4, max(1, len(candidatos)))) as ex:
            for r in as_completed({ex.submit(_check, tid) for tid in candidatos}):
                v = r.result()
                if v:
                    resultados.append(v)

    _guardar_compliance(resultados, len(candidatos), HOY)
    return resultados, len(candidatos)


def get_compliance_data():
    now = datetime.now()
    with _lock:
        if (_compliance_cache['ts'] and
                (now - _compliance_cache['ts']).total_seconds() < _COMPLIANCE_TTL and
                _compliance_cache['data'] is not None):
            return _compliance_cache['data'], _compliance_cache['revisados']

    # Try DB
    from .models import ComplianceRecord, CacheStatus
    try:
        status = CacheStatus.objects.get(name='compliance')
        age_h  = (now - status.fetched_at).total_seconds() / 3600
        records = [r.to_dict() for r in ComplianceRecord.objects.all()]
        with _lock:
            _compliance_cache.update({'ts': now, 'data': records, 'revisados': len(records)})
        if age_h > _CACHE_STALE_HOURS:
            threading.Thread(target=_do_fetch_compliance, daemon=True).start()
        return records, len(records)
    except CacheStatus.DoesNotExist:
        pass

    return _do_fetch_compliance()


# ── Portada historico ─────────────────────────────────────────────────────────

def _fila_historico(norm):
    if norm.get('borrador'):
        return None
    datos  = norm.get('datos_raw', {}) or {}
    titulo = extract_titulo(datos)
    return {
        'id':                   norm['id'],
        'proceso_id':           norm['proceso_id'],
        'estado':               norm['estado'],
        'nombre_solicitante':   norm['nombre_solicitante'],
        'email_solicitante':    norm['email_solicitante'],
        'titulo_investigacion': titulo.strip(),
        'texto_clasificacion':  extract_texto_clasificacion(datos, titulo).strip(),
        'regiones_list':        norm.get('regiones_list', []),
        'fecha_inicio':         norm.get('fecha_inicio') or '',
    }


def _registro_historico(r):
    from .models import PortadaHistoricoRecord
    return PortadaHistoricoRecord(
        tramite_id=r['id'], proceso_id=r['proceso_id'], estado=r['estado'],
        nombre_solicitante=r['nombre_solicitante'], email_solicitante=r['email_solicitante'],
        titulo_investigacion=r['titulo_investigacion'],
        texto_clasificacion=r['texto_clasificacion'],
        regiones_list=r['regiones_list'], fecha_inicio=r['fecha_inicio'],
    )


def _do_fetch_historico():
    from .models import PortadaHistoricoRecord, CacheStatus

    now = datetime.now()

    def _fetch(pid):
        try:
            return [f for f in (_fila_historico(normalize_tramite(t)) for t in fetch_all_tramites(proceso_id=pid)) if f]
        except Exception:
            return []

    all_items = []
    with ThreadPoolExecutor(max_workers=len(TODOS_PROCESO_IDS)) as ex:
        for items in ex.map(_fetch, TODOS_PROCESO_IDS):
            all_items.extend(items)

    seen, dedup = set(), []
    for t in all_items:
        if t['id'] not in seen:
            seen.add(t['id'])
            dedup.append(t)

    if not dedup:        # Cero Filas no respondió: se conserva lo guardado
        print('[cache] portada_historico: Cero Filas no respondió; se mantienen los datos anteriores')
        return [r.to_dict() for r in PortadaHistoricoRecord.objects.all()]

    PortadaHistoricoRecord.objects.all().delete()
    PortadaHistoricoRecord.objects.bulk_create([_registro_historico(r) for r in dedup], ignore_conflicts=True)
    CacheStatus.objects.update_or_create(
        name='portada_historico',
        defaults={'fetched_at': now, 'record_count': len(dedup)},
    )

    with _lock:
        _historico_cache.update({'ts': now, 'data': dedup})

    return dedup


def get_portada_historico_data():
    now = datetime.now()
    with _lock:
        if (_historico_cache['ts'] and
                (now - _historico_cache['ts']).total_seconds() < _HISTORICO_TTL and
                _historico_cache['data'] is not None):
            return _historico_cache['data']

    from .models import PortadaHistoricoRecord, CacheStatus
    try:
        status  = CacheStatus.objects.get(name='portada_historico')
        age_h   = (now - status.fetched_at).total_seconds() / 3600
        records = [r.to_dict() for r in PortadaHistoricoRecord.objects.all()]
        with _lock:
            _historico_cache.update({'ts': now, 'data': records})
        if age_h > _CACHE_STALE_HOURS:
            threading.Thread(target=_do_fetch_historico, daemon=True).start()
        return records
    except CacheStatus.DoesNotExist:
        pass

    return _do_fetch_historico()


# ── Refresh ───────────────────────────────────────────────────────────────────

def refresh_caches():
    with _lock:
        _compliance_cache.update({'ts': None, 'data': None, 'revisados': 0})
        _historico_cache.update({'ts': None, 'data': None})
    threading.Thread(target=_do_fetch_compliance, daemon=True).start()
    threading.Thread(target=_do_fetch_historico,  daemon=True).start()


def init_db_caches():
    """Called from AppConfig.ready() — load DB into memory, refresh if stale."""
    from .models import CacheStatus

    now = datetime.now()

    for name, cache_dict, fetch_fn in [
        ('compliance',        _compliance_cache, _do_fetch_compliance),
        ('portada_historico', _historico_cache,  _do_fetch_historico),
    ]:
        try:
            status = CacheStatus.objects.get(name=name)
            age_h  = (now - status.fetched_at).total_seconds() / 3600
            print(f'[cache] {name}: {status.record_count} registros en DB ({age_h:.1f} h)')
            # Warm in-memory cache from DB now
            if name == 'compliance':
                from .models import ComplianceRecord
                records = [r.to_dict() for r in ComplianceRecord.objects.all()]
                with _lock:
                    _compliance_cache.update({'ts': now, 'data': records, 'revisados': len(records)})
            else:
                from .models import PortadaHistoricoRecord
                records = [r.to_dict() for r in PortadaHistoricoRecord.objects.all()]
                with _lock:
                    _historico_cache.update({'ts': now, 'data': records})
            if age_h > _CACHE_STALE_HOURS:
                threading.Thread(target=fetch_fn, daemon=True).start()
        except CacheStatus.DoesNotExist:
            print(f'[cache] {name}: sin datos en DB, descargando en background…')
            threading.Thread(target=fetch_fn, daemon=True).start()
        except Exception as exc:
            print(f'[cache] {name}: error al inicializar: {exc}')


# ── Carga manual desde CeroFilas (ver tramites/importacion.py) ───────────────

def actualizar_desde_importacion(normalizados):
    """Actualiza histórico y cumplimiento solo con los trámites importados (sin borrar el resto)."""
    from .models import ComplianceRecord, PortadaHistoricoRecord, CacheStatus
    HOY = datetime.now()
    corte = _add_months(HOY, -36)
    ids_todos = set(TODOS_PROCESO_IDS)
    ids_inv = set(INVESTIGACION_PROCESO_IDS)
    n_hist = n_comp = 0
    for norm in normalizados:
        tid, pid = norm.get('id'), norm.get('proceso_id')
        if not tid or pid not in ids_todos:
            continue
        PortadaHistoricoRecord.objects.filter(tramite_id=tid).delete()
        fila = _fila_historico(norm)
        if fila:
            _registro_historico(fila).save()
            n_hist += 1
        if pid in ids_inv:
            ComplianceRecord.objects.filter(tramite_id=tid).delete()
            inicio = _parse_date_flexible(norm.get('fecha_inicio'))
            fila = _fila_compliance(norm, HOY) if (inicio is None or inicio <= corte) else None
            if fila:
                _registro_compliance(fila).save()
                n_comp += 1
    # Marca de frescura: evita que se intente descargar todo de nuevo desde Cero Filas
    for nombre, modelo in (('portada_historico', PortadaHistoricoRecord), ('compliance', ComplianceRecord)):
        CacheStatus.objects.update_or_create(name=nombre,
                                             defaults={'fetched_at': HOY, 'record_count': modelo.objects.count()})
    with _lock:
        _compliance_cache.update({'ts': None, 'data': None, 'revisados': 0})
        _historico_cache.update({'ts': None, 'data': None})
    return n_hist, n_comp
