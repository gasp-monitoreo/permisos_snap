"""Protección de datos personales conforme a la Ley N°21.719 de Protección de Datos
Personales y a la Ley Marco de Ciberseguridad (N°21.663). Mismo criterio que la
plataforma Recoge PH (recoge-humboldt/backend/apps/documents/redact.py).

Para usuarios sin rol Editor (permiso «Editar») ni superusuario, el servidor reemplaza
la información sensible por «█████» ANTES de enviarla: el dato no llega al navegador
(la página solo lo muestra difuminado y tachado). Se protege:
  - RUT/RUN, cédula, pasaporte y otros identificadores;
  - correos (los de CONAF se seudonimizan: se conserva @conaf.cl para saber que la etapa
    está en CONAF y una marca estable para agrupar por funcionario, sin revelar quién es);
  - teléfonos y direcciones;
  - coordenadas exactas (en mapas se redondean a ~1 km).
Documentos: los PDF con texto se entregan con los datos tachados (el texto se elimina,
no solo se tapa); los de identidad (cédula, CV, domicilio…) y los que no se pueden
tachar con seguridad (Word, escaneados) no se entregan.
"""
import copy
import hashlib
import io
import re

BLOCK = '█████'
DECIMALES_MAPA = 2          # ~1,1 km

PATRONES = [
    # RUT/RUN chileno (con o sin puntos) y etiquetado
    re.compile(r'\b\d{1,2}\.?\d{3}\.?\d{3}\-?[\dkK]\b'),
    re.compile(r'(?i)\bR\.?U\.?[NT]\.?\s*[:#]?\s*\d{1,2}\.?\d{3}\.?\d{3}(?:\-?[\dkK])?'),
    # Correos
    re.compile(r'\b[\w.+\-]+@[\w\-]+\.[\w.\-]+\b'),
    # Teléfonos: móvil, fijo y etiquetados
    re.compile(r'(?:\+?56[\s\-]?)?\b9[\s\-]?\d{4}[\s\-]?\d{4}\b'),
    re.compile(r'(?:\+?56[\s\-]?)?\b(?:2|3[2-5]|4[1-5]|5[1-8]|6[1-8])[\s\-]?\d{3}[\s\-]?\d{4}\b'),
    re.compile(r'(?i)\b(?:fono|tel[eé]fono|tel[eé]f?|cel(?:ular)?|anexo|whats?app)\s*[:.\-]?\s*\+?[\d][\d\s\-]{6,}\d'),
    # Coordenadas exactas: grados-minutos-segundos, decimales y UTM
    re.compile(r'\b\d{1,3}\s?[°º]\s?\d{1,2}\s?[\'′’]\s?[\d.,]*\s?["″”]?\s?[NSEWOnsewo]?\b'),
    re.compile(r'-?\b\d{1,3}[.,]\d{3,}\b\s*[,;/ ]\s*-?\b\d{1,3}[.,]\d{3,}\b'),
    re.compile(r'(?<![\d.,])[1-8]\d{5}(?:[.,]\d+)?\s*(?:m\s*)?(?:[EeOo]\b)?[^\d\n]{0,12}?[2-8]\d{6}(?:[.,]\d+)?'),
    # Cédula, pasaporte, cuentas etiquetadas
    re.compile(r'(?i)\b(?:c[eé]dula|pasaporte|cta\.?\s*corriente|cuenta\s*(?:corriente|vista|rut)?|dni)\s*(?:de\s+identidad\s*)?(?:n[°º.]?)?\s*[:#]?\s*[\w.\-]*\d[\w.\-]*'),
    # Direcciones / domicilio etiquetados
    re.compile(r'(?i)\b(?:direcci[oó]n(?:\s+(?:particular|laboral|postal))?|domicilio|calle|avenida|av\.|pasaje|psje\.?)\s*[:#]?\s*[^\n,;]{4,60}'),
]

# Campos del formulario cuyo valor completo es un dato personal
_CLAVE_SENSIBLE = re.compile(
    r'(^|_)(rut|run|cedula|c[eé]dula|pasaporte|dni|identificacion|documento_identidad|telefono|tel[eé]fono|fono|'
    r'celular|movil|whatsapp|email|e_mail|correo|mail|direccion|domicilio|calle|numeracion|comuna_domicilio)(_|$|\d)', re.I)
# Campos con coordenadas: se tachan los números, se conserva la descripción
_CLAVE_UBICACION = re.compile(r'coordenad|latitud|longitud|utm|localizacion|ubicacion|georref', re.I)
# Adjuntos de identidad: no se entregan a quien no es Editor
CLAVE_DOC_IDENTIDAD = re.compile(
    r'cedula|c[eé]dula|identi|dni|pasaporte|curricul|curriculo|^cv|domicilio|declaracion|carnet|consentimiento|fotografia_identificacion',
    re.I)


