"""Utilidades para registrar y revertir acciones de usuarios (historial de auditoría)."""
import logging
from datetime import date, datetime

log = logging.getLogger(__name__)


def _get_ip(request):
    xff = request.META.get('HTTP_X_FORWARDED_FOR', '')
    return xff.split(',')[0].strip() or request.META.get('REMOTE_ADDR') or None


def registrar(request_or_user, accion, objeto_tipo='', objeto_id='', descripcion='', datos=None):
    """Registra una acción en el historial de auditoría. Nunca lanza excepciones."""
    from .models import AuditLog
    try:
        if hasattr(request_or_user, 'user'):
            usuario = request_or_user.user
            ip = _get_ip(request_or_user)
        else:
            usuario = request_or_user
            ip = None
        uid = getattr(usuario, 'pk', None) if usuario and getattr(usuario, 'is_authenticated', False) else None
        nombre = ''
        if uid:
            nombre = f'{usuario.get_full_name() or usuario.username} ({usuario.email or usuario.username})'
        AuditLog.objects.create(
            usuario_id=uid,
            usuario_nombre=nombre[:255],
            accion=accion,
            objeto_tipo=objeto_tipo,
            objeto_id=str(objeto_id)[:40],
            descripcion=descripcion[:2000],
            datos=datos or {},
            ip=ip,
        )
    except Exception:
        log.exception('Error al registrar auditoría: accion=%s objeto=%s/%s', accion, objeto_tipo, objeto_id)


def revertir(audit_id, superusuario):
    """Revierte una acción del historial. Devuelve (ok, mensaje)."""
    from .models import AuditLog, ACCIONES_REVERSIBLES
    from django.utils import timezone

    a = AuditLog.objects.filter(pk=audit_id).first()
    if not a:
        return False, 'Registro no encontrado.'
    if a.revertido:
        return False, 'Este registro ya fue revertido.'
    if a.accion not in ACCIONES_REVERSIBLES:
        return False, 'Esta acción no es reversible.'

    try:
        ok, msg = _ejecutar_reversion(a, superusuario)
    except Exception as exc:
        log.exception('Error al revertir audit_id=%s accion=%s', audit_id, a.accion)
        return False, f'Error interno: {exc}'

    if ok:
        from django.utils import timezone as tz
        a.revertido = True
        a.revertido_por = superusuario.pk
        a.revertido_en = tz.now()
        a.revertido_nota = msg
        a.save(update_fields=['revertido', 'revertido_por', 'revertido_en', 'revertido_nota'])
        registrar(superusuario, 'ajuste_creado' if a.accion == 'ajuste_creado' else a.accion,
                  a.objeto_tipo, a.objeto_id,
                  f'Revertido: {a.descripcion}')
    return ok, msg


def _ejecutar_reversion(a, superusuario):
    accion = a.accion
    datos = a.datos or {}

    if accion == 'ajuste_creado':
        # Revertir un ajuste de estado → crear un nuevo ajuste "revertido"
        from .ajustes import guardar
        tramite_id = int(a.objeto_id)
        guardar(
            tramite_id=tramite_id,
            situacion='revertido',
            fecha=date.today(),
            motivo=f'Revertido por {superusuario.get_full_name() or superusuario.email} desde el historial de auditoría.',
            archivos=[],
            autor=superusuario,
        )
        return True, f'Ajuste del trámite {tramite_id} revertido.'

    if accion == 'acceso_creado':
        from .models import AccesoInvestigador
        from .portal import revocar_acceso
        acceso_id = datos.get('acceso_id')
        acc = AccesoInvestigador.objects.filter(pk=acceso_id).first() if acceso_id else None
        if not acc:
            return False, 'Acceso no encontrado (puede haber sido eliminado).'
        if acc.revocado:
            return False, 'El acceso ya estaba revocado.'
        revocar_acceso(acc)
        return True, f'Acceso del trámite {acc.tramite_id} revocado.'

    if accion == 'archivo_subido':
        import os
        ruta = datos.get('ruta')
        if not ruta or not os.path.isfile(ruta):
            return False, 'Archivo no encontrado en el sistema de archivos.'
        os.remove(ruta)
        return True, f'Archivo eliminado: {os.path.basename(ruta)}.'

    if accion == 'usuario_editado':
        from django.contrib.auth import get_user_model
        from .usuarios import perfil_de
        uid = datos.get('usuario_id')
        antes = datos.get('antes', {})
        if not uid or not antes:
            return False, 'No hay datos previos para restaurar.'
        User = get_user_model()
        u = User.objects.filter(pk=uid).first()
        if not u:
            return False, 'Usuario no encontrado.'
        p = perfil_de(u)
        if 'nombre' in antes:
            partes = antes['nombre'].split(' ', 1)
            u.first_name = partes[0]
            u.last_name = partes[1] if len(partes) > 1 else ''
        for campo in ('tipo', 'region', 'solo_su_region', 'areas', 'secciones',
                      'puede_agregar', 'puede_editar', 'puede_borrar'):
            if campo in antes:
                setattr(p, campo, antes[campo])
        if 'activo' in antes:
            u.is_active = antes['activo']
        u.save()
        p.save()
        return True, f'Perfil de {u.email} restaurado a su estado anterior.'

    if accion == 'registro_creado':
        from .models import RegistroGeografico
        reg_id = datos.get('registro_id')
        r = RegistroGeografico.objects.filter(pk=reg_id).first() if reg_id else None
        if not r:
            return False, 'Registro geográfico no encontrado.'
        r.delete()
        return True, f'Registro geográfico #{reg_id} eliminado.'

    if accion == 'registro_editado':
        from .models import RegistroGeografico
        reg_id = datos.get('registro_id')
        antes = datos.get('antes', {})
        if not reg_id or not antes:
            return False, 'No hay datos previos para restaurar.'
        r = RegistroGeografico.objects.filter(pk=reg_id).first()
        if not r:
            return False, 'Registro geográfico no encontrado.'
        for campo in ('nombre', 'categoria', 'metodo', 'descripcion', 'geometria', 'atributos'):
            if campo in antes:
                setattr(r, campo, antes[campo])
        r.save()
        return True, f'Registro geográfico #{reg_id} restaurado.'

    return False, f'Reversión no implementada para acción: {accion}.'
