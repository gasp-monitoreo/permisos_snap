"""Manual personalizado según el perfil de quien lo abre.

El filtrado se hace en el servidor: los capítulos de secciones que la persona no ve
(y el de administración, salvo para el superusuario) no se envían al navegador.
La versión «general» (sin administración, todas las secciones regionales) es la
que se usa para el PDF descargable.
"""
import re
from functools import lru_cache
from html import escape
from pathlib import Path

from django.conf import settings

PLANTILLA = Path(settings.BASE_DIR) / 'templates' / 'manual.html'
ADMIN = Path(settings.BASE_DIR) / 'templates' / 'manual_admin.html'

# capítulo → secciones del perfil que lo justifican (basta una)
CAPITULOS = {
    'portada': {'portada'},
    'resumen': {'resumen_inv', 'resumen_film'},
    'areas': {'resumen_inv', 'resumen_film'},
    'detalle': {'resumen_inv', 'resumen_film', 'busqueda'},
    'buscar': {'busqueda', 'exportar'},
}
NOMBRES_SECCION = {'portada': 'Portada', 'resumen_inv': 'Investigación · Resumen',
                   'resumen_film': 'Filmación y Fotografía · Resumen', 'busqueda': 'Búsqueda',
                   'exportar': 'Exportar', 'usuarios': 'Usuarios'}
NOMBRES_TIPO = {'inv': 'Encargado/a de investigación', 'film': 'Encargado/a de filmación y fotografía',
                'ambos': 'Encargado/a de investigación y filmación', 'nacional': 'Perfil nacional'}
ACCIONES = {'ver': 'Ver y consultar', 'agregar': 'Agregar', 'editar': 'Editar', 'borrar': 'Borrar'}


@lru_cache(maxsize=2)
def _leer(ruta, _mtime):
    return Path(ruta).read_text(encoding='utf-8')


def _texto(ruta):
    return _leer(str(ruta), ruta.stat().st_mtime)


def _quitar_capitulo(html, cid):
    html = re.sub(r'\s*<!-- \d+ -->\s*(?=<section class="capitulo" id="%s">)' % cid, '\n', html)
    html = re.sub(r'<section class="capitulo" id="%s">.*?</section>\s*' % cid, '', html, flags=re.S)
    return re.sub(r'\s*<li><a href="#%s">.*?</li>' % cid, '', html, flags=re.S)


def _bloque(html, clave, mantener):
    patron = r'<!--si:%s-->(.*?)<!--/si:%s-->' % (clave, clave)
    return re.sub(patron, (lambda m: m.group(1)) if mantener else '', html, flags=re.S)


def _renumerar(html):
    n = 0

    def num(m):
        nonlocal n
        n += 1
        return f'{m.group(1)}{n}{m.group(2)}'
    html = re.sub(r'(<section class="capitulo"[^>]*>\s*<header><span class="num"[^>]*>)\d+(</span>)', num, html)
    return re.sub(r'\s*<!-- \d+ -->\s*\n', '\n', html)


def _recuadro_perfil(perfil, user):
    region = perfil.region if perfil.solo_su_region and perfil.region else 'todas las regiones'
    tipo = 'Administrador/a de la plataforma' if user.is_superuser else NOMBRES_TIPO.get(perfil.tipo, perfil.tipo)
    secciones = ''.join(f'<li>{escape(NOMBRES_SECCION.get(s, s))}</li>' for s in perfil.secciones_visibles())
    acciones = ''.join(f'<li>{escape(n)}</li>' for a, n in ACCIONES.items() if perfil.puede(a))
    return f'''
    <section class="mi-perfil" aria-label="Su perfil">
      <h2>Este manual está adaptado a su perfil</h2>
      <p><strong>{escape(tipo)}</strong> · ve datos de {escape(region)}</p>
      <p>Secciones que usted ve:</p><ul>{secciones}</ul>
      <p>Lo que puede hacer:</p><ul>{acciones}</ul>
    </section>'''


def construir(user=None, perfil=None, general=False):
    html = _texto(PLANTILLA)
    if general or perfil is None:
        secs = {'portada', 'resumen_inv', 'resumen_film', 'busqueda', 'exportar'}
        superusuario = False
    else:
        secs = set(perfil.secciones_visibles())
        superusuario = user.is_superuser

    for cid, requeridas in CAPITULOS.items():
        if not secs & requeridas:
            html = _quitar_capitulo(html, cid)
    html = _bloque(html, 'busqueda', 'busqueda' in secs)
    html = _bloque(html, 'exportar', 'exportar' in secs)
    titulo = ('Buscar y exportar' if {'busqueda', 'exportar'} <= secs
              else 'Buscar un trámite' if 'busqueda' in secs else 'Exportar')
    html = re.sub(r'<!--titulo-buscar-->.*?<!--/titulo-buscar-->', titulo, html)

    if superusuario:
        html = html.replace('<!--INDICE-ADMIN-->', '        <li><a href="#administrar">Administrar usuarios</a></li>')
        html = html.replace('<!--CAPITULO-ADMIN-->', _texto(ADMIN))
    html = html.replace('<!--INDICE-ADMIN-->\n', '').replace('<!--CAPITULO-ADMIN-->\n', '')
    html = html.replace('<!--PERFIL-->', '' if general or perfil is None else _recuadro_perfil(perfil, user))
    return _renumerar(html)
