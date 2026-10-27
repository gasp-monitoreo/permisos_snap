"""Portal del investigador: aislamiento de las cuentas externas, vencimiento, registro
geográfico (validación e importación) y generación de accesos."""
import json
from datetime import date, timedelta

import pytest
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import Client

from tramites.geo import GeoError, importar, validar_geometria
from tramites.models import AccesoInvestigador, RegistroGeografico
from tramites.tests.test_seguridad import _cliente, _usuario

CLAVE = 'ClaveDePrueba-2026'
PUNTO = {'type': 'Point', 'coordinates': [-71.94, -39.27]}


def _investigador(tramite_id=111, vence=None, regiones=('Araucanía',), **kw):
    u = get_user_model().objects.create_user(username=f'inv{tramite_id}-ab12', password=CLAVE)
    AccesoInvestigador.objects.create(user=u, tramite_id=tramite_id, vence=vence or date.today() + timedelta(days=30),
                                      regiones=list(regiones), **kw)
    return u


def _post(c, url, datos):
    return c.post(url, data=json.dumps(datos), content_type='application/json')


# ─── Aislamiento ──────────────────────────────────────────────────────────────
@pytest.mark.django_db
@pytest.mark.parametrize('ruta', ['/', '/manual/', '/investigaciones/', '/cambiar-clave/'])
def test_investigador_no_entra_a_la_plataforma_interna(ruta):
    r = _cliente(_investigador()).get(ruta)
    assert r.status_code == 302 and r['Location'] == '/portal/'


@pytest.mark.django_db
@pytest.mark.parametrize('ruta', ['/api/me', '/api/tramites', '/api/usuarios', '/api/accesos'])
def test_investigador_no_usa_la_api_interna(ruta):
    assert _cliente(_investigador()).get(ruta).status_code in (401, 403)


@pytest.mark.django_db
def test_acceso_vencido_o_revocado_cierra_la_sesion():
    c = _cliente(_investigador(vence=date.today() - timedelta(days=1)))
    r = c.get('/portal/')
    assert r.status_code == 302 and 'vencido=1' in r['Location']
    assert '_auth_user_id' not in c.session
    c2 = _cliente(_investigador(tramite_id=222, revocado=True))
    assert c2.get('/portal/api/registros').status_code == 302


@pytest.mark.django_db
def test_usuario_interno_no_usa_el_portal():
    r = _cliente(_usuario('ana@conaf.cl')).get('/portal/')
    assert r.status_code == 302 and r['Location'] == '/'


@pytest.mark.django_db
def test_ingreso_del_investigador_lleva_al_portal():
    _investigador()
    c = Client()
    r = c.post('/portal/ingresar', {'username': 'inv111-ab12', 'password': CLAVE})
    assert r.status_code == 302 and r['Location'] == '/portal/'
    assert c.get('/portal/').status_code == 200
    assert AccesoInvestigador.objects.get(tramite_id=111).ultimo_ingreso is not None


# ─── Registros ────────────────────────────────────────────────────────────────
@pytest.mark.django_db
def test_crear_editar_y_borrar_solo_lo_propio():
    c = _cliente(_investigador())
    r = _post(c, '/portal/api/registros/crear', {'geometria': PUNTO, 'nombre': 'Cámara 1', 'categoria': 'camara',
                                                 'atributos': {'altura_cm': 40}})
    assert r.status_code == 200, r.content
    rid = r.json()['features'][0]['id']
    otro = RegistroGeografico.objects.create(tramite_id=999, tipo='punto', geometria=PUNTO, nombre='ajeno')
    assert _post(c, f'/portal/api/registros/{otro.id}', {'geometria': PUNTO, 'nombre': 'x'}).status_code == 404
    assert _post(c, f'/portal/api/registros/{otro.id}/borrar', {}).status_code == 404
    assert [f['id'] for f in c.get('/portal/api/registros').json()['features']] == [rid]
    assert _post(c, f'/portal/api/registros/{rid}/borrar', {}).status_code == 200


@pytest.mark.django_db
def test_rechaza_coordenadas_fuera_de_chile_y_sin_csrf():
    u = _investigador()
    c = _cliente(u)
    r = _post(c, '/portal/api/registros/crear', {'geometria': {'type': 'Point', 'coordinates': [2.35, 48.85]}, 'nombre': 'París'})
    assert r.status_code == 400 and 'fuera de Chile' in r.json()['error']
    c2 = _cliente(u, csrf=True)
    assert _post(c2, '/portal/api/registros/crear', {'geometria': PUNTO, 'nombre': 'x'}).status_code == 403


