"""Pruebas de seguridad y permisos. Corren en CI (GitHub Actions) y localmente con:
    docker compose exec app sh -c "pip install -q -r requirements-dev.txt && pytest -q"
"""
import json
import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import Client

from tramites.api import _url_de_cerofilas
from tramites.models import PerfilUsuario, secciones_por_defecto
from tramites.views import _inv_html

CLAVE = 'ClaveDePrueba-2026'


@pytest.fixture(autouse=True)
def _limpiar_cache(settings):
    settings.CACHES = {'default': {'BACKEND': 'django.core.cache.backends.locmem.LocMemCache'}}
    cache.clear()


def _usuario(email, superusuario=False, region='', **perfil):
    User = get_user_model()
    u = (User.objects.create_superuser if superusuario else User.objects.create_user)(
        username=email, email=email, password=CLAVE)
    PerfilUsuario.objects.create(user=u, tipo=perfil.pop('tipo', 'inv'), region=region,
                                 secciones=perfil.pop('secciones', secciones_por_defecto('inv')),
                                 debe_cambiar_password=perfil.pop('debe_cambiar_password', False), **perfil)
    return u


def _cliente(user, csrf=False):
    c = Client(enforce_csrf_checks=csrf)
    c.force_login(user)
    return c


# ─── Proxy de adjuntos: el token de CeroFilas solo viaja a CeroFilas ─────────
@pytest.mark.parametrize('url,esperado', [
    ('https://conaf.cerofilas.gob.cl/uploads/a.pdf', True),
    ('https://conaf.cerofilas.gob.cl.atacante.com/a.pdf', False),
    ('https://conaf.cerofilas.gob.cl@atacante.com/a.pdf', False),
    ('http://conaf.cerofilas.gob.cl/a.pdf', False),
    ('https://conaf.cerofilas.gob.cl:8443/a.pdf', False),
    ('https://atacante.com/?https://conaf.cerofilas.gob.cl', False),
    ('javascript:alert(1)', False),
])
def test_url_de_cerofilas(url, esperado):
    assert _url_de_cerofilas(url) is esperado


# ─── Acceso ───────────────────────────────────────────────────────────────────
@pytest.mark.django_db
def test_api_exige_sesion():
    assert Client().get('/api/me').status_code == 401


@pytest.mark.django_db
def test_salud_publica():
    r = Client().get('/salud')
    assert r.status_code == 200 and r.json() == {'ok': True}


@pytest.mark.django_db
def test_encargado_no_administra_usuarios():
    enc = _usuario('enc@conaf.cl', region='Maule', solo_su_region=True)
    assert _cliente(enc).get('/api/usuarios').status_code == 403


@pytest.mark.django_db
def test_clave_temporal_bloquea_api():
    u = _usuario('nuevo@conaf.cl', debe_cambiar_password=True)
    assert _cliente(u).get('/api/me').status_code in (401, 403)


@pytest.mark.django_db
def test_superusuario_lista_usuarios():
    adm = _usuario('admin@conaf.cl', superusuario=True, secciones=[])
    r = _cliente(adm).get('/api/usuarios')
    assert r.status_code == 200 and r.json()['ok']


# ─── CSRF en operaciones que modifican datos ─────────────────────────────────
@pytest.mark.django_db
def test_api_post_sin_csrf_rechazado():
    adm = _usuario('admin@conaf.cl', superusuario=True, secciones=[])
    c = _cliente(adm, csrf=True)
    r = c.post('/api/usuarios', data={'email': 'x@conaf.cl'}, content_type='application/json')
    assert r.status_code == 401
    assert not get_user_model().objects.filter(username='x@conaf.cl').exists()


@pytest.mark.django_db
def test_api_post_con_csrf_aceptado():
    adm = _usuario('admin@conaf.cl', superusuario=True, secciones=[])
    c = _cliente(adm, csrf=True)
    c.get('/')                                    # la portada entrega la cookie csrftoken
    token = c.cookies['csrftoken'].value
    r = c.post('/api/usuarios', data={'email': 'x@conaf.cl', 'tipo': 'inv'},
               content_type='application/json', HTTP_X_CSRFTOKEN=token)
    assert r.status_code == 200, r.content


# ─── Subida de archivos ───────────────────────────────────────────────────────
@pytest.mark.django_db
@pytest.mark.parametrize('tid', ['../../etc', '12/../..', 'abc', '1' * 20])
def test_subida_rechaza_id_invalido(tid):
    u = _usuario('sube@conaf.cl', puede_agregar=True)
    r = _cliente(u).post('/api/investigaciones/upload', data={'nombre': 'Ana Pérez', 'tramite_id': tid})
    assert r.status_code == 400


