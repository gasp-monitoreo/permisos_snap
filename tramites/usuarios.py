"""Gestión de usuarios: perfiles, claves temporales, permisos y encargados regionales.

Claves temporales (mismo esquema que la plataforma POA, con una diferencia pedida):
- Solo se guarda el hash (no hay copia reversible de ninguna clave).
- Cada descarga de la planilla regenera la clave de quienes aún no definen la suya
  (debe_cambiar_password=True). Quien ya puso su propia clave no se toca hasta que
  el superusuario pida restablecerla.
- La planilla se descarga reingresando la clave del superusuario y se entrega
  cifrada con esa misma clave (Excel pide la contraseña al abrirla).
"""
import secrets
import string
import time
from collections import Counter, defaultdict
from functools import wraps

import logging

from django.contrib.auth import get_user_model
from django.contrib.auth.backends import ModelBackend
from django.contrib.auth.forms import AuthenticationForm
from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.http import JsonResponse
from django.middleware.csrf import CsrfViewMiddleware

log = logging.getLogger(__name__)

from .models import PerfilUsuario, SECCIONES, secciones_por_defecto

REGIONES = ['Arica y Parinacota', 'Tarapacá', 'Antofagasta', 'Atacama', 'Coquimbo', 'Valparaíso', 'Metropolitana',
            "O'Higgins", 'Maule', 'Ñuble', 'Biobío', 'Araucanía', 'Los Ríos', 'Los Lagos', 'Aysén', 'Magallanes']
_ALFABETO = string.ascii_letters + string.digits
_SIN_AMBIGUOS = ''.join(c for c in _ALFABETO if c not in 'Il1O0o')


def clave_temporal(largo=10):
    """Clave aleatoria legible (sin caracteres ambiguos como l/1/O/0)."""
    while True:
        c = ''.join(secrets.choice(_SIN_AMBIGUOS) for _ in range(largo))
        if any(x.isdigit() for x in c) and any(x.isupper() for x in c) and any(x.islower() for x in c):
            return c


def perfil_de(user):
    """Perfil del usuario. Si no tiene, se crea: completo para el superusuario y mínimo
    (solo Portada, sin acciones) para cualquier otro, hasta que el superusuario lo edite."""
    try:
        return user.perfil
    except PerfilUsuario.DoesNotExist:
        pass
    perfil, _ = PerfilUsuario.objects.get_or_create(user=user, defaults={
        'tipo': 'nacional',
        'secciones': list(SECCIONES) if user.is_superuser else ['portada'],
        'debe_cambiar_password': False,
    })
    return perfil


def restablecer_clave(user):
    """Nueva clave temporal: el usuario deberá cambiarla al entrar. Retorna la clave en claro."""
    clave = clave_temporal()
    user.set_password(clave)
    user.save(update_fields=['password'])
    p = perfil_de(user)
    p.debe_cambiar_password = True
    p.save(update_fields=['debe_cambiar_password', 'actualizado_en'])
    _cerrar_sesiones(user)
    return clave


def _cerrar_sesiones(user):
    from django.contrib.sessions.models import Session
    from django.utils import timezone
    for s in Session.objects.filter(expire_date__gte=timezone.now()):
        if s.get_decoded().get('_auth_user_id') == str(user.pk):
            s.delete()


# ─── Autenticación ────────────────────────────────────────────────────────────
class EmailBackend(ModelBackend):
    """Ingreso con el correo sin distinguir mayúsculas (el usuario es el correo)."""
    def authenticate(self, request, username=None, password=None, **kwargs):
        if not username or not password:
            return None
        User = get_user_model()
        user = User.objects.filter(username__iexact=username.strip()).first() \
            or User.objects.filter(email__iexact=username.strip()).first()
        if user and user.check_password(password) and self.user_can_authenticate(user):
            return user
        return None


