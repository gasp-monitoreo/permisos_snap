"""Google Drive integration — lista archivos de una carpeta Drive."""
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
    """
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
                            if f['mimeType'] != FOLDER]
                archivos = [a for a in archivos if a]
                if archivos:
                    ids_data[idf['name']] = archivos
            if ids_data:
                result[inv['name']] = {'tipo': 'nested', 'ids': ids_data}
        else:
            archivos = [_file_entry(f) for f in children if f['mimeType'] != FOLDER]
            archivos = [a for a in archivos if a]
            if archivos:
                result[inv['name']] = {'tipo': 'flat', 'archivos': archivos}

    return result


def get_cached_index():
    """Retorna el índice Drive cacheado (30 min TTL)."""
    with _lock:
        if _cache['data'] is not None and (time.time() - _cache['ts']) < _CACHE_TTL:
            return _cache['data'], None

    svc, err = get_drive_service()
    if err:
        return None, err

    try:
        data = build_index(svc, DRIVE_FOLDER_ID)
    except Exception as e:
        err_str = str(e)
        if '403' in err_str or 'insufficient' in err_str.lower() or 'forbidden' in err_str.lower():
            return None, 'needs_auth'
        return None, err_str

    with _lock:
        _cache.update({'ts': time.time(), 'data': data})
    return data, None


def invalidate_cache():
    with _lock:
        _cache.update({'ts': 0, 'data': None})
