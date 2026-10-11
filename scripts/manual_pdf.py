"""Genera docs/manual_permisos_snap.pdf desde /manual/ (con Chrome vía Playwright).

Uso local, con la plataforma corriendo en http://localhost:
    pip install playwright && python scripts/manual_pdf.py
Usa INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD de .env para iniciar sesión.
"""
import pathlib
import sys

from playwright.sync_api import sync_playwright

RAIZ = pathlib.Path(__file__).resolve().parent.parent
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost'
env = dict(l.split('=', 1) for l in (RAIZ / '.env').read_text().splitlines() if '=' in l and not l.startswith('#'))
SALIDA = RAIZ / 'docs' / 'manual_permisos_snap.pdf'

with sync_playwright() as p:
    nav = p.chromium.launch(channel='chrome')
    pg = nav.new_page(color_scheme='light')
    pg.goto(f'{BASE}/login/')
    pg.fill('#id_username', env['INITIAL_ADMIN_EMAIL'])
    pg.fill('#id_password', env['INITIAL_ADMIN_PASSWORD'])
    pg.click('.btn-submit')
    pg.wait_for_load_state('load')
    pg.goto(f'{BASE}/manual/')
    pg.click('#perfil-todo')                       # versión completa (todos los perfiles)
    pg.evaluate("document.querySelectorAll('img[loading]').forEach(i => i.loading = 'eager')")
    pg.wait_for_load_state('networkidle')
    pg.wait_for_function("[...document.images].every(i => i.complete)")
    pg.emulate_media(media='print')
    pg.pdf(path=str(SALIDA), format='A4', print_background=True, prefer_css_page_size=True,
           display_header_footer=True, header_template='<span></span>',
           footer_template='<div style="font-size:8px;width:100%;text-align:center;color:#64748B">'
                           'Manual Permisos SNAP · página <span class="pageNumber"></span> de <span class="totalPages"></span></div>',
           margin={'top': '14mm', 'bottom': '16mm', 'left': '12mm', 'right': '12mm'})
    nav.close()
print(f'PDF: {SALIDA} ({SALIDA.stat().st_size // 1024} KB)')
