"""Business logic: CeroFilas API calls, tramite normalization, helpers."""
import ast as _ast
import calendar as _calendar
import re as _re
import time as _time
import unicodedata
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor

import requests
from django.conf import settings


API_BASE = settings.CEROFILAS_API_BASE
TOKEN    = settings.CEROFILAS_TOKEN

INVESTIGACION_PROCESO_IDS = [517, 692, 1992]
FILMACION_PROCESO_IDS     = [437, 585, 631, 632, 672]
TODOS_PROCESO_IDS         = INVESTIGACION_PROCESO_IDS + FILMACION_PROCESO_IDS

PROCESO_PLAZO_MESES = {
    517: 2, 692: 2, 1992: 2,
    437: 1, 585: 1, 631: 1, 632: 1, 672: 1,
}

_pat_finalizacion = _re.compile(
    r'finaliz|recepci[oó]n\s+tramite|recepci[oó]n\s+tr[aá]mite|cierre\s+tr[aá]mite', _re.I
)

ROMAN_A_REGION = {
    'I': 'Tarapacá', 'II': 'Antofagasta', 'III': 'Atacama',
    'IV': 'Coquimbo', 'V': 'Valparaíso', 'VI': "O'Higgins",
    'VII': 'Maule', 'VIII': 'Biobío', 'IX': 'Araucanía',
    'X': 'Los Lagos', 'XI': 'Aysén', 'XII': 'Magallanes',
    'XIII': 'Metropolitana', 'XIV': 'Los Ríos',
    'XV': 'Arica y Parinacota', 'XVI': 'Ñuble',
    'RM': 'Metropolitana', 'RMS': 'Metropolitana',
}
NUMERO_A_REGION = {
    '1': 'Tarapacá', '2': 'Antofagasta', '3': 'Atacama', '4': 'Coquimbo',
    '5': 'Valparaíso', '6': "O'Higgins", '7': 'Maule', '8': 'Biobío',
    '9': 'Araucanía', '10': 'Los Lagos', '11': 'Aysén', '12': 'Magallanes',
    '13': 'Metropolitana', '14': 'Los Ríos', '15': 'Arica y Parinacota', '16': 'Ñuble',
}
NOMBRE_A_REGION = {
    'arica': 'Arica y Parinacota', 'parinacota': 'Arica y Parinacota',
    'tarapaca': 'Tarapacá', 'tarapacá': 'Tarapacá',
    'antofagasta': 'Antofagasta', 'atacama': 'Atacama', 'coquimbo': 'Coquimbo',
    'valparaiso': 'Valparaíso', 'valparaíso': 'Valparaíso',
    'metropolitana': 'Metropolitana', 'santiago': 'Metropolitana', 'rm': 'Metropolitana',
    'ohiggins': "O'Higgins", "o'higgins": "O'Higgins", 'libertador': "O'Higgins",
    'maule': 'Maule', 'nuble': 'Ñuble', 'ñuble': 'Ñuble',
    'biobio': 'Biobío', 'biobío': 'Biobío', 'bio-bio': 'Biobío', 'bío-bío': 'Biobío',
    'araucania': 'Araucanía', 'araucanía': 'Araucanía',
    'losrios': 'Los Ríos', 'losríos': 'Los Ríos', 'los rios': 'Los Ríos', 'los ríos': 'Los Ríos',
    'loslagos': 'Los Lagos', 'los lagos': 'Los Lagos',
    'aysen': 'Aysén', 'aysén': 'Aysén',
    'magallanes': 'Magallanes', 'antartica': 'Magallanes', 'antártica': 'Magallanes',
}


# ── Utilities ─────────────────────────────────────────────────────────────────

def _add_months(dt, months):
    month = dt.month - 1 + months
    year  = dt.year + month // 12
    month = month % 12 + 1
    day   = min(dt.day, _calendar.monthrange(year, month)[1])
    return dt.replace(year=year, month=month, day=day)


def _parse_date_flexible(s):
    if not s:
        return None
    s = str(s).strip()
    for fmt, n in [
        ('%Y-%m-%d %H:%M:%S', 19), ('%Y-%m-%dT%H:%M:%S', 19),
        ('%Y-%m-%d', 10), ('%d-%m-%Y %H:%M:%S', 19),
        ('%d-%m-%Y', 10), ('%d/%m/%Y', 10),
    ]:
        try:
            return datetime.strptime(s[:n], fmt)
        except Exception:
            pass
    return None


def _clean_name(s):
    return ' '.join(s.split()) if s else ''


def _norm_nombre(s):
    s = (s or '').strip().lower()
    s = unicodedata.normalize('NFD', s)
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')
    return ' '.join(s.split())


# ── API client ────────────────────────────────────────────────────────────────

