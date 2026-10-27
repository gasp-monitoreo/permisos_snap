"""Google Drive integration — lista archivos de una carpeta Drive."""
import re
import os
import time
import threading

DRIVE_FOLDER_ID = '1f3xBX0kp1MhAiVErdZ1DZ-cS45Av5ZCW'
DRIVE_EXTENSIONS = {'.pdf', '.doc', '.docx', '.csv', '.xls', '.xlsx'}
_CACHE_TTL = 1800  # 30 min

_cache = {'ts': 0, 'data': None}
_lock  = threading.Lock()


def _token_file():
    from django.conf import settings
    return os.path.join(settings.GMAIL_AUTH_DIR, 'token.json')


def get_drive_service():
    """Retorna el servicio Drive v3 usando el token OAuth guardado."""
    try:
        from google.oauth2.credentials import Credentials
        from google.auth.transport.requests import Request as GReq
        from googleapiclient.discovery import build as gbuild
    except ImportError:
        return None, 'Librerías Google no instaladas'

    tf = _token_file()
    if not os.path.exists(tf):
        return None, 'Sin token OAuth. Autentícate en /auth/gmail/start'

    try:
        scopes = [
            'https://www.googleapis.com/auth/gmail.compose',
            'https://www.googleapis.com/auth/drive.readonly',
        ]
        creds = Credentials.from_authorized_user_file(tf, scopes)
        if creds.expired and creds.refresh_token:
            creds.refresh(GReq())
            with open(tf, 'w') as f:
                f.write(creds.to_json())
        if not creds.valid:
            return None, 'Token expirado o inválido'
        svc = gbuild('drive', 'v3', credentials=creds)
        return svc, None
    except Exception as e:
        return None, str(e)


def _list_items(service, folder_id):
    """Lista hijos directos de un folder (archivos y subcarpetas)."""
    items, page_token = [], None
    while True:
        resp = service.files().list(
            q=f"'{folder_id}' in parents and trashed=false",
            fields='nextPageToken, files(id, name, mimeType, size)',
            orderBy='name',
            pageSize=200,
            pageToken=page_token,
        ).execute()
        items.extend(resp.get('files', []))
        page_token = resp.get('nextPageToken')
        if not page_token:
            break
    return items


# Archivos de sistema que se cuelan al copiar carpetas desde un Mac o Windows (no son entregas)
_BASURA = re.compile(r'^(\._|\.DS_Store$|Thumbs\.db$|desktop\.ini$|~\$)', re.I)


def es_basura(nombre):
    return bool(_BASURA.match(nombre or ''))


def _file_entry(f):
    ext = os.path.splitext(f['name'])[1].lower()
    if ext not in DRIVE_EXTENSIONS:
        return None
    size_kb = round(int(f.get('size') or 0) / 1024, 1)
    return {
        'nombre':   f['name'],
        'url':      f'https://drive.google.com/file/d/{f["id"]}/view',
        'size_kb':  size_kb,
        'drive_id': f['id'],
    }


def build_index(service, folder_id):
    """
    Construye un índice igual al de /api/investigaciones/index a partir de Drive.

    Estructura esperada en Drive:
      <folder_id>/
        Apellido_Nombre/          ← carpeta por investigador
          <tramite_id>/           ← subcarpeta con nombre numérico
            archivo.pdf
          otro.pdf                ← o archivos directos (estructura flat)

    Para carpetas flat, se consulta DriveFolderMap para obtener el tramite_id
    asignado manualmente.
    """
    from .models import DriveFolderMap
    folder_map = {m.folder_name: m.tramite_ids
                  for m in DriveFolderMap.objects.all()}

    result = {}
    for inv in _list_items(service, folder_id):
        FOLDER = 'application/vnd.google-apps.folder'
        if inv['mimeType'] != FOLDER:
            continue

        children  = _list_items(service, inv['id'])
        id_fldrs  = [c for c in children if c['mimeType'] == FOLDER and c['name'].isdigit()]

        if id_fldrs:
            ids_data = {}
            for idf in id_fldrs:
                archivos = [_file_entry(f) for f in _list_items(service, idf['id'])
                            if f['mimeType'] != FOLDER and not es_basura(f['name'])]
                archivos = [a for a in archivos if a]
                if archivos:
                    ids_data[idf['name']] = archivos
            if ids_data:
                result[inv['name']] = {'tipo': 'nested', 'ids': ids_data}
        else:
            archivos = [_file_entry(f) for f in children if f['mimeType'] != FOLDER and not es_basura(f['name'])]
            archivos = [a for a in archivos if a]
            if archivos:
                mapped_ids = folder_map.get(inv['name'], [])
                if mapped_ids:
                    ids_data = {str(tid): archivos for tid in mapped_ids}
                    result[inv['name']] = {'tipo': 'mapped', 'ids': ids_data}
                else:
                    result[inv['name']] = {'tipo': 'flat', 'archivos': archivos}

    return result


_DJ_KEY = 'drive:index'
_refrescando = threading.Event()


def _descargar_index():
    """Construye el índice desde Drive y lo guarda en la caché de Django (Postgres)."""
    from django.core.cache import cache
    svc, err = get_drive_service()
    if err:
        return None, 'needs_auth' if 'invalid_grant' in str(err) else err
    try:
        data = build_index(svc, DRIVE_FOLDER_ID)
    except Exception as e:
        err_str = str(e)
        if '403' in err_str or 'insufficient' in err_str.lower() or 'forbidden' in err_str.lower():
            return None, 'needs_auth'
        return None, err_str
    entrada = {'ts': time.time(), 'data': data}
    cache.set(_DJ_KEY, entrada, 30 * 24 * 3600)
    with _lock:
        _cache.update(entrada)
    return data, None


def _refrescar_en_segundo_plano():
    if _refrescando.is_set():
        return
    _refrescando.set()

    def run():
        try:
            _descargar_index()
        finally:
            _refrescando.clear()

    threading.Thread(target=run, daemon=True).start()


def get_cached_index():
    """Índice Drive con stale-while-revalidate: memoria → Postgres → Drive.

    Si tiene más de 30 min se sirve igual y se reconstruye en segundo plano;
    solo se espera a Drive cuando no hay ninguna copia guardada.
    """
    from django.core.cache import cache
    with _lock:
        entrada = dict(_cache) if _cache['data'] is not None else None
    if entrada is None:
        entrada = cache.get(_DJ_KEY)
        if entrada:
            with _lock:
                _cache.update(entrada)
    if entrada is None:
        return _descargar_index()
    if time.time() - entrada['ts'] > _CACHE_TTL:
        _refrescar_en_segundo_plano()
    return entrada['data'], None


def invalidate_cache():
    from django.core.cache import cache
    cache.delete(_DJ_KEY)
    with _lock:
        _cache.update({'ts': 0, 'data': None})