def test_validacion_cierra_poligonos_y_exige_vertices():
    g = validar_geometria({'type': 'Polygon', 'coordinates': [[[-72, -39], [-72.1, -39], [-72.1, -39.1]]]})
    assert g['coordinates'][0][0] == g['coordinates'][0][-1]
    with pytest.raises(GeoError):
        validar_geometria({'type': 'LineString', 'coordinates': [[-72, -39]]})


# ─── Importación de archivos ──────────────────────────────────────────────────
def test_importa_kml_gpx_csv_y_geojson():
    kml = b'''<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>
      <Placemark><name>P1</name><Point><coordinates>-71.9,-39.2,0</coordinates></Point></Placemark>
      <Placemark><name>Parcela</name><Polygon><outerBoundaryIs><LinearRing><coordinates>
        -71.9,-39.2 -71.91,-39.2 -71.91,-39.21 -71.9,-39.2</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
      </Document></kml>'''
    els, _ = importar('sitios.kml', kml)
    assert [e['tipo'] for e in els] == ['punto', 'poligono'] and els[0]['nombre'] == 'P1'

    gpx = b'''<gpx><wpt lat="-39.2" lon="-71.9"><name>W</name></wpt>
      <trk><name>T</name><trkseg><trkpt lat="-39.2" lon="-71.9"/><trkpt lat="-39.21" lon="-71.91"/></trkseg></trk></gpx>'''
    assert [e['tipo'] for e in importar('ruta.gpx', gpx)[0]] == ['punto', 'linea']

    csv = 'nombre;latitud;longitud;especie\nC1;-39,27;-71,94;Pudu puda\nC2;39.28;71.95;Puma concolor\n'.encode()
    els, _ = importar('camaras.csv', csv)
    assert len(els) == 2 and els[1]['geometry']['coordinates'] == [-71.95, -39.28]
    assert els[0]['atributos']['especie'] == 'Pudu puda'

    utm = b'este,norte\n673000,5652100\n'
    lon, lat = importar('utm.csv', utm, huso=18)[0][0]['geometry']['coordinates']
    assert -74 < lon < -72 and -40 < lat < -38

    gj = json.dumps({'type': 'FeatureCollection', 'features': [
        {'type': 'Feature', 'properties': {'name': 'M'}, 'geometry': {'type': 'MultiPoint', 'coordinates': [[-71.9, -39.2], [-71.8, -39.3]]}}]}).encode()
    assert len(importar('a.geojson', gj)[0]) == 2


def test_importar_rechaza_formatos_desconocidos():
    with pytest.raises(GeoError):
        importar('virus.exe', b'MZ')


@pytest.mark.django_db
def test_importar_por_el_portal_no_guarda_hasta_confirmar():
    c = _cliente(_investigador())
    f = SimpleUploadedFile('p.csv', b'lat,lon\n-39.2,-71.9\n', content_type='text/csv')
    r = c.post('/portal/api/importar', {'archivo': f})
    assert r.status_code == 200 and len(r.json()['elementos']) == 1
    assert RegistroGeografico.objects.count() == 0


# ─── Accesos (superusuario) ───────────────────────────────────────────────────
@pytest.mark.django_db
def test_superusuario_genera_acceso_y_la_clave_sirve(monkeypatch):
    import tramites.api as api_mod
    monkeypatch.setattr(api_mod, 'normalize_tramite', lambda t: t)
    monkeypatch.setattr(api_mod, 'api_get', lambda url: {'tramite': {
        'id': 555, 'proceso_id': 517, 'nombre_solicitante': 'Ana Pérez', 'areas_protegidas': ['Parque Nacional Conguillío'],
        'regiones_list': ['Araucanía'], 'datos_raw': {'fecha_inicio_actividades': '01-11-2026', 'fecha_termino_actividades': '31-12-2026'}}})
    adm = _usuario('admin@conaf.cl', superusuario=True, secciones=[])
    r = _post(_cliente(adm), '/api/accesos', {'tramite_id': 555})
    assert r.status_code == 200, r.content
    d = r.json()
    assert d['acceso']['vence'] == '2027-03-31' and d['enlace'].endswith('/portal/ingresar')
    c = Client()
    c.post('/portal/ingresar', {'username': d['acceso']['usuario'], 'password': d['clave']})
    assert c.get('/portal/').status_code == 200
    # un encargado sin superusuario no puede generar accesos
    enc = _usuario('enc@conaf.cl', region='Maule', solo_su_region=True)
    assert _post(_cliente(enc), '/api/accesos', {'tramite_id': 555}).status_code == 403