@pytest.mark.django_db
def test_subida_requiere_permiso_agregar():
    u = _usuario('lector@conaf.cl')
    r = _cliente(u).post('/api/investigaciones/upload', data={'nombre': 'Ana', 'tramite_id': '123'})
    assert r.status_code == 403


@pytest.mark.django_db
def test_investigaciones_no_sale_de_su_carpeta():
    u = _usuario('lee@conaf.cl')
    assert _cliente(u).get('/investigaciones/../config/settings.py').status_code in (403, 404)


def test_listado_de_archivos_escapa_html():
    html = _inv_html('<script>x</script>', [{'url': '/investigaciones/a"><b', 'nombre': '<img src=x onerror=alert(1)>',
                                             'size_kb': 1}])
    assert '<script>x' not in html and '<img src=x' not in html


# ─── Ingreso ──────────────────────────────────────────────────────────────────
@pytest.mark.django_db
def test_bloqueo_tras_intentos_fallidos():
    _usuario('victima@conaf.cl')
    c = Client()
    for _ in range(5):
        c.post('/login/', {'username': 'victima@conaf.cl', 'password': 'mala'})
    r = c.post('/login/', {'username': 'victima@conaf.cl', 'password': CLAVE})
    assert '_auth_user_id' not in c.session
    assert 'Demasiados intentos' in r.content.decode()


@pytest.mark.django_db
def test_ingreso_correcto_sin_distinguir_mayusculas():
    _usuario('ana@conaf.cl')
    c = Client()
    c.post('/login/', {'username': 'ANA@conaf.cl', 'password': CLAVE})
    assert '_auth_user_id' in c.session


@pytest.mark.django_db
def test_cambio_de_clave_rechaza_claves_debiles():
    u = _usuario('ana@conaf.cl')
    c = _cliente(u)
    r = c.post('/cambiar-clave/', {'actual': CLAVE, 'nueva': '12345678', 'repetir': '12345678'})
    assert r.status_code == 200 and ('común' in r.content.decode() or 'números' in r.content.decode())
    u.refresh_from_db()
    assert u.check_password(CLAVE)


# ─── Aviso del tutorial ───────────────────────────────────────────────────────
@pytest.mark.django_db
def test_aviso_tutorial_una_vez_por_ingreso_y_se_puede_desactivar():
    _usuario('ana@conaf.cl')
    c = Client()
    c.post('/login/', {'username': 'ana@conaf.cl', 'password': CLAVE})
    assert 'tuto-aviso' in c.get('/').content.decode()          # al ingresar
    assert 'tuto-aviso' not in c.get('/').content.decode()      # no en cada recarga
    c.get('/')
    token = c.cookies['csrftoken'].value
    assert c.post('/api/me/tutorial', data={'ocultar': True}, content_type='application/json',
                  HTTP_X_CSRFTOKEN=token).json()['ver_tutorial'] is False
    c.post('/logout/')
    c.post('/login/', {'username': 'ana@conaf.cl', 'password': CLAVE})
    assert 'tuto-aviso' not in c.get('/').content.decode()      # ya no se ofrece
    assert c.get('/manual/').status_code == 200


@pytest.mark.django_db
def test_manual_requiere_sesion():
    assert Client().get('/manual/').status_code == 302


@pytest.mark.django_db
def test_manual_pdf_requiere_sesion_y_se_descarga():
    assert Client().get('/manual/pdf').status_code == 302
    r = _cliente(_usuario('ana@conaf.cl')).get('/manual/pdf')
    assert r.status_code == 200 and r['Content-Type'] == 'application/pdf'
    assert 'attachment' in r['Content-Disposition']


# ─── Dependencias externas (cadena de suministro) ────────────────────────────
CDN_PROHIBIDOS = ('jsdelivr', 'unpkg.com', 'cdnjs.cloudflare', 'fonts.googleapis', 'fonts.gstatic',
                  'code.jquery', 'ajax.googleapis', 'cdn.tailwindcss')


def test_sin_recursos_de_cdn_externos():
    """Todo JS/CSS/fuente debe estar alojado localmente (requerimiento Cyber SOC SBAP)."""
    from pathlib import Path
    raiz = Path(__file__).resolve().parents[2]
    archivos = [*raiz.glob('templates/*.html'), *raiz.glob('static/js/*.js'), *raiz.glob('static/css/*.css')]
    hallazgos = [f'{a.name}: {c}' for a in archivos for c in CDN_PROHIBIDOS if c in a.read_text(encoding='utf-8')]
    assert not hallazgos, hallazgos


