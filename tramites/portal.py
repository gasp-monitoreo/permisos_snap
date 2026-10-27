"""Portal del investigador: registro geográfico de cada permiso.

El superusuario genera un acceso temporal (enlace + usuario + clave) para un trámite y
se lo envía al solicitante. Con él, el investigador o la productora entra a /portal/ y
marca puntos, transectos y parcelas en un mapa, o los importa desde un archivo GPS/SIG,
con método, fechas y atributos. Así queda el registro geográfico de cada permiso.

Aislamiento: una cuenta de investigador solo puede usar /portal/ (lo impone
AislamientoPortalMiddleware); nunca ve la plataforma interna ni otros permisos.
"""
import json
import logging
import secrets
from datetime import date, timedelta

from django.contrib.auth import get_user_model, logout
from django.contrib.auth import views as auth_views
from django.contrib.auth.signals import user_logged_in
from django.db import transaction
from django.http import HttpResponse, JsonResponse
from django.shortcuts import redirect, render
from django.utils import timezone
from django.views.decorators.http import require_GET, require_POST

from .geo import GeoError, TIPO_DE, importar, validar_geometria
from .models import (CATEGORIAS_REGISTRO, AccesoInvestigador, EntregaN6,
                     MAX_N6_MB, N6_EXTENSIONS, RegistroGeografico, TIPOS_ENTREGA)
from .usuarios import LoginForm, clave_temporal

log = logging.getLogger(__name__)

DIAS_DESPUES_DEL_PERMISO = 90
DIAS_MINIMOS = 30              # aunque el permiso ya haya terminado, para entregar lo pendiente
DIAS_SIN_FECHA = 365           # permisos sin fecha de término declarada
MAX_REGISTROS_POR_PERMISO = 2000
MAX_ATRIBUTOS = 40


def acceso_de(user):
    """AccesoInvestigador de la cuenta, o None si es un usuario interno."""
    if not (user and user.is_authenticated):
        return None
    try:
        return user.acceso_investigador
    except AccesoInvestigador.DoesNotExist:
        return None


def es_investigador(user):
    return acceso_de(user) is not None


class AislamientoPortalMiddleware:
    """Las cuentas de investigador solo pueden usar el portal; un acceso vencido o
    revocado cierra la sesión. Va después de AuthenticationMiddleware."""
    PERMITIDAS = ('/portal/', '/static/', '/salud')

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        acc = acceso_de(getattr(request, 'user', None))
        if acc is None:
            return self.get_response(request)
        if not acc.vigente():
            logout(request)
            return redirect('/portal/ingresar?vencido=1')
        if request.path == '/logout/':
            logout(request)
            return redirect('/portal/ingresar')
        if not request.path.startswith(self.PERMITIDAS):
            if request.path.startswith('/api/'):
                return JsonResponse({'ok': False, 'error': 'No autorizado.'}, status=403)
            return redirect('/portal/')
        return self.get_response(request)


def _al_ingresar(sender, request, user, **kw):
    acc = acceso_de(user)
    if acc:
        AccesoInvestigador.objects.filter(pk=acc.pk).update(ultimo_ingreso=timezone.now())


user_logged_in.connect(_al_ingresar, dispatch_uid='portal_ultimo_ingreso')


# ─── Generación de accesos (la llama la API interna, solo superusuario) ──────
def _vencimiento(fin_permiso):
    hoy = date.today()
    if not fin_permiso:
        return hoy + timedelta(days=DIAS_SIN_FECHA)
    return max(fin_permiso + timedelta(days=DIAS_DESPUES_DEL_PERMISO), hoy + timedelta(days=DIAS_MINIMOS))