def ve_sensible(user):
    """Ley N°21.719: solo superusuario o perfiles con permiso «Editar» ven datos personales."""
    if not (user and getattr(user, 'is_authenticated', False)):
        return False
    if user.is_superuser:
        return True
    if hasattr(user, 'acceso_investigador'):
        return False
    from .usuarios import perfil_de
    return perfil_de(user).puede('editar')


def redactar(texto):
    """Texto con los datos sensibles reemplazados por █████."""
    if not isinstance(texto, str) or not texto:
        return texto
    for p in PATRONES:
        texto = p.sub(BLOCK, texto)
    return texto


def seudonimo_email(email):
    """«█████·a1b2@conaf.cl» para funcionarios (estable: agrupa sin identificar); █████ para el resto."""
    e = (email or '').strip().lower()
    if not e:
        return email
    if re.search(r'@conaf\.(gob\.)?cl$', e):
        return f'{BLOCK}·{hashlib.sha256(e.encode()).hexdigest()[:4]}@conaf.cl'
    return BLOCK


def _valor(clave, v):
    if isinstance(v, dict):
        return {k: _valor(k, x) for k, x in v.items()}
    if isinstance(v, list):
        return [_valor(clave, x) for x in v]
    if not isinstance(v, str) or not v.strip():
        return v
    if clave and _CLAVE_SENSIBLE.search(str(clave)):
        return BLOCK
    return redactar(v)


def _etapa(e):
    if not isinstance(e, dict):
        return e
    e = dict(e)
    if e.get('email'):
        e['email'] = seudonimo_email(e['email'])
    return e


def tramite(t):
    """Copia del trámite (normalizado, de cumplimiento o histórico) sin datos sensibles."""
    t = copy.copy(t)
    for k in ('email_solicitante', 'rut_solicitante', 'telefono_solicitante'):
        if t.get(k):
            t[k] = BLOCK
    for k in ('titulo_investigacion', 'texto_clasificacion', 'motivo_rechazo', 'colecta_muestras'):
        if isinstance(t.get(k), str):
            t[k] = redactar(t[k])
    if isinstance(t.get('datos_raw'), dict):
        t['datos_raw'] = {k: _valor(k, v) for k, v in t['datos_raw'].items()}
    if isinstance(t.get('etapas'), list):
        t['etapas'] = [_etapa(e) for e in t['etapas']]
    if isinstance(t.get('etapa_actual'), dict):
        t['etapa_actual'] = _etapa(t['etapa_actual'])
    return t


def tramites(request, lista):
    """Aplica la protección a una lista si el usuario no es Editor."""
    return lista if ve_sensible(request.user) else [tramite(t) for t in lista]


def _redondear(c):
    if isinstance(c, (list, tuple)):
        if c and isinstance(c[0], (int, float)):
            return [round(x, DECIMALES_MAPA) for x in c]
        return [_redondear(x) for x in c]
    return c


def feature(f):
    """Registro geográfico con coordenadas aproximadas y textos protegidos."""
    f = copy.deepcopy(f)
    g = f.get('geometry') or {}
    if 'coordinates' in g:
        g['coordinates'] = _redondear(g['coordinates'])
    p = f.get('properties') or {}
    for k in ('metodo', 'descripcion', 'nombre'):
        if isinstance(p.get(k), str):
            p[k] = redactar(p[k])
    if isinstance(p.get('atributos'), dict):
        p['atributos'] = {k: _valor(k, v) for k, v in p['atributos'].items()}
    return f


def puntos(lista):
    """[(lat, lon)] → aproximados (~1 km)."""
    return [[round(a, DECIMALES_MAPA), round(b, DECIMALES_MAPA)] for a, b in lista]


# ─── Documentos ──────────────────────────────────────────────────────────────
class NoRedactable(Exception):
    """El documento no se puede tachar con seguridad (escaneado, Word, imagen…)."""


def pdf_redactado(datos):
    """PDF con los datos sensibles eliminados (redacción real con PyMuPDF: el texto se borra)."""
    import fitz
    doc = fitz.open(stream=datos, filetype='pdf')
    texto_total = 0
    for pag in doc:
        texto = pag.get_text()
        texto_total += len(texto.strip())
        hallados = set()
        for p in PATRONES:
            hallados.update(m.group(0).strip() for m in p.finditer(texto))
        for h in sorted(hallados, key=len, reverse=True):
            if len(h) < 4:
                continue
            for rect in pag.search_for(h):
                pag.add_redact_annot(rect, fill=(0, 0, 0))
        pag.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)
    if texto_total < 40 * max(1, len(doc)) // 4:
        raise NoRedactable('PDF escaneado: no se puede tachar de forma fiable.')
    doc.set_metadata({})          # sin autor ni otros metadatos
    out = io.BytesIO()
    doc.save(out, garbage=4, deflate=True)
    return out.getvalue()
