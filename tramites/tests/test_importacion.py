"""Carga manual desde CeroFilas y funcionamiento con su API bloqueada por el WAF (CAPTCHA)."""
import gzip
import json
import time

import pytest
import requests
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import Client

from tramites import core, importacion, tramites_cache as tc
from tramites.models import PerfilUsuario, PortadaHistoricoRecord, secciones_por_defecto

CLAVE = 'ClaveDePrueba-2026'


@pytest.fixture(autouse=True)
def _limpiar_cache(settings):
    settings.CACHES = {'default': {'BACKEND': 'django.core.cache.backends.locmem.LocMemCache'}}
    cache.clear()


def _cliente(superusuario=True):
    User = get_user_model()
    email = 'admin@conaf.cl' if superusuario else 'enc@conaf.cl'
    u = (User.objects.create_superuser if superusuario else User.objects.create_user)(
        username=email, email=email, password=CLAVE)
    PerfilUsuario.objects.create(user=u, tipo='inv', secciones=secciones_por_defecto('inv'),
                                 debe_cambiar_password=False)
    c = Client()
    c.force_login(u)
    return c


def _crudo(tid, fecha='2026-03-10 10:00:00', titulo='Anfibios de Lircay'):
    """Trámite tal como lo entrega /backend/api/tramites (ya avanzado: no es borrador)."""
    return {
        'id': tid, 'estado': 'pendiente', 'proceso_id': 1992,
        'fecha_inicio': fecha, 'fecha_modificacion': fecha, 'fecha_termino': None,
        'etapas': [
            {'estado': 'completado', 'tarea': {'nombre': 'Completar Formulario de Solicitud'},
             'usuario_asignado': {'nombres': 'Ana', 'email': 'ana@u.cl'}},
            {'estado': 'pendiente', 'tarea': {'nombre': 'Encargado Oficina Central'},
             'usuario_asignado': {'nombres': 'Func', 'email': 'func@conaf.cl'}},
        ],
        'datos': [{'titulo_del_proyecto': titulo}],
    }


def _archivo(items, modo='cambios', desde=None, comprimir=True):
    cuerpo = json.dumps({'origen': 'cerofilas', 'modo': modo, 'desde': desde or int(time.time()) - 7 * 86400,
                         'generado': '2026-11-13T10:00:00Z', 'items': items}).encode()
    if comprimir:
        cuerpo = gzip.compress(cuerpo)
    return SimpleUploadedFile('tramites_cerofilas.json.gz', cuerpo, content_type='application/gzip')


@pytest.mark.django_db
def test_carga_de_cambios_se_combina_con_lo_guardado():
    tc.guardar_anio(2026, [core.normalize_tramite(_crudo(1, titulo='Viejo')), core.normalize_tramite(_crudo(2))])
    r = _cliente().post('/api/cerofilas/importar', {'archivo': _archivo([_crudo(1, titulo='Nuevo'), _crudo(3)])})
    assert r.status_code == 200, r.content
    assert r.json()['resumen']['tramites'] == 2
    datos = {t['id']: t for t in cache.get('tramites:2026-2026')['data']}
    assert set(datos) == {1, 2, 3}                                   # el 2 se conserva
    assert datos[1]['datos_raw']['titulo_del_proyecto'] == 'Nuevo'   # el 1 se actualiza
    assert PortadaHistoricoRecord.objects.filter(tramite_id=3).exists()
    assert importacion.ultima()['tramites'] == 2


@pytest.mark.django_db
def test_carga_completa_reemplaza_los_anios_y_arma_rangos():
    tc.guardar_anio(2025, [core.normalize_tramite(_crudo(9, fecha='2025-05-01 09:00:00'))])
    desde = int(time.mktime((2025, 1, 1, 0, 0, 0, 0, 0, -1)))
    items = [_crudo(10, fecha='2025-06-01 09:00:00'), _crudo(11)]
    r = _cliente().post('/api/cerofilas/importar', {'archivo': _archivo(items, modo='completo', desde=desde, comprimir=False)})
    assert r.status_code == 200, r.content
    assert [t['id'] for t in cache.get('tramites:2025-2025')['data']] == [10]   # el 9 ya no está en CeroFilas
    assert sorted(t['id'] for t in tc.obtener(2025, 2026)['data']) == [10, 11]


@pytest.mark.django_db
def test_solo_el_superusuario_carga_y_obtiene_el_marcador(settings):
    settings.CEROFILAS_TOKEN = 'TOKEN-DE-PRUEBA'
    enc = _cliente(superusuario=False)
    assert enc.post('/api/cerofilas/importar', {'archivo': _archivo([_crudo(1)])}).status_code == 403
    assert enc.get('/api/cerofilas/marcador').status_code == 403
    codigo = _cliente().get('/api/cerofilas/marcador').json()['codigo']
    assert 'TOKEN-DE-PRUEBA' in codigo and '__TOKEN__' not in codigo


@pytest.mark.django_db
def test_archivo_ajeno_se_rechaza():
    malo = SimpleUploadedFile('x.json', b'{"hola": 1}', content_type='application/json')
    r = _cliente().post('/api/cerofilas/importar', {'archivo': malo})
    assert r.status_code == 400 and 'marcador' in r.json()['error']


class _RespuestaWaf:
    status_code = 405
    headers = {'x-amzn-waf-action': 'captcha'}

    def raise_for_status(self):
        raise requests.HTTPError('405 Client Error: Not Allowed for url: https://x/api?token=SECRETO', response=self)


@pytest.mark.django_db
def test_con_captcha_no_se_insiste_ni_se_muestra_el_token(monkeypatch):
    llamadas = []
    monkeypatch.setattr(core, 'TOKEN', 'SECRETO')
    monkeypatch.setattr(core.requests, 'get', lambda *a, **k: llamadas.append(1) or _RespuestaWaf())
    for _ in range(3):
        with pytest.raises(requests.HTTPError) as e:
            core.api_get('/tramites')
        assert 'SECRETO' not in str(e.value) and 'CAPTCHA' in str(e.value)
    assert len(llamadas) == 1                       # tras el primer bloqueo ya no consulta
    assert core.cerofilas_bloqueado()


@pytest.mark.django_db
def test_detalle_del_tramite_sale_de_lo_guardado_si_cerofilas_bloquea(monkeypatch):
    tc.guardar_anio(2026, [core.normalize_tramite(_crudo(35995721))])
    monkeypatch.setattr(core.requests, 'get', lambda *a, **k: _RespuestaWaf())
    r = _cliente().get('/api/tramites/35995721')
    assert r.status_code == 200, r.content
    assert r.json()['data']['id'] == 35995721
