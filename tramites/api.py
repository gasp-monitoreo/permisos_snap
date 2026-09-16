"""Django Ninja API — todos los endpoints de la plataforma SNAP."""
import io
import os
import re as _re
import unicodedata
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Optional

import requests as _requests
from django.conf import settings
from django.http import FileResponse, HttpResponse
from ninja import File, Form, NinjaAPI, UploadedFile

from .core import (
    INVESTIGACION_PROCESO_IDS, api_get, es_tramite_visible,
    fetch_all_processes, fetch_all_tramites, normalize_tramite,
)
from .email_utils import (
    GMAIL_AVAILABLE, _GMAIL_IMPORT_ERROR, email_html_body,
    get_gmail_creds, gmail_creds_file, create_gmail_draft, send_via_smtp,
)
from .excel_utils import build_compliance_excel, build_tramites_excel
from .fetcher import get_compliance_data, get_portada_historico_data, refresh_caches

INV_DIR       = settings.INVESTIGACIONES_DIR
INV_EXTENSIONS = {'.pdf', '.doc', '.docx', '.csv', '.xls', '.xlsx'}
DOMAIN        = 'https://conaf.cerofilas.gob.cl'

api = NinjaAPI(title='SNAP API', version='2.0', docs_url='/docs')


# ── Helpers ───────────────────────────────────────────────────────────────────

def _inv_archivos(base_path):
    result = []
    for root, dirs, files in os.walk(base_path):
        dirs.sort()
        for f in sorted(files):
            if f.startswith('.'):
                continue
            if os.path.splitext(f)[1].lower() not in INV_EXTENSIONS:
                continue
            full = os.path.join(root, f)
            rel  = os.path.relpath(full, INV_DIR).replace('\\', '/')
            result.append({
                'nombre': f,
                'url': '/investigaciones/' + rel,
                'size_kb': round(os.path.getsize(full) / 1024, 1),
            })
    return result


def _norm_nombre_carpeta(nombre: str) -> str:
    s = unicodedata.normalize('NFD', nombre or '')
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')
    s = _re.sub(r'[^\w\s]', '', s)
    return s.strip().replace(' ', '_') or 'Sin_Nombre'


def _carpeta_existente(nombre_carpeta: str):
    if not os.path.isdir(INV_DIR):
        return None
    tokens = nombre_carpeta.lower().split('_')
    for d in os.listdir(INV_DIR):
        if all(tok in d.lower() for tok in tokens if tok):
            return d
    return None


# ── Procesos ──────────────────────────────────────────────────────────────────

@api.get('/procesos')
def get_procesos(request):
    try:
        return {'ok': True, 'data': fetch_all_processes()}
    except Exception as e:
        return api.create_response(request, {'ok': False, 'error': str(e)}, status=500)


# ── Trámites ──────────────────────────────────────────────────────────────────

@api.get('/tramites')
def get_tramites(
    request,
    proceso_id: Optional[int] = None,
    created_at_start: Optional[str] = None,
    created_at_end: Optional[str]   = None,
    updated_at_start: Optional[str] = None,
    updated_at_end: Optional[str]   = None,
    ended_at_start: Optional[str]   = None,
    ended_at_end: Optional[str]     = None,
):
    try:
        date_cutoff = None
        if created_at_start:
            try:
                date_cutoff = datetime.fromtimestamp(int(created_at_start))
            except Exception:
                pass
        raw = fetch_all_tramites(
            proceso_id=proceso_id,
            created_at_start=created_at_start, created_at_end=created_at_end,
            updated_at_start=updated_at_start, updated_at_end=updated_at_end,
            ended_at_start=ended_at_start, ended_at_end=ended_at_end,
            date_cutoff=date_cutoff,
        )
        normalized = [normalize_tramite(t) for t in raw]
        normalized = [t for t in normalized if es_tramite_visible(t)]
        return {'ok': True, 'data': normalized, 'total': len(normalized)}
    except Exception as e:
        return api.create_response(request, {'ok': False, 'error': str(e)}, status=500)