def api_get(path, params=None):
    params = dict(params or {})
    params['token'] = TOKEN
    url = f'{API_BASE}{path}'
    for attempt in range(3):
        try:
            resp = requests.get(url, params=params, timeout=30)
            resp.raise_for_status()
            return resp.json()
        except requests.HTTPError as e:
            code = e.response.status_code if e.response is not None else 0
            if code in (502, 503, 504) and attempt < 2:
                _time.sleep(1.5 ** attempt)
                continue
            raise
        except (requests.ConnectionError, requests.Timeout):
            if attempt < 2:
                _time.sleep(1.5 ** attempt)
                continue
            raise


def extract_datos(datos_list):
    result = {}
    for item in (datos_list or []):
        if isinstance(item, dict):
            result.update(item)
    return result


def parse_regiones(valor):
    if not valor:
        return []
    if isinstance(valor, list):
        items = [str(v).strip() for v in valor]
    else:
        sv = str(valor).strip()
        if sv.startswith('['):
            try:
                items = [str(v).strip() for v in _ast.literal_eval(sv)]
            except Exception:
                items = [sv.strip("[]'\" ")]
        else:
            items = [sv]
    result, seen = [], set()
    for item in items:
        item = item.strip().strip("'\" ")
        if not item:
            continue
        canon = (ROMAN_A_REGION.get(item.upper()) or
                 NUMERO_A_REGION.get(item) or
                 NOMBRE_A_REGION.get(item.lower().replace(' ', '').replace('-', '').replace('_', '')) or
                 NOMBRE_A_REGION.get(item.lower()))
        if not canon:
            kn = item.lower()
            for k, v in NOMBRE_A_REGION.items():
                if k in kn:
                    canon = v
                    break
        final = canon or item
        if final and final not in seen:
            seen.add(final)
            result.append(final)
    return result


# ── Tramite normalization ─────────────────────────────────────────────────────