@pytest.mark.django_db
def test_encargado_regional_solo_ve_registros_de_su_region():
    _investigador(tramite_id=777, regiones=('Araucanía',))
    RegistroGeografico.objects.create(tramite_id=777, tipo='punto', geometria=PUNTO, nombre='P')
    maule = _usuario('enc@conaf.cl', region='Maule', solo_su_region=True)
    arauc = _usuario('enc2@conaf.cl', region='Araucanía', solo_su_region=True)
    assert _cliente(maule).get('/api/tramites/777/registro-geografico').status_code == 403
    r = _cliente(arauc).get('/api/tramites/777/registro-geografico')
    assert r.status_code == 200 and len(r.json()['features']) == 1 and r.json()['acceso'] is None


# ─── Vista territorial ────────────────────────────────────────────────────────
@pytest.mark.django_db
def test_territorio_respeta_la_region_del_perfil():
    enc = _usuario('enc@conaf.cl', region='Maule', solo_su_region=True)
    assert _cliente(enc).get('/api/territorio?tipo=inv').status_code == 403
    assert _cliente(enc).get('/api/territorio?tipo=inv&region=Araucanía').status_code == 403
    assert _cliente(enc).get('/api/territorio?tipo=otro&region=Maule').status_code == 400


def test_superposiciones_entre_permisos_distintos():
    from tramites.api import _superposiciones
    cuadro = lambda x: {'type': 'Polygon', 'coordinates': [[[x, -39], [x + .01, -39], [x + .01, -39.01], [x, -39.01], [x, -39]]]}
    regs = [RegistroGeografico(tramite_id=1, tipo='poligono', geometria=cuadro(-72)),
            RegistroGeografico(tramite_id=2, tipo='poligono', geometria=cuadro(-71.995)),   # se cruza con el 1
            RegistroGeografico(tramite_id=3, tipo='punto', geometria={'type': 'Point', 'coordinates': [-71.5, -39.5]}),
            RegistroGeografico(tramite_id=1, tipo='punto', geometria={'type': 'Point', 'coordinates': [-71.9995, -39.0005]})]
    assert _superposiciones([], regs) == [{'a': 1, 'b': 2}]


# ─── Mi permiso ───────────────────────────────────────────────────────────────
@pytest.fixture
def _tramite_vivo(monkeypatch):
    import tramites.portal as portal
    t = {'id': 111, 'estado': 'completado', 'recepcion_pendiente': False, 'fecha_resolucion': '2026-05-01',
         'areas_protegidas': ['PN Conguillío'], 'regiones_list': ['Araucanía'], 'porcentaje_avance': 100,
         'etapas': [{'tarea_nombre': 'Evaluación técnica', 'estado': 'completado', 'nombres': 'Funcionaria Secreta',
                     'email': 'func@conaf.cl', 'fecha_inicio': '2026-04-01', 'fecha_termino': '2026-04-20'}],
         'datos_raw': {'titulo_investigacion': 'Aves del bosque', 'resolucion': 'abc123def456ghi789jk.pdf',
                       'carta_de_compromiso': 'xyz123def456ghi789jk.pdf', 'otro_campo': 'texto libre'}}
    monkeypatch.setattr(portal, '_tramite_vivo', lambda tid: t)
    return t


@pytest.mark.django_db
def test_mi_permiso_muestra_estado_y_documentos_sin_funcionarios(_tramite_vivo):
    c = _cliente(_investigador())
    r = c.get('/portal/api/permiso')
    p = r.json()['permiso']
    assert p['estado'] == 'Aprobado' and p['titulo'] == 'Aves del bosque'
    assert [d['clave'] for d in p['documentos']] == ['resolucion', 'carta_de_compromiso'] and p['documentos'][0]['resolucion']
    assert 'Funcionaria Secreta' not in r.content.decode() and 'func@conaf.cl' not in r.content.decode()