@api.get('/tramites/{tramite_id}')
def get_tramite(request, tramite_id: int):
    try:
        data = api_get(f'/tramites/{tramite_id}')
        t    = data.get('tramite', data)
        return {'ok': True, 'data': normalize_tramite(t)}
    except _requests.HTTPError as e:
        status = e.response.status_code if e.response is not None else 500
        return api.create_response(request, {'ok': False, 'error': str(e)}, status=status)
    except Exception as e:
        return api.create_response(request, {'ok': False, 'error': str(e)}, status=500)


# ── Cache ─────────────────────────────────────────────────────────────────────

@api.post('/cache/refresh')
def cache_refresh(request):
    refresh_caches()
    return {'ok': True, 'msg': 'Regeneración en background iniciada.'}


# ── Portada historico ─────────────────────────────────────────────────────────

@api.get('/portada/historico')
def portada_historico(request):
    try:
        data = get_portada_historico_data()
        return {'ok': True, 'data': data, 'total': len(data)}
    except Exception as e:
        return api.create_response(request, {'ok': False, 'error': str(e)}, status=500)


# ── Compliance ────────────────────────────────────────────────────────────────

@api.get('/compliance/investigacion')
def compliance_investigacion(request):
    try:
        resultados, revisados = get_compliance_data()
        return {'ok': True, 'data': resultados, 'total': len(resultados),
                'candidatos_revisados': revisados}
    except Exception as e:
        return api.create_response(request, {'ok': False, 'error': str(e)}, status=500)


# ── Export Excel ──────────────────────────────────────────────────────────────

@api.get('/export/excel')
def export_excel(
    request,
    proceso_id: Optional[int]   = None,
    created_at_start: Optional[str] = None,
    created_at_end: Optional[str]   = None,
    ended_at_start: Optional[str]   = None,
    ended_at_end: Optional[str]     = None,
    estado: Optional[str]           = None,
):
    try:
        raw = fetch_all_tramites(
            proceso_id=proceso_id,
            created_at_start=created_at_start, created_at_end=created_at_end,
            ended_at_start=ended_at_start, ended_at_end=ended_at_end,
        )
        tramites = [normalize_tramite(t) for t in raw]
        tramites = [t for t in tramites if es_tramite_visible(t)]
        if estado:
            tramites = [t for t in tramites if t['estado'] == estado]

        try:
            procesos = fetch_all_processes()
            proceso_map = {
                (p.get('proceso', p).get('id') if 'proceso' in p else p.get('id')):
                (p.get('proceso', p).get('nombre') if 'proceso' in p else p.get('nombre'))
                for p in procesos
            }
        except Exception:
            proceso_map = {}

        buf      = build_tramites_excel(tramites, proceso_map)
        filename = f"tramites_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx"
        resp = HttpResponse(
            buf.read(),
            content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        )
        resp['Content-Disposition'] = f'attachment; filename="{filename}"'
        return resp
    except Exception as e:
        return api.create_response(request, {'ok': False, 'error': str(e)}, status=500)


@api.get('/export/compliance/excel')
def export_compliance_excel(request):
    try:
        resultados, _ = get_compliance_data()
        buf      = build_compliance_excel(resultados)
        filename = f"incumplimiento_numeral6_{datetime.now().strftime('%Y%m%d')}.xlsx"
        resp = HttpResponse(
            buf.read(),
            content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        )
        resp['Content-Disposition'] = f'attachment; filename="{filename}"'
        return resp
    except Exception as e:
        return api.create_response(request, {'ok': False, 'error': str(e)}, status=500)


# ── Adjuntos ──────────────────────────────────────────────────────────────────