class SesionAuth:
    """Autenticación de la API con la sesión de Django (la API antes era pública).
    Las operaciones que modifican datos exigen además el token CSRF (cabecera X-CSRFToken),
    para que otro sitio no pueda usar la sesión abierta del usuario."""
    def __call__(self, request):
        u = getattr(request, 'user', None)
        if not (u and u.is_authenticated and u.is_active):
            return None
        if hasattr(u, 'acceso_investigador'):
            return None          # cuentas del portal del investigador: sin acceso a la API interna
        if perfil_de(u).debe_cambiar_password:
            return None          # primero debe definir su clave
        if request.method not in ('GET', 'HEAD', 'OPTIONS'):
            rechazo = CsrfViewMiddleware(lambda r: None).process_view(request, None, (), {})
            if rechazo is not None:
                log.warning('CSRF rechazado en %s %s (usuario %s)', request.method, request.path, u.pk)
                return None
        return u


def _al_ingresar(sender, request, user, **kw):
    """Marca la sesión para ofrecer el tutorial una vez por inicio de sesión."""
    request.session['ofrecer_tutorial'] = True


from django.contrib.auth.signals import user_logged_in  # noqa: E402
user_logged_in.connect(_al_ingresar, dispatch_uid='ofrecer_tutorial')


# ─── Freno a intentos de ingreso ─────────────────────────────────────────────
MAX_FALLOS_USUARIO, MAX_FALLOS_IP, BLOQUEO_SEG = 5, 20, 15 * 60


def ip_cliente(request):
    """IP real: Caddy reemplaza X-Forwarded-For con la IP del cliente."""
    xff = request.META.get('HTTP_X_FORWARDED_FOR', '')
    return (xff.split(',')[-1].strip() if xff else '') or request.META.get('REMOTE_ADDR', '')


class LoginForm(AuthenticationForm):
    """Formulario de ingreso con bloqueo temporal: 5 fallos por cuenta o 20 por IP
    bloquean 15 minutos (la cuenta no se bloquea para siempre: el atacante no puede
    dejar fuera a un colega de forma permanente)."""
    def clean(self):
        usuario = (self.data.get('username') or '').strip().lower()
        claves = [f'login:u:{usuario}', f'login:ip:{ip_cliente(self.request)}'] if self.request else []
        if any(cache.get(k, 0) >= lim for k, lim in zip(claves, (MAX_FALLOS_USUARIO, MAX_FALLOS_IP))):
            raise ValidationError('Demasiados intentos fallidos. Espere 15 minutos e intente de nuevo.',
                                  code='bloqueado')
        try:
            datos = super().clean()
        except ValidationError:
            for k in claves:
                cache.set(k, cache.get(k, 0) + 1, BLOQUEO_SEG)
            log.warning('Ingreso fallido para %r desde %s', usuario, claves[1][9:] if claves else '?')
            raise
        cache.delete(claves[0]) if claves else None
        return datos


def _prohibido(msg):
    return JsonResponse({'ok': False, 'error': msg}, status=403)


def requiere(accion=None, seccion=None, superusuario=False):
    """Decorador para endpoints: exige permiso de acción y/o acceso a una sección."""
    def deco(fn):
        @wraps(fn)
        def wrapper(request, *a, **kw):
            u = request.user
            if superusuario and not u.is_superuser:
                return _prohibido('Solo el superusuario puede hacer esto.')
            p = perfil_de(u)
            if seccion and seccion not in p.secciones_visibles():
                return _prohibido('No tiene acceso a esta sección.')
            if accion and not p.puede(accion):
                return _prohibido(f'Su perfil no tiene permiso para {accion}.')
            return fn(request, *a, **kw)
        return wrapper
    return deco


class CambioClaveMiddleware:
    """Mientras la clave sea temporal, solo se permite cambiarla o cerrar sesión."""
    PERMITIDAS = ('/cambiar-clave/', '/logout/', '/login/', '/static/', '/fotos/')

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        u = getattr(request, 'user', None)
        if u and u.is_authenticated and not request.path.startswith(self.PERMITIDAS)                 and not hasattr(u, 'acceso_investigador'):
            if perfil_de(u).debe_cambiar_password:
                if request.path.startswith('/api/'):
                    return JsonResponse({'ok': False, 'cambiar_password': True,
                                         'error': 'Debe cambiar su clave temporal.'}, status=403)
                from django.shortcuts import redirect
                return redirect('/cambiar-clave/')
        return self.get_response(request)


# ─── Limitador de intentos para la planilla (por superusuario) ───────────────
_intentos = {}


def intento_bloqueado(user_id):
    f = _intentos.get(user_id)
    return bool(f and f['hasta'] > time.time())


