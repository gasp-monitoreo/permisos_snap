import os

from django.conf import settings
from django.contrib.auth.decorators import login_required
from django.http import FileResponse, Http404, HttpResponse
from django.shortcuts import redirect, render
from django.views.decorators.clickjacking import xframe_options_sameorigin


@login_required
def index(request):
    return render(request, 'index.html')


# ── Investigaciones file serving ──────────────────────────────────────────────

INV_DIR = settings.INVESTIGACIONES_DIR


def _inv_html(folder_display, archivos):
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


@xframe_options_sameorigin
def serve_investigacion(request, filepath=''):
    clean     = filepath.rstrip('/')
    full_path = os.path.join(INV_DIR, clean) if clean else INV_DIR

    if not os.path.abspath(full_path).startswith(os.path.abspath(INV_DIR)):
        return HttpResponse('Acceso denegado', status=403)

    if os.path.isdir(full_path):
        display  = os.path.basename(clean).replace('_', ' ') if clean else 'Investigaciones'
        archivos = _inv_archivos(full_path)
        return HttpResponse(_inv_html(display, archivos))

    if os.path.isfile(full_path):
        return FileResponse(open(full_path, 'rb'), as_attachment=False,
                            filename=os.path.basename(full_path))

    raise Http404(filepath)


# ── Gmail OAuth ───────────────────────────────────────────────────────────────

def gmail_auth_start(request):
    from .email_utils import GMAIL_AVAILABLE, gmail_creds_file, start_gmail_oauth_flow
    import os
    if not GMAIL_AVAILABLE:
        return HttpResponse('Librerías Google no instaladas', status=500)
    if not os.path.exists(gmail_creds_file()):
        return HttpResponse('Falta gmail_auth/credentials.json', status=400)
    redirect_uri = settings.GMAIL_REDIRECT_URI
    auth_url, state = start_gmail_oauth_flow(redirect_uri)
    request.session['gmail_state'] = state
    return redirect(auth_url)


def gmail_auth_callback(request):
    from .email_utils import finish_gmail_oauth_flow
    state    = request.session.get('gmail_state', '')
    redirect_uri = settings.GMAIL_REDIRECT_URI
    try:
        finish_gmail_oauth_flow(state, redirect_uri, request.build_absolute_uri())
        return HttpResponse('''<html><body style="font-family:sans-serif;padding:40px;text-align:center">
            <h2 style="color:#1B4F1E">✅ Gmail vinculado correctamente</h2>
            <p>Ya puedes cerrar esta pestaña.</p>
            <script>setTimeout(()=>window.close(),3000)</script>
        </body></html>''')
    except Exception as exc:
        return HttpResponse(f'Error OAuth: {exc}', status=500)