def _candidatos_archivo(archivo, tramite_id=''):
    TOKEN = settings.CEROFILAS_TOKEN
    API   = settings.CEROFILAS_API_BASE
    return [c for c in [
        f'{DOMAIN}/backend/storage/{archivo}',
        f'{DOMAIN}/backend/storage/app/public/{archivo}',
        f'{DOMAIN}/storage/{archivo}',
        f'{DOMAIN}/storage/app/public/{archivo}',
        f'{API}/archivos/{archivo}',
        f'{API}/uploads/{archivo}',
        (f'{API}/tramites/{tramite_id}/archivos/{archivo}' if tramite_id else None),
        f'{API}/files/{archivo}',
        f'{API}/download/{archivo}',
    ] if c]


def _descargar_url(url):
    TOKEN = settings.CEROFILAS_TOKEN
    for kwargs in [
        {'params': {'token': TOKEN}},
        {'headers': {'Authorization': f'Bearer {TOKEN}'}},
    ]:
        try:
            r = _requests.get(url, timeout=30, **kwargs)
            if r.status_code == 200:
                ct = r.headers.get('Content-Type', 'application/octet-stream')
                if 'text/html' not in ct:
                    return r, ct
        except Exception:
            pass
    return None, None


@api.get('/adjunto')
def descargar_adjunto(
    request,
    url: Optional[str]      = None,
    archivo: Optional[str]  = None,
    tramite_id: Optional[str] = None,
    nombre: str             = 'archivo',
):
    if not url and not archivo:
        return api.create_response(request, {'ok': False, 'error': 'Se requiere url o archivo'}, status=400)
    if url:
        if not url.startswith(DOMAIN):
            return api.create_response(request, {'ok': False, 'error': 'URL no permitida'}, status=403)
        candidatos = [url]
    else:
        candidatos = _candidatos_archivo(archivo, tramite_id or '')

    for candidate in candidatos:
        resp, ct = _descargar_url(candidate)
        if resp is not None:
            http_resp = HttpResponse(resp.content, content_type=ct)
            http_resp['Content-Disposition'] = f'attachment; filename="{nombre}"'
            return http_resp

    return api.create_response(request, {'ok': False, 'error': f"No se pudo descargar '{archivo}'"}, status=502)


@api.get('/adjunto/debug')
def debug_adjunto(request, archivo: str, tramite_id: Optional[str] = None):
    TOKEN = settings.CEROFILAS_TOKEN
    if not archivo:
        return api.create_response(request, {'ok': False, 'error': 'Falta archivo'}, status=400)
    resultados = []
    for url in _candidatos_archivo(archivo, tramite_id or ''):
        for kwargs, modo in [
            ({'params': {'token': TOKEN}}, 'token_param'),
            ({'headers': {'Authorization': f'Bearer {TOKEN}'}}, 'bearer_header'),
        ]:
            try:
                r = _requests.get(url, timeout=10, **kwargs)
                resultados.append({'url': url, 'modo': modo, 'status': r.status_code,
                                   'content_type': r.headers.get('Content-Type', '')})
            except Exception as e:
                resultados.append({'url': url, 'modo': modo, 'error': str(e)})
    return {'ok': True, 'archivo': archivo, 'resultados': resultados}


# ── Search by area ────────────────────────────────────────────────────────────