class _Resp:
    def __init__(self, status, cuerpo=b'%PDF-1.4 prueba', ct='application/pdf'):
        import io
        self.status_code, self.headers = status, {'Content-Type': ct}
        self.raw = io.BytesIO(cuerpo)
        self.raw.read = (lambda f: lambda n=-1, decode_content=True: f(n))(self.raw.read)


@pytest.fixture
def _cerofilas(monkeypatch, settings, tmp_path):
    """Simula /uploads/datos/ de Cero Filas y registra las URL pedidas."""
    import tramites.adjuntos as adj
    settings.ADJUNTOS_CACHE_DIR = str(tmp_path)
    pedidas, estado = [], {'status': 200, 'cuerpo': b'%PDF-1.4 prueba'}
    monkeypatch.setattr(adj.requests, 'get', lambda url, **kw: (pedidas.append(url), _Resp(estado['status'], estado['cuerpo']))[1])
    return pedidas, estado


@pytest.mark.django_db
def test_documento_solo_de_campos_del_propio_tramite(_tramite_vivo, _cerofilas):
    pedidas, estado = _cerofilas
    estado['status'] = 404
    c = _cliente(_investigador())
    assert c.get('/portal/api/documento/otro_campo').status_code == 404        # no es un archivo
    assert c.get('/portal/api/documento/no_existe').status_code == 404
    r = c.get('/portal/api/documento/resolucion')
    assert r.status_code == 502 and 'Cero Filas' in r.content.decode()      # página de ayuda
    assert pedidas == ['https://conaf.cerofilas.gob.cl/uploads/datos/abc123def456ghi789jk.pdf']


@pytest.mark.django_db
def test_portal_entrega_la_resolucion_desde_cero_filas(_tramite_vivo, _cerofilas):
    r = _cliente(_investigador()).get('/portal/api/documento/resolucion')
    assert r.status_code == 200 and r['Content-Type'] == 'application/pdf' and r.content.startswith(b'%PDF')


# ─── Adjuntos en la plataforma interna ────────────────────────────────────────
@pytest.fixture
def _tramite_interno(monkeypatch):
    import tramites.adjuntos as adj
    t = {'id': 500, 'estado': 'completado', 'etapas_completadas': 2, 'regiones_list': ['Araucanía'], 'nombre_solicitante': 'Ana',
         'datos_raw': {'autorizacion': 'Res0123456789abcdef.pdf', 'curriculo': 'Cv0123456789abcdef.pdf',
                       'url_externa': 'https://atacante.com/x.pdf', 'texto': 'hola'}}
    monkeypatch.setattr(adj, 'tramite_vivo', lambda tid: t)
    return t


@pytest.mark.django_db
def test_adjunto_se_abre_sin_cerofilas_y_respeta_region(_tramite_interno, _cerofilas):
    pedidas, _ = _cerofilas
    arauc = _usuario('a@conaf.cl', region='Araucanía', solo_su_region=True, puede_editar=True)
    r = _cliente(arauc).get('/api/tramites/500/adjuntos/autorizacion')
    assert r.status_code == 200 and r['Content-Disposition'].startswith('inline') and r['X-Frame-Options'] == 'SAMEORIGIN'
    assert pedidas == ['https://conaf.cerofilas.gob.cl/uploads/datos/Res0123456789abcdef.pdf']
    _cliente(arauc).get('/api/tramites/500/adjuntos/autorizacion')
    assert len(pedidas) == 1                                   # la segunda vez sale de la caché temporal
    maule = _usuario('m@conaf.cl', region='Maule', solo_su_region=True)
    assert _cliente(maule).get('/api/tramites/500/adjuntos/autorizacion').status_code == 403
    for clave in ('url_externa', 'texto', 'no_existe'):        # el archivo siempre sale del trámite
        assert _cliente(arauc).get(f'/api/tramites/500/adjuntos/{clave}').status_code == 404


@pytest.mark.django_db
def test_zip_de_adjuntos_del_tramite(_tramite_interno, _cerofilas):
    import io, zipfile
    r = _cliente(_usuario('a@conaf.cl', puede_editar=True)).get('/api/tramites/500/adjuntos.zip')
    assert sorted(zipfile.ZipFile(io.BytesIO(r.content)).namelist()) == ['500_autorizacion.pdf', '500_curriculo.pdf']


