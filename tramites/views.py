import os

from django.conf import settings
from django.contrib.auth.decorators import login_required
from django.http import FileResponse, Http404, HttpResponse
from django.shortcuts import redirect, render
from django.views.decorators.clickjacking import xframe_options_sameorigin


def salud(request):
    """Estado para el healthcheck de Docker y el monitoreo externo (sin datos internos)."""
    from django.db import connection
    from django.http import JsonResponse
    try:
        with connection.cursor() as c:
            c.execute('SELECT 1')
        return JsonResponse({'ok': True})
    except Exception:
        return JsonResponse({'ok': False, 'error': 'base de datos'}, status=503)


@login_required
def index(request):
    import json
    from .usuarios import perfil_de
    perfil = perfil_de(request.user).como_dict()
    # el aviso del tutorial aparece una vez por inicio de sesión (no en cada recarga)
    ofrecer = request.session.pop('ofrecer_tutorial', False) and perfil['ver_tutorial']
    return render(request, 'index.html', {'perfil': perfil, 'perfil_json': json.dumps(perfil),
                                          'ofrecer_tutorial': ofrecer})


@login_required
def manual(request):
    return render(request, 'manual.html')


MANUAL_PDF = os.path.join(settings.BASE_DIR, 'docs', 'manual_permisos_snap.pdf')


@login_required
def manual_pdf(request):
    """PDF del manual (se regenera con scripts/manual_pdf.py cuando cambia el manual)."""
    if not os.path.isfile(MANUAL_PDF):
        raise Http404('manual')
    return FileResponse(open(MANUAL_PDF, 'rb'), as_attachment=True,
                        filename='Manual Permisos SNAP.pdf', content_type='application/pdf')


@login_required
def cambiar_clave(request):
    """Cambio de clave: obligatorio con clave temporal, voluntario después."""
    from django.contrib.auth import update_session_auth_hash
    from .usuarios import perfil_de
    perfil = perfil_de(request.user)
    error = ''
    if request.method == 'POST':
        actual = request.POST.get('actual', '')
        nueva = request.POST.get('nueva', '')
        repetir = request.POST.get('repetir', '')
        if not request.user.check_password(actual):
            error = 'La clave actual no es correcta.'
        elif len(nueva) < 8:
            error = 'La nueva clave debe tener al menos 8 caracteres.'
        elif _clave_debil(nueva, request.user):
            error = _clave_debil(nueva, request.user)
        elif nueva != repetir:
            error = 'Las claves nuevas no coinciden.'
        elif nueva == actual:
            error = 'La nueva clave debe ser distinta de la actual.'
        else:
            request.user.set_password(nueva)
            request.user.save(update_fields=['password'])
            perfil.debe_cambiar_password = False
            perfil.save(update_fields=['debe_cambiar_password', 'actualizado_en'])
            update_session_auth_hash(request, request.user)   # mantiene la sesión abierta
            return redirect('/')
    return render(request, 'cambiar_clave.html', {
        'obligatorio': perfil.debe_cambiar_password, 'error': error,
        'nombre': request.user.get_full_name() or request.user.username})


def _clave_debil(clave, user):
    """Mensaje si la clave es demasiado común, solo números o parecida al correo."""
    from django.contrib.auth.password_validation import validate_password
    from django.core.exceptions import ValidationError
    try:
        validate_password(clave, user)
    except ValidationError as e:
        traducir = {'password_too_common': 'Esa clave es demasiado común; elija otra.',
                    'password_entirely_numeric': 'La clave no puede tener solo números.',
                    'password_too_similar': 'La clave se parece demasiado a su correo o nombre.'}
        return next((traducir.get(x.code) for x in e.error_list if x.code in traducir), 'La clave no es segura.')
    return ''


# ── Investigaciones file serving ──────────────────────────────────────────────

INV_DIR = settings.INVESTIGACIONES_DIR


def _inv_html(folder_display, archivos):
    from html import escape
    folder_display = escape(folder_display)
    archivos = [{**a, 'url': escape(a['url']), 'nombre': escape(a['nombre'])} for a in archivos]
    rows = ''.join(
        f'<tr><td><a href="{a["url"]}" target="_blank">{a["nombre"]}</a></td>'
        f'<td style="color:#666;text-align:right;white-space:nowrap">{a["size_kb"]} KB</td></tr>'
        for a in archivos
    )
    return f'''<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
    <title>{folder_display} – Archivos</title>
    <style>body{{font-family:Arial,sans-serif;max-width:860px;margin:40px auto;padding:0 20px}}
    h2{{color:#1B4F1E}}table{{width:100%;border-collapse:collapse;margin-top:20px}}
    th{{background:#1B4F1E;color:#fff;padding:10px;text-align:left}}
    tr:nth-child(even){{background:#f5f5f5}}td{{padding:9px 10px;border-bottom:1px solid #ddd}}
    a{{color:#1B4F1E}}</style></head><body>
    <h2>📁 {folder_display}</h2>
    <p>Archivos entregados en cumplimiento del Numeral 6 del Reglamento de Investigación en el SNAP.</p>
    <table><thead><tr><th>Archivo</th><th style="text-align:right">Tamaño</th></tr></thead>
    <tbody>{rows or "<tr><td colspan='2' style='color:#999;text-align:center'>Sin archivos</td></tr>"}</tbody></table>
    <a href="javascript:history.back()" style="display:inline-block;margin-top:18px;color:#1B4F1E">← Volver</a>
    </body></html>'''