@api.get('/search/area')
def search_by_area(
    request, q: str,
    year_from: Optional[int] = None,
    year_to: Optional[int]   = None,
):
    q = q.strip().lower()
    if len(q) < 2:
        return api.create_response(request, {'ok': False, 'error': 'Ingrese al menos 2 caracteres'}, status=400)

    now = datetime.now()
    year_from = max(2019, min(year_from or now.year, now.year))
    year_to   = max(year_from, min(year_to or now.year, now.year))

    created_at_start = str(int(datetime(year_from, 1, 1).timestamp()))
    created_at_end   = str(int(datetime(year_to, 12, 31, 23, 59, 59).timestamp()))

    raw_list = fetch_all_tramites(created_at_start=created_at_start, created_at_end=created_at_end)
    if not raw_list:
        raw_list = fetch_all_tramites()
    tramite_ids = [t.get('id') for t in raw_list if t.get('id')]

    def fetch_and_check(tid):
        try:
            data   = api_get(f'/tramites/{tid}')
            t      = data.get('tramite', data)
            norm   = normalize_tramite(t)
            datos  = norm.get('datos_raw', {})
            areas  = ' '.join(norm.get('areas_protegidas', [])).lower()
            for k, v in datos.items():
                if k.lower().startswith('region_de_'):
                    areas += ' ' + str(v).lower()
            return norm if q in areas else None
        except Exception:
            return None

    results = []
    if tramite_ids:
        with ThreadPoolExecutor(max_workers=min(30, len(tramite_ids))) as ex:
            futs = {ex.submit(fetch_and_check, tid): tid for tid in tramite_ids}
            for fut in as_completed(futs):
                r = fut.result()
                if r:
                    results.append(r)

    results = [t for t in results if es_tramite_visible(t)]
    results.sort(key=lambda x: x.get('fecha_inicio') or '', reverse=True)
    return {'ok': True, 'data': results, 'total': len(results),
            'searched': len(tramite_ids), 'year_from': year_from, 'year_to': year_to}


# ── Email ─────────────────────────────────────────────────────────────────────

@api.post('/email/send')
def send_email_route(request):
    import smtplib
    data = request.body and __import__('json').loads(request.body) or {}
    smtp = data.get('smtp', {})
    em   = data.get('email', {})
    missing = [k for k in ('smtp_server','smtp_port','smtp_user','smtp_pass','from_email') if not smtp.get(k)]
    if missing:
        return api.create_response(request, {'ok': False, 'error': f"Faltan campos SMTP: {', '.join(missing)}"}, status=400)
    if not em.get('to_email'):
        return api.create_response(request, {'ok': False, 'error': 'Falta email del destinatario'}, status=400)
    try:
        send_via_smtp(smtp, em)
        return {'ok': True}
    except smtplib.SMTPAuthenticationError:
        return api.create_response(request, {'ok': False, 'error': 'Contraseña incorrecta. Gmail requiere Contraseña de Aplicación.'}, status=401)
    except smtplib.SMTPConnectError as e:
        return api.create_response(request, {'ok': False, 'error': f'No se pudo conectar al servidor SMTP: {e}'}, status=503)
    except Exception as e:
        return api.create_response(request, {'ok': False, 'error': str(e)}, status=500)


@api.get('/auth/gmail/status')
def gmail_auth_status(request):
    if not GMAIL_AVAILABLE:
        err = f' ({_GMAIL_IMPORT_ERROR})' if _GMAIL_IMPORT_ERROR else ''
        return {'ok': False, 'error': f'Librerías Google no disponibles{err}'}
    if not os.path.exists(gmail_creds_file()):
        return {'ok': False, 'error': 'Falta gmail_auth/credentials.json en el servidor'}
    creds = get_gmail_creds()
    return {'ok': True, 'authenticated': creds is not None}


@api.post('/email/draft')
def create_draft_route(request):
    data = request.body and __import__('json').loads(request.body) or {}
    em   = data.get('email', {})
    if not GMAIL_AVAILABLE:
        return api.create_response(request, {'ok': False, 'error': 'Librerías Google no instaladas'}, status=500)
    if not os.path.exists(gmail_creds_file()):
        return api.create_response(request, {'ok': False, 'error': 'NO_CREDS'}, status=400)
    if not em.get('to_email'):
        return api.create_response(request, {'ok': False, 'error': 'Falta email del destinatario'}, status=400)
    try:
        draft_id, err = create_gmail_draft(em)
        if err:
            return api.create_response(request, {'ok': False, 'error': err}, status=401)
        return {'ok': True, 'draft_id': draft_id}
    except Exception as e:
        return api.create_response(request, {'ok': False, 'error': str(e)}, status=500)