def registrar_intento(user_id, ok):
    if ok:
        _intentos.pop(user_id, None)
        return
    f = _intentos.setdefault(user_id, {'n': 0, 'hasta': 0})
    f['n'] += 1
    if f['n'] >= 5:
        f.update(n=0, hasta=time.time() + 600)      # 10 minutos


# ─── Encargados regionales detectados en los trámites ────────────────────────
def detectar_encargados(anios=3):
    """Último funcionario CONAF a cargo de etapas en cada región y tipo.

    Solo usa trámites de una región (señal inequívoca) y personas cuya actividad
    se concentra ≥60% en esa región (excluye nivel central).
    Retorna [{tipo, region, email, nombre, ultima_etapa}] (email None si no hay datos).
    """
    from datetime import datetime
    from . import tramites_cache
    from .core import INVESTIGACION_PROCESO_IDS

    conaf = lambda e: (e or '').lower().endswith(('@conaf.cl', '@conaf.gob.cl'))
    regiones_de, ultimo, nombres = defaultdict(Counter), {}, {}
    actual = datetime.now(tramites_cache.TZ).year
    for anio in range(actual - anios + 1, actual + 1):
        for t in tramites_cache.obtener(anio, anio)['data']:
            regs = t.get('regiones_list') or []
            if len(regs) != 1:
                continue
            tipo = 'inv' if t['proceso_id'] in INVESTIGACION_PROCESO_IDS else 'film'
            for e in t.get('etapas') or []:
                em = (e.get('email') or '').lower()
                if not conaf(em):
                    continue
                regiones_de[em][regs[0]] += 1
                nombres[em] = e.get('nombres') or nombres.get(em, '')
                f = str(e.get('fecha_inicio') or '')
                if f > ultimo.get((tipo, regs[0], em), ''):
                    ultimo[(tipo, regs[0], em)] = f

    def region_propia(em):
        c = regiones_de[em]
        top, n = c.most_common(1)[0]
        return top if n / sum(c.values()) >= 0.6 else None

    res = []
    for tipo in ('inv', 'film'):
        for reg in REGIONES:
            cands = [(f, em) for (tp, r, em), f in ultimo.items()
                     if tp == tipo and r == reg and region_propia(em) == reg]
            f, em = max(cands) if cands else (None, None)
            res.append({'tipo': tipo, 'region': reg, 'email': em,
                        'nombre': nombres.get(em) if em else None, 'ultima_etapa': (f or '')[:10] or None})
    return res


def crear_cuentas_encargados(encargados):
    """Crea (o completa) una cuenta por persona. Quien es encargado de investigación y
    filmación en la misma región recibe un solo perfil 'ambos'. No toca cuentas existentes
    salvo para agregar el tipo que les falte. Retorna (creados, actualizados)."""
    User = get_user_model()
    por_email = {}
    for e in encargados:
        if not e.get('email'):
            continue
        d = por_email.setdefault(e['email'], {'nombre': e['nombre'], 'region': e['region'], 'tipos': set()})
        d['tipos'].add(e['tipo'])
    creados, actualizados = [], []
    for email, d in por_email.items():
        tipo = 'ambos' if d['tipos'] == {'inv', 'film'} else next(iter(d['tipos']))
        partes = (d['nombre'] or '').split()
        user = User.objects.filter(username__iexact=email).first()
        if user is None:
            user = User.objects.create_user(username=email, email=email,
                                            first_name=' '.join(partes[:1]), last_name=' '.join(partes[1:]))
            user.set_unusable_password()       # la clave temporal se genera al descargar la planilla
            user.save()
            PerfilUsuario.objects.create(user=user, tipo=tipo, region=d['region'], solo_su_region=True,
                                         secciones=secciones_por_defecto(tipo), debe_cambiar_password=True)
            creados.append(email)
        else:
            p = perfil_de(user)
            if not user.is_superuser and p.tipo != tipo and {p.tipo, tipo} <= {'inv', 'film', 'ambos'}:
                p.tipo = 'ambos'
                p.secciones = sorted(set(p.secciones) | set(secciones_por_defecto('ambos')))
                p.save()
                actualizados.append(email)
    return creados, actualizados