@pytest.mark.django_db
def test_zip_de_resoluciones_con_indice_y_region(_cerofilas, monkeypatch):
    import io, zipfile
    import tramites.api as api_mod
    from tramites.adjuntos import MAX_ZIP_TRAMITES
    def t(i, reg):
        return {'id': i, 'proceso_id': 517, 'estado': 'completado', 'etapas_completadas': 2, 'regiones_list': [reg],
                'nombre_solicitante': f'Persona {i}', 'datos_raw': {'autorizacion': f'Res{i:016d}.pdf'}}
    monkeypatch.setattr(api_mod, '_anios_busqueda', lambda: ([t(i, 'Maule' if i % 2 else 'Araucanía') for i in range(1, 400)], []))
    enc = _usuario('m@conaf.cl', region='Maule', solo_su_region=True, secciones=['busqueda', 'exportar'])
    r = _post(_cliente(enc), '/api/buscar/resoluciones.zip', {'ids': list(range(1, 400))})
    nombres = zipfile.ZipFile(io.BytesIO(r.content)).namelist()
    assert 'indice.csv' in nombres and all(n.startswith('Maule/') for n in nombres if n != 'indice.csv')
    assert len(nombres) - 1 <= MAX_ZIP_TRAMITES



# ─── Protección de datos (Ley N°21.719) ──────────────────────────────────────
def _pdf_con_datos():
    import fitz
    doc = fitz.open()
    pag = doc.new_page()
    pag.insert_text((50, 80), 'Autorización de investigación N° 14/2026. Se autoriza a Ana Pérez,', fontsize=10)
    pag.insert_text((50, 100), 'RUT 12.345.678-9, correo ana.perez@gmail.com, teléfono +56 9 8765 4321,', fontsize=10)
    pag.insert_text((50, 120), 'para trabajar en el Parque Nacional Conguillío durante la temporada 2026.', fontsize=10)
    return doc.tobytes()


@pytest.mark.django_db
def test_sin_rol_editor_el_pdf_llega_tachado_y_la_identidad_no(_tramite_interno, _cerofilas):
    import fitz
    _, estado = _cerofilas
    estado['cuerpo'] = _pdf_con_datos()
    lector = _usuario('lector@conaf.cl')
    r = _cliente(lector).get('/api/tramites/500/adjuntos/autorizacion')
    assert r.status_code == 200
    texto = ''.join(p.get_text() for p in fitz.open(stream=r.content, filetype='pdf'))
    assert '12.345.678-9' not in texto and 'ana.perez@gmail.com' not in texto and '8765' not in texto
    assert 'Conguillío' in texto                                    # el contenido del permiso se mantiene
    r = _cliente(lector).get('/api/tramites/500/adjuntos/curriculo')
    assert r.status_code == 403 and 'Ley N°21.719' in r.content.decode()
    editor = _usuario('editor@conaf.cl', puede_editar=True)
    texto = ''.join(p.get_text() for p in fitz.open(stream=_cliente(editor).get('/api/tramites/500/adjuntos/autorizacion').content, filetype='pdf'))
    assert '12.345.678-9' in texto                                  # el Editor ve el original


def test_redaccion_de_textos_y_correos():
    from tramites.privacidad import BLOCK, redactar, seudonimo_email, tramite
    t = tramite({'email_solicitante': 'ana@u.cl', 'datos_raw': {'rut': '12345678-9', 'telefono_movil': '987654321',
          'objetivos': 'Contacto ana@u.cl o +56 9 1234 5678; punto -39.2731, -71.9415', 'titulo_investigacion': 'Aves'},
          'etapas': [{'email': 'func@conaf.cl', 'nombres': 'Func'}, {'email': 'ana@u.cl'}]})
    assert t['email_solicitante'] == BLOCK and t['datos_raw']['rut'] == BLOCK and t['datos_raw']['telefono_movil'] == BLOCK
    assert 'ana@u.cl' not in t['datos_raw']['objetivos'] and '1234' not in t['datos_raw']['objetivos'] and '-71.9415' not in t['datos_raw']['objetivos']
    assert t['datos_raw']['titulo_investigacion'] == 'Aves'
    assert t['etapas'][0]['email'] == 'func@conaf.cl' and t['etapas'][0]['nombres'] == 'Func'   # funcionario público: visible
    assert t['etapas'][1]['email'] == BLOCK                                                        # particular: protegido
    assert redactar('18840826-5') == BLOCK