def _inv_archivos(base_path):
    INV_EXTENSIONS = {'.pdf', '.doc', '.docx', '.csv', '.xls', '.xlsx'}
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


@login_required
@xframe_options_sameorigin
def serve_investigacion(request, filepath=''):
    clean     = filepath.rstrip('/')
    full_path = os.path.join(INV_DIR, clean) if clean else INV_DIR

    raiz = os.path.realpath(INV_DIR)
    real = os.path.realpath(full_path)
    if real != raiz and not real.startswith(raiz + os.sep):
        return HttpResponse('Acceso denegado', status=403)

    if os.path.isdir(full_path):
        display  = os.path.basename(clean).replace('_', ' ') if clean else 'Investigaciones'
        archivos = _inv_archivos(full_path)
        return HttpResponse(_inv_html(display, archivos))

    if os.path.isfile(full_path):
        # solo los PDF se muestran en el navegador; el resto se descarga
        es_pdf = full_path.lower().endswith('.pdf')
        return FileResponse(open(full_path, 'rb'), as_attachment=not es_pdf,
                            filename=os.path.basename(full_path))

    raise Http404(filepath)


# ── Fotos de portada ──────────────────────────────────────────────────────────

def serve_foto(request, archivo):
    """Sirve una foto del manifest. Las activas son públicas (se usan en el login);
    las ocultas solo las ve el superusuario, para gestionarlas."""
    from .fotos import load_manifest
    foto = next((f for f in load_manifest()['fotos'] if f['archivo'] == archivo), None)
    activa = bool(foto and foto.get('activa', True))
    if not foto or (not activa and not request.user.is_superuser):
        raise Http404(archivo)
    resp = FileResponse(open(os.path.join(settings.FOTOS_DIR, archivo), 'rb'),
                        content_type='image/jpeg')
    resp['Cache-Control'] = 'public, max-age=604800, immutable' if activa else 'private, no-store'
    return resp


def login_fotos(request):
    """Lista mínima de fotos para el carrusel del login (sin datos internos)."""
    from django.http import JsonResponse
    from .fotos import fotos_activas
    return JsonResponse({'fotos': [
        {'url': f'/fotos/{f["archivo"]}', 'credito': f['investigador']}
        for f in fotos_activas()
    ]})


# ── Gmail OAuth ───────────────────────────────────────────────────────────────

def _solo_superusuario(vista):
    from functools import wraps
    @wraps(vista)
    def envoltura(request, *a, **kw):
        if not (request.user.is_authenticated and request.user.is_superuser):
            return HttpResponse('Solo el superusuario puede vincular la cuenta de Google.', status=403)
        return vista(request, *a, **kw)
    return envoltura


@_solo_superusuario
def gmail_auth_start(request):
    from .email_utils import GMAIL_AVAILABLE, gmail_creds_file, start_gmail_oauth_flow
    import os
    if not GMAIL_AVAILABLE:
        return HttpResponse('Librerías Google no instaladas', status=500)
    if not os.path.exists(gmail_creds_file()):
        return HttpResponse('Falta gmail_auth/credentials.json', status=400)
    redirect_uri = settings.GMAIL_REDIRECT_URI
    auth_url, state, code_verifier = start_gmail_oauth_flow(redirect_uri)
    request.session['gmail_state'] = state
    request.session['gmail_code_verifier'] = code_verifier
    return redirect(auth_url)


@_solo_superusuario
def gmail_auth_callback(request):
    from .email_utils import finish_gmail_oauth_flow
    state        = request.session.get('gmail_state', '')
    code_verifier = request.session.get('gmail_code_verifier')
    redirect_uri = settings.GMAIL_REDIRECT_URI
    try:
        finish_gmail_oauth_flow(state, redirect_uri, request.build_absolute_uri(), code_verifier)
        return HttpResponse('''<html><body style="font-family:sans-serif;padding:40px;text-align:center">
            <h2 style="color:#1B4F1E">✅ Gmail vinculado correctamente</h2>
            <p>Ya puedes cerrar esta pestaña.</p>
            <script>setTimeout(()=>window.close(),3000)</script>
        </body></html>''')
    except Exception:
        import logging
        logging.getLogger(__name__).exception('Error al vincular Gmail')
        return HttpResponse('No se pudo vincular la cuenta de Google. Revise el registro del servidor.', status=500)