@transaction.atomic
def generar_acceso(tramite, creado_por):
    """Crea (o renueva) el acceso del trámite normalizado. Retorna (acceso, clave en claro).
    La clave solo se muestra esta vez; se guarda únicamente su hash."""
    from .core import extract_titulo
    from .presion import periodo_actividades, _tipo
    User = get_user_model()
    tid = int(tramite['id'])
    _, fin = periodo_actividades(tramite)
    clave = clave_temporal(12)
    datos = {
        'titulo': (extract_titulo(tramite.get('datos_raw') or {}) or '')[:2000],
        'solicitante': (tramite.get('nombre_solicitante') or '')[:255],
        'tipo': _tipo(tramite) or '',
        'areas': tramite.get('areas_protegidas') or [],
        'regiones': tramite.get('regiones_list') or [],
        'vence': _vencimiento(fin),
        'revocado': False,
    }
    acc = AccesoInvestigador.objects.select_related('user').filter(tramite_id=tid).first()
    if acc:
        for k, v in datos.items():
            setattr(acc, k, v)
        acc.user.set_password(clave)
        acc.user.is_active = True
        acc.user.save(update_fields=['password', 'is_active'])
        acc.save()
        from .usuarios import _cerrar_sesiones
        _cerrar_sesiones(acc.user)      # la clave anterior deja de servir también en sesiones abiertas
    else:
        usuario = f'inv{tid}-{secrets.token_hex(2)}'
        u = User.objects.create_user(username=usuario, password=clave, first_name=datos['solicitante'][:150])
        acc = AccesoInvestigador.objects.create(user=u, tramite_id=tid, creado_por=creado_por, **datos)
    log.info('Acceso de investigador para trámite %s generado por %s (vence %s)', tid, creado_por.pk, acc.vence)
    return acc, clave


def revocar_acceso(acc):
    from .usuarios import _cerrar_sesiones
    acc.revocado = True
    acc.save(update_fields=['revocado'])
    _cerrar_sesiones(acc.user)


# ─── Vistas del portal ────────────────────────────────────────────────────────
class IngresoPortal(auth_views.LoginView):
    template_name = 'login.html'
    extra_context = {'portal': True}
    authentication_form = LoginForm
    redirect_authenticated_user = True

    def get_success_url(self):
        return '/portal/' if es_investigador(self.request.user) else '/'

    def get_context_data(self, **kw):
        ctx = super().get_context_data(**kw)
        ctx['vencido'] = self.request.GET.get('vencido') == '1'
        return ctx


def _requiere_investigador(fn):
    def wrapper(request, *a, **kw):
        acc = acceso_de(request.user)
        if acc is None:
            if request.path.startswith('/portal/api/'):
                return JsonResponse({'ok': False, 'error': 'Sesión no válida.'}, status=401)
            return redirect('/' if request.user.is_authenticated else '/portal/ingresar')
        request.acceso = acc
        return fn(request, *a, **kw)
    wrapper.__name__ = fn.__name__
    return wrapper


def _limites_areas(acc):
    """Polígonos oficiales de las áreas protegidas del permiso (para orientar el mapa)."""
    from .presion import _geojson_mapa, limite_de
    feats = []
    for area in acc.areas[:10]:
        region = acc.regiones[0] if len(acc.regiones) == 1 else None
        lim = limite_de(area, region)
        if lim:
            feats.append({'type': 'Feature', 'properties': {'nombre': area}, 'geometry': _geojson_mapa(lim)})
    return {'type': 'FeatureCollection', 'features': feats}


@require_GET
@_requiere_investigador
def portal(request):
    acc = request.acceso
    datos = {
        'acceso': acc.como_dict(),
        'categorias': CATEGORIAS_REGISTRO,
        'areas': _limites_areas(acc),
    }
    return render(request, 'portal.html', {'acceso': acc, 'datos': datos})   # json_script escapa </script>


def _registros(acc):
    return RegistroGeografico.objects.filter(tramite_id=acc.tramite_id)


def _fecha(v):
    if not v:
        return None
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        raise GeoError(f'Fecha no válida: {v}')