@pytest.mark.django_db
def test_indice_y_registro_protegidos_para_lector(monkeypatch):
    import gzip, json as js
    import tramites.api as api_mod
    t = {'id': 9, 'proceso_id': 517, 'estado': 'pendiente', 'nombre_solicitante': 'Ana', 'email_solicitante': 'ana@u.cl',
         'regiones_list': ['Maule'], 'areas_protegidas': [], 'etapas_completadas': 1,
         'etapa_actual': {'email': 'f@conaf.cl', 'tarea_nombre': 'Revisión'}, 'datos_raw': {'descripcion': 'fono 987654321'}}
    monkeypatch.setattr(api_mod, '_anios_busqueda', lambda: ([t], []))
    lector = _usuario('lector@conaf.cl', secciones=['busqueda'])
    cuerpo = gzip.decompress(_cliente(lector).get('/api/buscar/indice', HTTP_ACCEPT_ENCODING='gzip').content).decode()
    assert 'ana@u.cl' not in cuerpo and '987654321' not in cuerpo
    editor = _usuario('editor@conaf.cl', secciones=['busqueda'], puede_editar=True)
    assert 'ana@u.cl' in gzip.decompress(_cliente(editor).get('/api/buscar/indice', HTTP_ACCEPT_ENCODING='gzip').content).decode()
    _investigador(tramite_id=9, regiones=('Maule',))
    RegistroGeografico.objects.create(tramite_id=9, tipo='punto', geometria={'type': 'Point', 'coordinates': [-71.941532, -39.273112]}, nombre='P')
    f = _cliente(lector).get('/api/tramites/9/registro-geografico').json()['features'][0]
    assert f['geometry']['coordinates'] == [-71.94, -39.27]                    # ~1 km
    assert _cliente(editor).get('/api/tramites/9/registro-geografico').json()['features'][0]['geometry']['coordinates'] == [-71.941532, -39.273112]


# ─── Informe PDF del permiso ──────────────────────────────────────────────────
@pytest.mark.django_db
def test_informe_pdf_respeta_region_y_protege_datos(monkeypatch):
    import fitz
    import tramites.adjuntos as adj
    import tramites.api as api_mod
    t = {'id': 700, 'proceso_id': 517, 'estado': 'completado', 'etapas_completadas': 2, 'total_etapas': 2, 'porcentaje_avance': 100,
         'regiones_list': ['Maule'], 'areas_protegidas': ['RN Altos de Lircay'], 'nombre_solicitante': 'Ana Pérez',
         'email_solicitante': 'ana@u.cl', 'fecha_inicio': '2026-03-01T10:00:00', 'fecha_resolucion': '2026-03-20T10:00:00',
         'etapas': [{'id': 1, 'estado': 'completado', 'email': 'func@conaf.cl', 'nombres': 'Funcionaria CONAF',
                     'fecha_inicio': '2026-03-01T10:00:00', 'fecha_termino': '2026-03-20T10:00:00'}],
         'datos_raw': {'titulo_investigacion': 'Anfibios de Lircay', 'cedula_de_identidad': '12.345.678-9'}}
    monkeypatch.setattr(adj, 'tramite_vivo', lambda tid: t)
    monkeypatch.setattr(api_mod, '_anios_busqueda', lambda: ([t], []))
    texto = lambda c: ' '.join(''.join(p.get_text() for p in fitz.open(stream=c.get('/api/tramites/700/informe.pdf').content, filetype='pdf')).split())
    lector = _usuario('lector@conaf.cl', region='Maule', solo_su_region=True)
    contenido = texto(_cliente(lector))
    assert 'de Lircay' in contenido and 'Funcionaria CONAF' in contenido and 'func@conaf.cl' in contenido
    assert '12.345.678-9' not in contenido and 'ana@u.cl' not in contenido
    assert '12.345.678-9' in texto(_cliente(_usuario('editor@conaf.cl', puede_editar=True)))
    otra = _usuario('otra@conaf.cl', region='Araucanía', solo_su_region=True)
    assert _cliente(otra).get('/api/tramites/700/informe.pdf').status_code == 403
