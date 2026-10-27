"""Ajuste manual del estado de un permiso (tramites.models.AjusteEstado).

Cero Filas a veces no refleja la realidad: el solicitante desistió y no lo informó, lo
informó por correo y nadie lo registró, se resolvió por otra vía, era un duplicado…
Un funcionario responsable puede registrar el estado real, siempre con justificación y
respaldos (correos, cartas). El ajuste vigente se aplica en toda la plataforma.

Responsabilidad: superusuario, o perfil con permiso «Editar» cuyo ámbito cubre el permiso:
  - con región asignada, solo permisos de esa región;
  - con áreas protegidas asignadas, solo permisos de esas áreas;
  - sin región (nivel central), todos.
"""
import re
import unicodedata

from .models import SITUACIONES_AJUSTE, AdjuntoAjuste, AjusteEstado

# situación del ajuste → situación que usa la plataforma (situacionTramite en app.js)
SITUACION_PLATAFORMA = {
    'desistido': 'cerrado_admin', 'sin_respuesta': 'cerrado_admin', 'anulado': 'cerrado_admin',
    'aprobado_externo': 'completado', 'rechazado_externo': 'rechazado',
}
EXT_PERMITIDAS = {'eml', 'msg', 'pdf', 'png', 'jpg', 'jpeg', 'txt', 'docx', 'doc'}
MAX_ADJUNTOS, MAX_TAMANO = 5, 10 * 1024 * 1024
MIN_MOTIVO = 30


def _norm(s):
    s = unicodedata.normalize('NFD', str(s or '').lower())
    return re.sub(r'\s+', ' ', ''.join(c for c in s if unicodedata.category(c) != 'Mn')).strip()


def puede_ajustar(user, t):
    if not (user and user.is_authenticated) or hasattr(user, 'acceso_investigador'):
        return False
    if user.is_superuser:
        return True
    from .usuarios import perfil_de
    from .core import INVESTIGACION_PROCESO_IDS
    p = perfil_de(user)
    if not p.puede('editar'):
        return False
    if p.region and p.region not in (t.get('regiones_list') or []):
        return False
    if p.areas:
        mias = {_norm(a) for a in p.areas}
        if not any(_norm(a) in mias or any(m in _norm(a) for m in mias) for a in (t.get('areas_protegidas') or [])):
            return False
    # Restricción por tipo: inv solo edita inv, film solo edita film
    if p.tipo in ('inv', 'film'):
        tramite_tipo = 'inv' if t.get('proceso_id') in INVESTIGACION_PROCESO_IDS else 'film'
        if p.tipo != tramite_tipo:
            return False
    return True


def vigentes(ids=None):
    """{tramite_id: AjusteEstado} con el último ajuste de cada permiso (si no es «revertido»)."""
    qs = AjusteEstado.objects.select_related(None).order_by('tramite_id', '-creado_en', '-id')
    if ids is not None:
        qs = qs.filter(tramite_id__in=list(ids))
    res, vistos = {}, set()
    for a in qs.only('id', 'tramite_id', 'situacion', 'fecha_efectiva', 'autor_nombre', 'creado_en'):
        if a.tramite_id in vistos:
            continue
        vistos.add(a.tramite_id)
        if a.situacion != 'revertido':
            res[a.tramite_id] = a
    return res


def como_dict(a):
    return {
        'situacion': a.situacion, 'nombre': SITUACIONES_AJUSTE.get(a.situacion, a.situacion),
        'sit': SITUACION_PLATAFORMA.get(a.situacion), 'fecha_efectiva': a.fecha_efectiva.isoformat(),
        'autor': a.autor_nombre, 'creado_en': a.creado_en.isoformat() if a.creado_en else None,
    }


def aplicar(lista):
    """Copia de la lista con «ajuste» en los permisos que tienen un ajuste vigente."""
    if not lista:
        return lista
    try:
        vig = vigentes()
    except Exception:          # tabla aún no migrada o base no disponible: sin ajustes
        return lista
    if not vig:
        return lista
    return [{**t, 'ajuste': como_dict(vig[t['id']])} if t.get('id') in vig else t for t in lista]


def invalidar_caches():
    """El índice de búsqueda y la vista territorial se recalculan con el nuevo estado."""
    from datetime import datetime
    from django.core.cache import cache
    from .usuarios import REGIONES
    claves = [f'buscar:indice:v2:{r}:{m}' for r in ['todas', *REGIONES] for m in ('protegido', 'completo')]
    claves += [f'territorio:nac:v3:{t}:{datetime.now():%Y%m%d%H}' for t in ('inv', 'film', None)]
    cache.delete_many(claves)


def validar(situacion, fecha, motivo, archivos, hay_vigente):
    """Mensaje de error, o None si el ajuste es válido."""
    if situacion not in SITUACIONES_AJUSTE:
        return 'Elija el estado real del permiso.'
    if situacion == 'revertido' and not hay_vigente:
        return 'El permiso no tiene un ajuste vigente que revertir.'
    if not fecha:
        return 'Indique la fecha en que ocurrió.'
    if len((motivo or '').strip()) < MIN_MOTIVO:
        return f'Justifique el ajuste con al menos {MIN_MOTIVO} caracteres: qué ocurrió, cómo se supo y quién lo informó.'
    if len(archivos) > MAX_ADJUNTOS:
        return f'Máximo {MAX_ADJUNTOS} archivos de respaldo.'
    for f in archivos:
        ext = f.name.rsplit('.', 1)[-1].lower() if '.' in f.name else ''
        if ext not in EXT_PERMITIDAS:
            return f'«{f.name}»: formato no permitido. Use correo (.eml, .msg), PDF, imagen, texto o Word.'
        if f.size > MAX_TAMANO:
            return f'«{f.name}» supera 10 MB.'
    return None


def historial(tramite_id, proteger):
    from .privacidad import redactar
    res = []
    for a in AjusteEstado.objects.filter(tramite_id=tramite_id).prefetch_related('adjuntos'):
        res.append({**como_dict(a), 'id': a.id, 'motivo': redactar(a.motivo) if proteger else a.motivo,
                    'adjuntos': [{'n': i, 'nombre': x.nombre, 'tamano': x.tamano} for i, x in enumerate(a.adjuntos.order_by('id').only('id', 'nombre', 'tamano'))]})
    return res


def guardar(tramite_id, situacion, fecha, motivo, archivos, user):
    a = AjusteEstado.objects.create(tramite_id=tramite_id, situacion=situacion, fecha_efectiva=fecha,
                                    motivo=motivo.strip()[:10000], autor=user,
                                    autor_nombre=(user.get_full_name() or user.email or user.username)[:255])
    for f in archivos:
        AdjuntoAjuste.objects.create(ajuste=a, nombre=f.name[:200], tipo=(f.content_type or 'application/octet-stream')[:100],
                                     tamano=f.size, datos=f.read())
    invalidar_caches()
    return a