def _limpiar(d, origen_defecto='mapa'):
    """Campos editables de un registro, validados. GeoError si algo no cuadra."""
    geom = validar_geometria(d.get('geometria') or d.get('geometry'))
    nombre = str(d.get('nombre') or '').strip()[:200]
    if not nombre:
        raise GeoError('Cada registro necesita un nombre.')
    categoria = str(d.get('categoria') or '')
    if categoria and categoria not in CATEGORIAS_REGISTRO:
        raise GeoError('Categoría no válida.')
    atributos = d.get('atributos') or {}
    if not isinstance(atributos, dict) or len(atributos) > MAX_ATRIBUTOS:
        raise GeoError(f'Máximo {MAX_ATRIBUTOS} atributos por registro.')
    atributos = {str(k).strip()[:60]: (v if isinstance(v, (int, float, bool)) else str(v)[:500])
                 for k, v in atributos.items() if str(k).strip()}
    ini, fin = _fecha(d.get('fecha_inicio')), _fecha(d.get('fecha_fin'))
    if ini and fin and fin < ini:
        raise GeoError('La fecha de término es anterior a la de inicio.')
    return {
        'geometria': geom, 'tipo': TIPO_DE[geom['type']], 'nombre': nombre, 'categoria': categoria,
        'metodo': str(d.get('metodo') or '')[:5000], 'descripcion': str(d.get('descripcion') or '')[:5000],
        'fecha_inicio': ini, 'fecha_fin': fin, 'atributos': atributos,
        'origen': str(d.get('origen') or origen_defecto)[:200],
    }


def _json(request):
    try:
        return json.loads(request.body or b'{}')
    except ValueError:
        raise GeoError('Datos mal formados.')


def _error(msg, status=400):
    return JsonResponse({'ok': False, 'error': msg}, status=status)


@require_GET
@_requiere_investigador
def api_registros(request):
    feats = [r.como_feature() for r in _registros(request.acceso)]
    return JsonResponse({'ok': True, 'type': 'FeatureCollection', 'features': feats})


@require_POST
@_requiere_investigador
def api_crear(request):
    """Crea uno o varios registros (lista en «registros», p. ej. al importar un archivo)."""
    acc = request.acceso
    try:
        d = _json(request)
        lista = d.get('registros') if isinstance(d.get('registros'), list) else [d]
        if _registros(acc).count() + len(lista) > MAX_REGISTROS_POR_PERMISO:
            return _error(f'Máximo {MAX_REGISTROS_POR_PERMISO} registros por permiso.')
        limpios = [_limpiar(x) for x in lista]
    except GeoError as e:
        return _error(str(e))
    with transaction.atomic():
        nuevos = [RegistroGeografico.objects.create(tramite_id=acc.tramite_id, creado_por=request.user, **c)
                  for c in limpios]
    return JsonResponse({'ok': True, 'features': [r.como_feature() for r in nuevos]})


@require_POST
@_requiere_investigador
def api_editar(request, registro_id):
    r = _registros(request.acceso).filter(pk=registro_id).first()
    if not r:
        return _error('Registro no encontrado.', 404)
    try:
        c = _limpiar(_json(request), r.origen)
    except GeoError as e:
        return _error(str(e))
    for k, v in c.items():
        setattr(r, k, v)
    r.save()
    return JsonResponse({'ok': True, 'feature': r.como_feature()})


@require_POST
@_requiere_investigador
def api_borrar(request, registro_id):
    n, _ = _registros(request.acceso).filter(pk=registro_id).delete()
    return JsonResponse({'ok': bool(n)}) if n else _error('Registro no encontrado.', 404)


@require_POST
@_requiere_investigador
def api_importar(request):
    """Lee un archivo GPS/SIG y devuelve los elementos para revisarlos antes de guardar."""
    f = request.FILES.get('archivo')
    if not f:
        return _error('Adjunte un archivo.')
    try:
        huso = int(request.POST.get('huso') or 0) or None
        if huso not in (None, 18, 19):
            return _error('Huso UTM no válido (use 18 o 19).')
        elementos, avisos = importar(f.name, f.read(), huso)
    except GeoError as e:
        return _error(str(e))
    except Exception:
        log.exception('Error al importar %s', f.name)
        return _error('No se pudo leer el archivo. Revise el formato o expórtelo nuevamente.')
    return JsonResponse({'ok': True, 'elementos': elementos, 'avisos': avisos, 'archivo': f.name[:200]})


def geojson_descarga(tramite_id, registros, proteger=False):
    from .privacidad import feature
    feats = [r.como_feature() for r in registros]
    if proteger:
        feats = [feature(f) for f in feats]
    cuerpo = json.dumps({'type': 'FeatureCollection', 'features': feats},
                        ensure_ascii=False, indent=1)
    resp = HttpResponse(cuerpo, content_type='application/geo+json')
    resp['Content-Disposition'] = f'attachment; filename="registro_geografico_{int(tramite_id)}.geojson"'
    return resp