# ── Investigaciones ───────────────────────────────────────────────────────────

@api.get('/investigaciones/index')
def investigaciones_index(request):
    if not os.path.isdir(INV_DIR):
        return {'ok': True, 'data': {}}
    result = {}
    for investigador in sorted(os.listdir(INV_DIR)):
        inv_path = os.path.join(INV_DIR, investigador)
        if not os.path.isdir(inv_path) or investigador.startswith(('.', '_')):
            continue
        sub_dirs = [d for d in os.listdir(inv_path)
                    if os.path.isdir(os.path.join(inv_path, d)) and d.isdigit()]
        if sub_dirs:
            ids_data = {tid: _inv_archivos(os.path.join(inv_path, tid))
                        for tid in sorted(sub_dirs, key=int)}
            result[investigador] = {'tipo': 'nested', 'ids': ids_data}
        else:
            result[investigador] = {'tipo': 'flat', 'archivos': _inv_archivos(inv_path)}
    return {'ok': True, 'data': result}


@api.get('/investigaciones/archivos/{nombre}/{tramite_id}')
def investigaciones_archivos_id(request, nombre: str, tramite_id: str):
    carpeta = os.path.join(INV_DIR, nombre, tramite_id)
    if not os.path.abspath(carpeta).startswith(os.path.abspath(INV_DIR)):
        return api.create_response(request, {'ok': False}, status=403)
    if not os.path.isdir(carpeta):
        return {'ok': True, 'archivos': []}
    return {'ok': True, 'archivos': _inv_archivos(carpeta)}


@api.post('/investigaciones/upload')
def investigaciones_upload(
    request,
    nombre: Form[str],
    tramite_id: Form[str],
    archivos: List[UploadedFile] = File(None),
):
    if not nombre or not tramite_id:
        return api.create_response(request, {'ok': False, 'error': 'Faltan parámetros'}, status=400)

    nombre_carpeta = _norm_nombre_carpeta(nombre)
    existente      = _carpeta_existente(nombre_carpeta)
    carpeta_base   = existente if existente else nombre_carpeta
    destino        = os.path.join(INV_DIR, carpeta_base, str(tramite_id))
    os.makedirs(destino, exist_ok=True)

    guardados, errores = [], []
    for f in (archivos or []):
        if not f or not f.name:
            continue
        fname = _re.sub(r'[^\w\.\-\(\) ]', '_', f.name).strip()
        if not fname:
            continue
        ext = os.path.splitext(fname)[1].lower()
        if ext not in INV_EXTENSIONS:
            errores.append(f'{f.name}: extensión no permitida ({ext})')
            continue
        try:
            dest = os.path.join(destino, fname)
            with open(dest, 'wb') as out:
                for chunk in f.chunks():
                    out.write(chunk)
            guardados.append(fname)
        except Exception as exc:
            errores.append(f'{fname}: {exc}')

    return {'ok': True, 'guardados': guardados, 'errores': errores,
            'carpeta': f'{carpeta_base}/{tramite_id}'}


# ── Traducción ────────────────────────────────────────────────────────────────

@api.post('/translate')
def translate_text(request):
    data  = request.body and __import__('json').loads(request.body) or {}
    texto = data.get('text', '').strip()
    if not texto:
        return {'ok': True, 'traduccion': texto}
    try:
        resp = _requests.get(
            'https://api.mymemory.translated.net/get',
            params={'q': texto, 'langpair': 'en|es', 'de': 'ignacio.diaz@conaf.cl'},
            timeout=6,
        )
        data      = resp.json()
        traduccion = data.get('responseData', {}).get('translatedText', texto)
        return {'ok': True, 'traduccion': traduccion}
    except Exception as exc:
        return {'ok': False, 'error': str(exc), 'traduccion': texto}
