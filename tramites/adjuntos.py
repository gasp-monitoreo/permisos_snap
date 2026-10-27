"""Archivos adjuntos de los trámites, servidos por la plataforma (sin cuenta en Cero Filas).

Cero Filas publica los adjuntos de los formularios (documento de proyecto, CV, cartas,
autorización o resolución, etc.) en https://conaf.cerofilas.gob.cl/uploads/datos/<archivo>.
La plataforma los trae desde ahí y los entrega a quien tiene permiso para ver el trámite:
  - el nombre del archivo se toma siempre del propio trámite (nunca del navegador);
  - se guardan en una caché temporal en disco (7 días, máx. 2 GB) con nombre opaco;
  - cada descarga queda registrada (hay datos personales: cédulas, CV, certificados).
"""
import csv
import hashlib
import io
import logging
import os
import re
import time
import unicodedata
import zipfile
from concurrent.futures import ThreadPoolExecutor

import requests
from django.conf import settings

log = logging.getLogger(__name__)

BASE_ADJUNTOS = 'https://conaf.cerofilas.gob.cl/uploads/datos/'
NOMBRE_VALIDO = re.compile(r'^[A-Za-z0-9_-]{8,64}\.(pdf|docx?|xlsx?|jpe?g|png|zip|odt|pptx|csv)$', re.I)
CLAVES_RESOLUCION = ('autorizacion', 'autorizacion_firmada', 'resolucion', 'resolucion_aprobacion', 'documento_aprobacion')
VIGENCIA_SEG = 7 * 24 * 3600
TOPE_CACHE = 2 * 1024 ** 3
MAX_ARCHIVO = 60 * 1024 * 1024
MAX_ZIP_TRAMITES = 150
TIPOS = {'pdf': 'application/pdf', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png'}
EN_NAVEGADOR = {'pdf', 'jpg', 'jpeg', 'png'}


class AdjuntoError(Exception):
    def __init__(self, mensaje, status):
        super().__init__(mensaje)
        self.status = status


def _dir():
    d = getattr(settings, 'ADJUNTOS_CACHE_DIR', os.path.join(settings.BASE_DIR, 'cache_adjuntos'))
    os.makedirs(d, exist_ok=True)
    return d


def extension(archivo):
    return archivo.rsplit('.', 1)[-1].lower()


def es_adjunto(valor):
    return isinstance(valor, str) and bool(NOMBRE_VALIDO.match(valor))


def adjuntos_de(t):
    """[(clave, archivo)] de los adjuntos del trámite; la resolución primero."""
    lista = [(k, v) for k, v in (t.get('datos_raw') or {}).items() if es_adjunto(v)]
    return sorted(lista, key=lambda kv: kv[0] not in CLAVES_RESOLUCION)


def resolucion_de(t):
    datos = t.get('datos_raw') or {}
    return next(((k, datos[k]) for k in CLAVES_RESOLUCION if es_adjunto(datos.get(k))), None)


def _limpiar_cache(d):
    ahora, archivos = time.time(), []
    for nombre in os.listdir(d):
        ruta = os.path.join(d, nombre)
        try:
            st = os.stat(ruta)
        except OSError:
            continue
        if ahora - st.st_mtime > VIGENCIA_SEG:
            os.remove(ruta)
        else:
            archivos.append((st.st_mtime, st.st_size, ruta))
    total = sum(a[1] for a in archivos)
    for _, tam, ruta in sorted(archivos):        # los más antiguos primero
        if total <= TOPE_CACHE:
            break
        os.remove(ruta)
        total -= tam


def contenido(archivo):
    """Bytes del adjunto (desde la caché o desde Cero Filas)."""
    if not es_adjunto(archivo):
        raise AdjuntoError('Archivo no válido.', 404)
    d = _dir()
    ruta = os.path.join(d, hashlib.sha256(archivo.encode()).hexdigest())
    try:
        if time.time() - os.path.getmtime(ruta) < VIGENCIA_SEG:
            with open(ruta, 'rb') as f:
                return f.read()
    except OSError:
        pass
    try:
        r = requests.get(BASE_ADJUNTOS + archivo, timeout=40, allow_redirects=False, stream=True)
    except requests.RequestException:
        raise AdjuntoError('Cero Filas no responde. Intente en unos minutos.', 502)
    if r.status_code != 200 or 'text/html' in (r.headers.get('Content-Type') or ''):
        raise AdjuntoError('Cero Filas no tiene este archivo.', 404 if r.status_code == 404 else 502)
    datos = r.raw.read(MAX_ARCHIVO + 1, decode_content=True)
    if len(datos) > MAX_ARCHIVO:
        raise AdjuntoError('El archivo es demasiado grande.', 413)
    tmp = ruta + '.tmp'
    with open(tmp, 'wb') as f:
        f.write(datos)
    os.replace(tmp, ruta)
    try:
        _limpiar_cache(d)
    except OSError:
        pass
    return datos


def contenido_protegido(archivo, clave):
    """Versión para usuarios sin rol Editor (Ley N°21.719): PDF con los datos tachados;
    documentos de identidad y formatos que no se pueden tachar con seguridad, no."""
    from .privacidad import CLAVE_DOC_IDENTIDAD, NoRedactable, pdf_redactado
    if CLAVE_DOC_IDENTIDAD.search(clave or ''):
        raise AdjuntoError('Documento de identidad o con datos personales: requiere rol Editor o superior.', 403)
    if extension(archivo) != 'pdf':
        raise AdjuntoError('Este formato no se puede tachar de forma segura: requiere rol Editor o superior.', 403)
    d = _dir()
    ruta = os.path.join(d, hashlib.sha256(('protegido|' + archivo).encode()).hexdigest())
    try:
        if time.time() - os.path.getmtime(ruta) < VIGENCIA_SEG:
            with open(ruta, 'rb') as f:
                return f.read()
    except OSError:
        pass
    try:
        datos = pdf_redactado(contenido(archivo))
    except NoRedactable:
        raise AdjuntoError('Documento escaneado: no se puede tachar de forma segura. Requiere rol Editor o superior.', 403)
    except AdjuntoError:
        raise
    except Exception:
        log.exception('No se pudo tachar %s', archivo)
        raise AdjuntoError('No se pudo preparar la versión protegida del documento.', 403)
    with open(ruta + '.tmp', 'wb') as f:
        f.write(datos)
    os.replace(ruta + '.tmp', ruta)
    return datos


def _datos(archivo, clave, proteger):
    return contenido_protegido(archivo, clave) if proteger else contenido(archivo)


def _seguro(texto, largo=60):
    t = unicodedata.normalize('NFKD', str(texto or '')).encode('ascii', 'ignore').decode()
    return re.sub(r'[^A-Za-z0-9]+', '_', t).strip('_')[:largo] or 'archivo'


def nombre_descarga(tramite_id, clave, archivo):
    return f'{int(tramite_id)}_{_seguro(clave, 50)}.{extension(archivo)}'


def respuesta(tramite_id, clave, archivo, usuario, proteger=False):
    from django.http import HttpResponse
    datos = _datos(archivo, clave, proteger)
    ext = extension(archivo)
    r = HttpResponse(datos, content_type=TIPOS.get(ext, 'application/octet-stream'))
    modo = 'inline' if ext in EN_NAVEGADOR else 'attachment'
    r['Content-Disposition'] = f'{modo}; filename="{nombre_descarga(tramite_id, clave, archivo)}"'
    r['X-Content-Type-Options'] = 'nosniff'
    r['Cache-Control'] = 'private, max-age=3600'
    r['X-Frame-Options'] = 'SAMEORIGIN'      # la ficha muestra la resolución en un visor dentro de la página
    log.info('Adjunto descargado: trámite %s, campo %s, usuario %s%s', tramite_id, clave, getattr(usuario, 'pk', '?'),
             ' (versión protegida)' if proteger else '')
    return r


def zip_tramite(t, usuario, proteger=False):
    """ZIP con todos los adjuntos de un trámite (sin rol Editor: versiones protegidas)."""
    buf = io.BytesIO()
    faltan = []
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        for clave, archivo in adjuntos_de(t):
            try:
                z.writestr(nombre_descarga(t['id'], clave, archivo), _datos(archivo, clave, proteger))
            except AdjuntoError as e:
                faltan.append(f'{clave}: {e}')
        if faltan:
            z.writestr('NO_INCLUIDOS.txt', 'Documentos no incluidos:\n' + '\n'.join(faltan))
    log.info('ZIP de adjuntos: trámite %s, usuario %s', t['id'], getattr(usuario, 'pk', '?'))
    return buf.getvalue()


def zip_resoluciones(tramites, usuario, proteger=False):
    """ZIP con la resolución de cada trámite (carpeta por región) y un índice CSV."""
    filas, tareas = [], []
    for t in tramites[:MAX_ZIP_TRAMITES]:
        res = resolucion_de(t)
        region = (t.get('regiones_list') or ['Sin region'])
        carpeta = _seguro(region[0] if len(region) == 1 else 'Varias regiones', 40)
        nombre = f"{carpeta}/{t['id']}_{_seguro(t.get('nombre_solicitante'), 40)}.{extension(res[1]) if res else 'pdf'}"
        filas.append({'t': t, 'res': res, 'ruta': nombre})
        if res:
            tareas.append((len(filas) - 1, res[1]))

    def traer(item):
        i, archivo = item
        try:
            return i, _datos(archivo, 'autorizacion', proteger)
        except AdjuntoError:
            return i, None
    with ThreadPoolExecutor(max_workers=4) as ex:
        bytes_por = dict(ex.map(traer, tareas))

    from .core import extract_titulo
    buf, indice = io.BytesIO(), io.StringIO()
    w = csv.writer(indice)
    w.writerow(['ID', 'Solicitante', 'Título', 'Áreas protegidas', 'Regiones', 'Fecha de ingreso', 'Archivo en el ZIP'])
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        for i, f in enumerate(filas):
            t, datos = f['t'], bytes_por.get(i)
            if datos is not None:
                z.writestr(f['ruta'], datos)
            w.writerow([t['id'], t.get('nombre_solicitante') or '', extract_titulo(t.get('datos_raw') or {}),
                        ', '.join(t.get('areas_protegidas') or []), ', '.join(t.get('regiones_list') or []),
                        (t.get('fecha_inicio') or '')[:10],
                        f['ruta'] if datos is not None else ('(sin resolución adjunta)' if not f['res'] else '(no disponible en Cero Filas)')])
        z.writestr('indice.csv', '﻿' + indice.getvalue())   # BOM: Excel abre bien las tildes
    log.info('ZIP de resoluciones: %s trámites, usuario %s', len(filas), getattr(usuario, 'pk', '?'))
    return buf.getvalue()


def tramite_vivo(tramite_id):
    """Trámite normalizado desde Cero Filas (caché de 10 minutos)."""
    from django.core.cache import cache
    from .core import api_get, normalize_tramite
    clave = f'adjuntos:tramite:{int(tramite_id)}'
    t = cache.get(clave)
    if t is None:
        data = api_get(f'/tramites/{int(tramite_id)}')
        t = normalize_tramite(data.get('tramite', data))
        cache.set(clave, t, 600)
    return t