@require_GET
@_requiere_investigador
def api_descargar(request):
    acc = request.acceso
    return geojson_descarga(acc.tramite_id, _registros(acc))


# ─── «Mi permiso»: estado, etapas, fechas y documentos del propio trámite ─────
import re as _re

_EXT_DOC = _re.compile(r'\.(pdf|docx|doc|jpg|jpeg|png|xlsx|xls|zip|rar|pptx|odt|csv)(\?.*)?$', _re.I)
_CLAVES_RESOLUCION = ('autorizacion', 'autorizacion_firmada', 'resolucion', 'resolucion_aprobacion', 'documento_aprobacion')
ESTADOS = {'pendiente': 'En trámite', 'completado': 'Aprobado', 'rechazado': 'Rechazado'}


def _es_documento(v):
    return isinstance(v, str) and len(v) >= 4 and bool(_EXT_DOC.search(v)) \
        and (v.startswith('http') or (' ' not in v and '\n' not in v))


def _nombre_campo(clave):
    nombre = _re.sub(r'_\d+$', '', clave).replace('_', ' ').strip()
    return nombre[:1].upper() + nombre[1:]


def _tramite_vivo(tramite_id):
    from .adjuntos import tramite_vivo
    return tramite_vivo(tramite_id)


def _documentos(t):
    """Documentos del trámite: primero la resolución de CONAF, luego lo que adjuntó el titular."""
    docs = []
    for k, v in (t.get('datos_raw') or {}).items():
        if _es_documento(v):
            es_res = k in _CLAVES_RESOLUCION
            docs.append({'clave': k, 'nombre': 'Resolución o autorización de CONAF' if es_res else _nombre_campo(k),
                         'resolucion': es_res, 'formato': _EXT_DOC.search(v).group(1).upper()})
    docs.sort(key=lambda d: not d['resolucion'])
    return docs


@require_GET
@_requiere_investigador
def api_permiso(request):
    from .core import extract_titulo
    from .presion import periodo_actividades
    acc = request.acceso
    try:
        t = _tramite_vivo(acc.tramite_id)
    except Exception:
        log.exception('Portal: no se pudo consultar el trámite %s', acc.tramite_id)
        return _error('No se pudo consultar su permiso en Cero Filas. Intente más tarde.', 502)
    ini, fin = periodo_actividades(t)
    estado = 'Aprobado, falta cerrar el trámite en Cero Filas' if t.get('estado') == 'completado' and t.get('recepcion_pendiente') \
        else ESTADOS.get(t.get('estado'), t.get('estado') or '')
    # Etapas sin nombres ni correos de funcionarios: solo qué etapa, cuándo y si está en manos del titular
    etapas = [{
        'nombre': e.get('tarea_nombre') or '', 'estado': e.get('estado'),
        'inicio': e.get('fecha_inicio'), 'termino': e.get('fecha_termino'), 'vence': e.get('fecha_vencimiento'),
        'titular': bool(e.get('email')) and not _re.search(r'@conaf\.(gob\.)?cl$', e.get('email') or '', _re.I),
    } for e in (t.get('etapas') or [])]
    return JsonResponse({'ok': True, 'permiso': {
        'id': t.get('id'), 'titulo': extract_titulo(t.get('datos_raw') or {}), 'estado': estado,
        'estado_clave': t.get('estado'), 'motivo_rechazo': t.get('motivo_rechazo') or '',
        'tipo': 'Investigación científica' if acc.tipo == 'inv' else 'Filmación y fotografía',
        'fecha_ingreso': t.get('fecha_inicio'), 'fecha_resolucion': t.get('fecha_resolucion'),
        'actividades_inicio': ini.isoformat() if ini else None, 'actividades_termino': fin.isoformat() if fin else None,
        'areas': t.get('areas_protegidas') or [], 'regiones': t.get('regiones_list') or [],
        'avance': t.get('porcentaje_avance'), 'etapas': etapas, 'documentos': _documentos(t),
        'numeral6': acc.tipo == 'inv',
    }})


# ─── Numeral 6: entrega de resultados ────────────────────────────────────────
import os as _os
import re as _re2


