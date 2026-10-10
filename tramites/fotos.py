"""Fotos de portada — extraídas de los documentos entregados por investigadores en Drive.

Descarga cada PDF/DOCX del índice Drive, extrae las imágenes incrustadas y guarda
solo las que parecen fotografías (grandes, apaisadas, con variedad de color), para
usarlas en los encabezados y en la portada de login.

Las fotos quedan en settings.FOTOS_DIR junto a un manifest.json:
  {"procesados": {drive_id: n_fotos}, "fotos": [{archivo, investigador, tramite_id,
   documento, drive_id, ancho, alto, activa}]}
"""
import hashlib
import io
import json
import os
import threading
import zipfile

from django.conf import settings

MIN_ANCHO       = 1000      # px
MIN_ALTO        = 560
ASPECTO_MIN     = 1.25      # ancho / alto: solo apaisadas (sirven como banner)
ASPECTO_MAX     = 2.6
MIN_COLORES     = 2500      # colores distintos en miniatura 96×96 (gráficos/mapas tienen pocos)
MAX_POR_DOC     = 4
MAX_DESCARGA_MB = 120
ANCHO_SALIDA    = 1920

_lock = threading.Lock()


def _dir():
    os.makedirs(settings.FOTOS_DIR, exist_ok=True)
    return settings.FOTOS_DIR


def _manifest_path():
    return os.path.join(_dir(), 'manifest.json')


def load_manifest():
    try:
        with open(_manifest_path(), encoding='utf-8') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {'procesados': {}, 'fotos': []}


def save_manifest(m):
    tmp = _manifest_path() + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(m, f, ensure_ascii=False, indent=1)
    os.replace(tmp, _manifest_path())


def fotos_activas():
    return [f for f in load_manifest()['fotos'] if f.get('activa', True)]


# ── Extracción ────────────────────────────────────────────────────────────────

def _imagenes_pdf(data):
    import pymupdf as fitz
    doc = fitz.open(stream=data, filetype='pdf')
    vistos = set()
    for page in doc:
        for img in page.get_images(full=True):
            xref = img[0]
            if xref in vistos:
                continue
            vistos.add(xref)
            w, h = img[2], img[3]
            if w < MIN_ANCHO or h < MIN_ALTO:
                continue
            try:
                pix = fitz.Pixmap(doc, xref)
                if pix.n - pix.alpha >= 4:          # CMYK → RGB
                    pix = fitz.Pixmap(fitz.csRGB, pix)
                if pix.alpha:
                    pix = fitz.Pixmap(pix, 0)
                yield pix.tobytes('png')
            except Exception:
                continue


def _imagenes_docx(data):
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        for name in z.namelist():
            if name.startswith('word/media/') and name.lower().endswith(
                    ('.jpg', '.jpeg', '.png', '.tif', '.tiff', '.bmp', '.webp')):
                yield z.read(name)


def _es_foto(im):
    w, h = im.size
    if w < MIN_ANCHO or h < MIN_ALTO:
        return False
    if not (ASPECTO_MIN <= w / h <= ASPECTO_MAX):
        return False
    thumb = im.convert('RGB').resize((96, 96))
    return len(set(thumb.getdata())) >= MIN_COLORES


def _guardar(raw):
    """Valida y guarda una imagen. Retorna (archivo, ancho, alto) o None."""
    from PIL import Image
    try:
        im = Image.open(io.BytesIO(raw))
        im.load()
    except Exception:
        return None
    if not _es_foto(im):
        return None
    im = im.convert('RGB')
    if im.width > ANCHO_SALIDA:
        im = im.resize((ANCHO_SALIDA, round(im.height * ANCHO_SALIDA / im.width)), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, 'JPEG', quality=82, optimize=True, progressive=True)
    out = buf.getvalue()
    nombre = hashlib.sha1(out).hexdigest()[:16] + '.jpg'
    path = os.path.join(_dir(), nombre)
    if not os.path.exists(path):
        with open(path, 'wb') as f:
            f.write(out)
    return nombre, im.width, im.height


def _descargar(service, drive_id):
    from googleapiclient.http import MediaIoBaseDownload
    buf = io.BytesIO()
    dl = MediaIoBaseDownload(buf, service.files().get_media(fileId=drive_id), chunksize=8 * 1024 * 1024)
    done = False
    while not done:
        _, done = dl.next_chunk()
    return buf.getvalue()


def _documentos(index):
    """Aplana el índice Drive → [(investigador, tramite_id|None, entry)]."""
    for inv, v in index.items():
        if v.get('tipo') == 'nested':
            for tid, archivos in v['ids'].items():
                for a in archivos:
                    yield inv, tid, a
        else:
            for a in v.get('archivos', []):
                yield inv, None, a


def extraer(service, index, reprocesar=False, log=print):
    """Procesa los documentos nuevos del índice. Retorna n° de fotos agregadas."""
    with _lock:
        m = load_manifest()
        ya = {f['archivo'] for f in m['fotos']}
        nuevas = 0
        for inv, tid, a in _documentos(index):
            ext = os.path.splitext(a['nombre'])[1].lower()
            if ext not in ('.pdf', '.docx'):
                continue
            did = a['drive_id']
            if did in m['procesados'] and not reprocesar:
                continue
            if (a.get('size_kb') or 0) > MAX_DESCARGA_MB * 1024:
                log(f'  omitido (muy grande): {a["nombre"]}')
                m['procesados'][did] = 0
                continue
            try:
                data = _descargar(service, did)
                imgs = _imagenes_pdf(data) if ext == '.pdf' else _imagenes_docx(data)
                n = 0
                for raw in imgs:
                    res = _guardar(raw)
                    if not res or res[0] in ya:
                        continue
                    archivo, w, h = res
                    ya.add(archivo)
                    m['fotos'].append({
                        'archivo': archivo, 'investigador': inv.replace('_', ' '),
                        'tramite_id': tid, 'documento': a['nombre'], 'drive_id': did,
                        'ancho': w, 'alto': h, 'activa': True,
                    })
                    n += 1
                    if n >= MAX_POR_DOC:
                        break
                m['procesados'][did] = n
                nuevas += n
                log(f'  {n} foto(s) ← {inv} / {a["nombre"]}')
            except Exception as exc:
                log(f'  error en {a["nombre"]}: {exc}')
            save_manifest(m)
        save_manifest(m)
        return nuevas