@pytest.mark.django_db
def test_csp_bloquea_scripts_de_otros_dominios():
    csp = Client().get('/login/')['Content-Security-Policy']
    assert "script-src 'self' 'unsafe-inline'" in csp and 'jsdelivr' not in csp and "object-src 'none'" in csp


# ─── Manual personalizado ─────────────────────────────────────────────────────
@pytest.mark.django_db
def test_manual_sin_administracion_para_encargados():
    enc = _usuario('enc@conaf.cl', region='Maule', solo_su_region=True, secciones=['portada', 'resumen_film'])
    html = _cliente(enc).get('/manual/').content.decode()
    assert 'Administrar usuarios' not in html and '/manual/img/' not in html
    assert 'id="resumen"' in html and 'id="buscar"' not in html            # sin Búsqueda ni Exportar
    assert 'Maule' in html and 'Filmación y Fotografía · Resumen' in html  # recuadro de su perfil
    assert _cliente(enc).get('/manual/img/usuarios.jpg').status_code == 404


@pytest.mark.django_db
def test_manual_del_superusuario_incluye_administracion():
    adm = _usuario('admin@conaf.cl', superusuario=True, secciones=[])
    c = _cliente(adm)
    assert 'Administrar usuarios' in c.get('/manual/').content.decode()
    assert c.get('/manual/img/usuarios.jpg').status_code == 200
    assert 'Administrar usuarios' not in c.get('/manual/?general=1').content.decode()   # base del PDF


# ─── Envío de correos (Numeral 6) desactivado ────────────────────────────────
@pytest.mark.django_db
def test_envio_de_correos_desactivado():
    adm = _usuario('admin@conaf.cl', superusuario=True, secciones=[])
    c = _cliente(adm)
    assert 'btn-abrir-correos' not in c.get('/').content.decode()
    for ruta in ('/api/email/send', '/api/email/draft'):
        r = c.post(ruta, data={'email': {'to_email': 'x@y.cl'}}, content_type='application/json')
        assert r.status_code == 403


# ─── Búsqueda: índice de todos los años ──────────────────────────────────────
def _tramite_falso(tid, region):
    return {'id': tid, 'proceso_id': 517, 'estado': 'pendiente', 'nombre_solicitante': 'Ana Pérez',
            'email_solicitante': 'ana@u.cl', 'regiones_list': [region], 'areas_protegidas': ['PN Conguillío'],
            'etapa_actual': {'tarea_nombre': 'Revisión', 'nombres': 'Funcionario Secreto', 'email': 'f@conaf.cl'},
            'datos_raw': {'titulo_investigacion': 'Aves'}}


@pytest.fixture
def _indice_falso(monkeypatch):
    import tramites.api as api_mod
    monkeypatch.setattr(api_mod, '_anios_busqueda',
                        lambda: ([_tramite_falso(1, 'Araucanía'), _tramite_falso(2, 'Maule')], []))


@pytest.mark.django_db
def test_indice_de_busqueda_respeta_region_y_omite_funcionarios(_indice_falso):
    import gzip
    assert Client().get('/api/buscar/indice').status_code == 401
    enc = _usuario('enc@conaf.cl', region='Maule', solo_su_region=True, secciones=['busqueda'])
    r = _cliente(enc).get('/api/buscar/indice', HTTP_ACCEPT_ENCODING='gzip')
    assert r['Content-Encoding'] == 'gzip'
    cuerpo = gzip.decompress(r.content).decode()
    datos = json.loads(cuerpo)['data']
    assert [d['id'] for d in datos] == [2] and 'Funcionario Secreto' not in cuerpo
    sin = _usuario('sin@conaf.cl', secciones=['portada'])
    assert _cliente(sin).get('/api/buscar/indice').status_code == 403


@pytest.mark.django_db
def test_excel_de_busqueda_solo_incluye_la_region_del_perfil(_indice_falso, monkeypatch):
    import tramites.api as api_mod
    vistos = []
    monkeypatch.setattr(api_mod, 'build_tramites_excel', lambda ts, m: (vistos.extend(t['id'] for t in ts), __import__('io').BytesIO(b'x'))[1])
    enc = _usuario('enc@conaf.cl', region='Maule', solo_su_region=True, secciones=['busqueda', 'exportar'])
    r = _cliente(enc).post('/api/buscar/excel', data={'ids': [1, 2]}, content_type='application/json')
    assert r.status_code == 200 and vistos == [2]