def _n6_dir(tramite_id):
    from django.conf import settings
    d = _os.path.join(settings.INVESTIGACIONES_DIR, '_n6', str(tramite_id))
    _os.makedirs(d, exist_ok=True)
    return d


@require_GET
@_requiere_investigador
def api_n6_listar(request):
    acc = request.acceso
    if acc.tipo != 'inv':
        return _error('Solo disponible para permisos de investigación.', 403)
    archivos = EntregaN6.objects.filter(tramite_id=acc.tramite_id).select_related('subido_por')
    return JsonResponse({'ok': True, 'archivos': [a.como_dict() for a in archivos]})


@require_POST
@_requiere_investigador
def api_n6_subir(request):
    acc = request.acceso
    if acc.tipo != 'inv':
        return _error('Solo disponible para permisos de investigación.', 403)
    f = request.FILES.get('archivo')
    if not f:
        return _error('Adjunte un archivo.')
    if f.size > MAX_N6_MB * 1024 * 1024:
        return _error(f'El archivo supera {MAX_N6_MB} MB.')
    ext = _os.path.splitext(f.name)[1].lower()
    if ext not in N6_EXTENSIONS:
        return _error(f'Extensión no permitida ({ext}).')
    nombre = (request.POST.get('nombre') or '').strip()[:255] or _os.path.splitext(f.name)[0][:255]
    tipo = request.POST.get('tipo', 'informe')
    if tipo not in dict(TIPOS_ENTREGA):
        tipo = 'otro'
    descripcion = (request.POST.get('descripcion') or '').strip()[:2000]
    fname = _re2.sub(r'[^\w\.\-\(\) ]', '_', f.name).strip()
    if not fname:
        return _error('Nombre de archivo no válido.')
    n6d = _n6_dir(acc.tramite_id)
    dest = _os.path.join(n6d, fname)
    if not _os.path.abspath(dest).startswith(_os.path.abspath(n6d) + _os.sep):
        return _error('Ruta no permitida.', 400)
    base, xxt = _os.path.splitext(dest)
    i = 1
    while _os.path.exists(dest):
        dest = f'{base}_{i}{xxt}'
        i += 1
    with open(dest, 'wb') as out:
        for chunk in f.chunks():
            out.write(chunk)
    ar = EntregaN6.objects.create(
        tramite_id=acc.tramite_id, nombre=nombre, tipo=tipo,
        descripcion=descripcion, archivo=_os.path.basename(dest),
        tamano=f.size, subido_por=request.user,
    )
    return JsonResponse({'ok': True, 'archivo': ar.como_dict()})


@require_POST
@_requiere_investigador
def api_n6_borrar(request, archivo_id):
    acc = request.acceso
    try:
        ar = EntregaN6.objects.get(pk=archivo_id, tramite_id=acc.tramite_id)
    except EntregaN6.DoesNotExist:
        return _error('Archivo no encontrado.', 404)
    if ar.subido_por_id != request.user.id:
        return _error('No puede eliminar este archivo.', 403)
    ruta = _os.path.join(_n6_dir(acc.tramite_id), ar.archivo)
    if _os.path.isfile(ruta):
        _os.remove(ruta)
    ar.delete()
    return JsonResponse({'ok': True})


@require_GET
@_requiere_investigador
def api_documento(request, clave):
    """Descarga un documento del propio trámite. La URL nunca la pone el usuario:
    se toma del trámite por su campo, y solo se pide a Cero Filas."""
    from .adjuntos import AdjuntoError, es_adjunto, respuesta
    acc = request.acceso
    try:
        t = _tramite_vivo(acc.tramite_id)
    except Exception:
        return _error('No se pudo consultar su permiso en Cero Filas.', 502)
    valor = (t.get('datos_raw') or {}).get(clave)
    if not _es_documento(valor):
        return _error('Documento no encontrado.', 404)
    if es_adjunto(valor):
        try:
            return respuesta(acc.tramite_id, clave, valor, request.user)
        except AdjuntoError:
            pass
    # Cero Filas no siempre entrega los adjuntos por su API: se explica cómo obtenerlo
    return render(request, 'portal_documento.html', {'acceso': acc, 'clave': clave}, status=502)