def normalize_tramite(t):
    datos      = extract_datos(t.get('datos') or [])
    etapas     = t.get('etapas') or []
    etapa_actual = None
    etapas_info  = []
    completadas  = 0

    for etapa in etapas:
        estado_etapa = etapa.get('estado', '')
        ua = etapa.get('usuario_asignado') or {}
        nombre_ua = _clean_name(ua.get('nombres') or etapa.get('nombres') or '')
        nombre_completo_ua = _clean_name(
            f"{nombre_ua} {ua.get('apellido_paterno','')} {ua.get('apellido_materno','')}"
        )
        tarea = etapa.get('tarea') or {}
        info = {
            'id':               etapa.get('id'),
            'estado':           estado_etapa,
            'usuario':          ua.get('usuario') or etapa.get('usuario') or '',
            'email':            ua.get('email') or etapa.get('email') or '',
            'nombres':          nombre_completo_ua,
            'fecha_inicio':     etapa.get('fecha_inicio'),
            'fecha_termino':    etapa.get('fecha_termino'),
            'fecha_vencimiento':etapa.get('fecha_vencimiento'),
            'tarea_id':         tarea.get('id'),
            'tarea_nombre':     tarea.get('nombre', ''),
        }
        etapas_info.append(info)
        if estado_etapa == 'completado':
            completadas += 1
        if estado_etapa == 'pendiente' and etapa_actual is None:
            etapa_actual = info

    total_etapas = len(etapas)
    porcentaje   = int(completadas / total_etapas * 100) if total_etapas else 0

    email_sol = (
        datos.get('correo_electronico') or datos.get('correo_electronico_grabacion1') or
        datos.get('email') or datos.get('correo') or datos.get('mail') or ''
    )
    nombre_datos = _clean_name(
        datos.get('nombres_coordinador') or datos.get('nombre_coordinador') or
        datos.get('nombres') or datos.get('nombre') or ''
    )
    apellidos_datos = _clean_name(
        datos.get('apellidos_coordinador') or datos.get('apellidos') or
        (datos.get('paterno', '') + ' ' + datos.get('materno', ''))
    )
    nombre_completo = _clean_name(f'{nombre_datos} {apellidos_datos}')
    if not nombre_completo and etapas_info:
        submitter = etapas_info[-1]
        nombre_completo = submitter.get('nombres', '')
        if not email_sol:
            email_sol = submitter.get('email', '')

    region = (
        datos.get('region') or datos.get('region_id') or datos.get('zona') or
        datos.get('region_unidad') or datos.get('regional') or ''
    )
    if not region:
        for k in datos:
            lk = k.lower()
            for kw in ('arica','tarapaca','antofagasta','atacama','coquimbo','valparaiso',
                       'ohiggins','metropolitana','maule','nuble','biobio','araucania',
                       'losrios','loslagos','aysen','magallanes','parinacota'):
                if kw in lk.replace("'",'').replace(' ','').replace('-',''):
                    region = kw.title()
                    break
            if region:
                break

    _area_key_pat = _re.compile(r'^(area_protegida|[aá]rea_protegida|unidad|parque|reserva|monumento|santuario)', _re.I)
    _region_de_pat = _re.compile(r'^region_de(?:l)?_', _re.I)
    areas_protegidas, seen_areas = [], set()

    def _add_area(raw):
        if not raw:
            return
        val = str(raw).strip()
        if val.startswith('['):
            try:
                items = _ast.literal_eval(val)
            except Exception:
                try:
                    import json
                    items = json.loads(val)
                except Exception:
                    items = [val]
        else:
            items = [val]
        for item in items:
            human = str(item).replace('__', ' ').replace('_', ' ').strip().title()
            key = human.lower()
            if human and key not in seen_areas:
                seen_areas.add(key)
                areas_protegidas.append(human)

    for k, v in datos.items():
        if v:
            if _area_key_pat.match(k):
                _add_area(v)
            elif _region_de_pat.match(k) and str(v).strip().startswith('['):
                _add_area(v)

    # Borrador detection (needs partial dict first)
    _partial = {
        'etapas_completadas': completadas,
        'etapa_actual': etapa_actual,
        'email_solicitante': email_sol,
        'nombre_solicitante': nombre_completo,
    }
    borrador = es_borrador(_partial)

    regiones_list   = parse_regiones(region)
    region_display  = ', '.join(regiones_list) if regiones_list else str(region)

    def _email_es_conaf(email):
        e = (email or '').strip().lower()
        return e.endswith('@conaf.cl') or e.endswith('@conaf.gob.cl')

    _pat_rechazo = _re.compile(r'rechazo|rechaz', _re.I)
    estado_final = t.get('estado', '')
    recepcion_pendiente = False

    if estado_final != 'rechazado':
        for _e in etapas_info:
            if not _pat_rechazo.search(_e.get('tarea_nombre', '')):
                continue
            if _e.get('estado') == 'completado':
                estado_final = 'rechazado'
                break
            if _e.get('estado') == 'pendiente' and not _email_es_conaf(_e.get('email')):
                estado_final = 'rechazado'
                recepcion_pendiente = True
                break

    if estado_final == 'pendiente' and completadas > 0:
        pendientes = [e for e in etapas_info if e.get('estado') == 'pendiente']
        if pendientes and all(not _email_es_conaf(ep.get('email')) for ep in pendientes):
            recepcion_pendiente = True
            estado_final = 'completado'

    proceso_id_val = t.get('proceso_id')
    fecha_limite_proceso = None
    _fecha_envio = None
    for _e in etapas_info:
        if 'completar formulario' in (_e.get('tarea_nombre') or '').lower() or \
           'formulario de solicitud' in (_e.get('tarea_nombre') or '').lower():
            _fecha_envio = _e.get('fecha_termino')
            break
    fecha_base_str = _fecha_envio or t.get('fecha_inicio')
    if fecha_base_str and proceso_id_val in PROCESO_PLAZO_MESES:
        try:
            fi = datetime.strptime(str(fecha_base_str)[:19], '%Y-%m-%d %H:%M:%S')
            fl = _add_months(fi, PROCESO_PLAZO_MESES[proceso_id_val])
            fecha_limite_proceso = fl.strftime('%Y-%m-%d %H:%M:%S')
        except Exception:
            pass

    return {
        'id':                  t.get('id'),
        'estado':              estado_final,
        'proceso_id':          t.get('proceso_id'),
        'proceso_nombre':      t.get('proceso_nombre', ''),
        'fecha_inicio':        t.get('fecha_inicio'),
        'fecha_modificacion':  t.get('fecha_modificacion'),
        'fecha_termino':       t.get('fecha_termino'),
        'fecha_limite_proceso':fecha_limite_proceso,
        'nombre_solicitante':  nombre_completo,
        'email_solicitante':   email_sol,
        'region':              region_display,
        'regiones_list':       regiones_list,
        'porcentaje_avance':   porcentaje,
        'etapa_actual':        etapa_actual,
        'etapas':              etapas_info,
        'total_etapas':        total_etapas,
        'etapas_completadas':  completadas,
        'borrador':            borrador,
        'recepcion_pendiente': recepcion_pendiente,
        'areas_protegidas':    areas_protegidas,
        'archivo_autorizacion': (
            datos.get('autorizacion') or datos.get('autorizacion_firmada') or
            datos.get('resolucion') or datos.get('resolucion_aprobacion') or
            datos.get('documento_aprobacion') or None
        ),
        'etapa_autorizacion_id': next(
            (e['id'] for e in etapas_info if
             e.get('tarea_id') in (8715, 8752) or
             _re.search(r'adjunto|autori|firmad|aprob|resolu', e.get('tarea_nombre', ''), _re.I)),
            None
        ),
        'datos_raw': datos,
    }


def es_borrador(t):
    if t.get('etapas_completadas', 0) > 0:
        return False
    etapa_actual = t.get('etapa_actual') or {}
    if not etapa_actual:
        return False
    email_etapa = (etapa_actual.get('email') or '').strip().lower()
    email_sol   = (t.get('email_solicitante') or '').strip().lower()
    if email_etapa and email_sol and email_etapa == email_sol:
        return True
    nombre_etapa = _norm_nombre(etapa_actual.get('nombres', ''))
    nombre_sol   = _norm_nombre(t.get('nombre_solicitante', ''))
    if nombre_etapa and nombre_sol and nombre_etapa == nombre_sol:
        return True
    tarea = (etapa_actual.get('tarea_nombre') or '').strip()
    es_tarea_form = bool(_re.search(
        r'formulario\s+de\s+solicitud|formulario\s+solicitud|completar\s+formulario|'
        r'ingreso\s+solicitud|solicitud\s+ingreso|registro\s+solicitud', tarea, _re.I
    ))
    es_conaf = email_etapa.endswith('@conaf.cl') or email_etapa.endswith('@conaf.gob.cl')
    return es_tarea_form and not es_conaf


def es_tramite_visible(t):
    return not es_borrador(t)


# ── Fetching ──────────────────────────────────────────────────────────────────

def fetch_all_tramites(proceso_id=None, created_at_start=None, created_at_end=None,
                       updated_at_start=None, updated_at_end=None,
                       ended_at_start=None, ended_at_end=None, date_cutoff=None):
    all_items, page_token = [], None
    params = {'maxResults': 50}
    for k, v in [('created_at_start', created_at_start), ('created_at_end', created_at_end),
                 ('updated_at_start', updated_at_start), ('updated_at_end', updated_at_end),
                 ('ended_at_start', ended_at_start), ('ended_at_end', ended_at_end)]:
        if v:
            params[k] = v

    for _ in range(200):
        if page_token:
            params['pageToken'] = page_token
        path = f'/procesos/{proceso_id}/tramites' if proceso_id else '/tramites'
        data  = api_get(path, params)
        tdata = data.get('tramites') or {}
        items = tdata.get('items') or []

        if date_cutoff:
            page_valid, stop = [], False
            for item in items:
                fecha = item.get('fecha_inicio') or item.get('created_at') or ''
                if fecha:
                    try:
                        item_date = (datetime.fromtimestamp(fecha)
                                     if isinstance(fecha, (int, float))
                                     else datetime.fromisoformat(str(fecha)[:19]))
                        if item_date < date_cutoff:
                            stop = True
                            break
                    except Exception:
                        pass
                page_valid.append(item)
            all_items.extend(page_valid)
            if stop:
                break
        else:
            all_items.extend(items)

        page_token = tdata.get('nextPageToken')
        if not page_token:
            break

    return all_items


def fetch_all_processes():
    data  = api_get('/procesos')
    items = (data.get('procesos') or {}).get('items') or []
    return items


def extract_titulo(datos):
    return (
        datos.get('titulo_investigacion') or datos.get('titulo_de_la_investigacion') or
        datos.get('titulo_proyecto') or datos.get('titulo_del_proyecto') or
        datos.get('nombre_de_la_investigacion') or datos.get('nombre_investigacion') or
        datos.get('nombre_del_proyecto') or datos.get('nombre_proyecto') or
        datos.get('titulo') or ''
    )


def extract_texto_clasificacion(datos, titulo=''):
    fields = [
        titulo,
        datos.get('objetivos_del_proyecto'), datos.get('descripcion'),
        datos.get('descripcion_proyecto'), datos.get('objetivo_general'),
        datos.get('objetivos_especificos'), datos.get('actividades'),
        datos.get('actividades_a_realizar'), datos.get('palabras_clave'),
        datos.get('especie'), datos.get('especies'), datos.get('nombre_cientifico'),
        datos.get('tipo_investigacion'), datos.get('linea_investigacion'),
    ]
    return ' '.join(f for f in fields if f)


def extract_colecta(datos):
    return (
        datos.get('colecta_de_muestras') or datos.get('colecta_muestras') or
        datos.get('recoleccion_muestras') or datos.get('muestras_biologicas') or
        datos.get('colecta_material_biologico') or datos.get('colecta') or
        datos.get('tipo_colecta') or datos.get('requiere_colecta') or ''
    )
