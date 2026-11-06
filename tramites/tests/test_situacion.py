"""Situación de los trámites: separar lo que depende del solicitante o está suspendido
del atraso real de CONAF, y medir la resolución hasta que CONAF resolvió."""
from tramites.core import normalize_tramite

CONAF = 'revisor@conaf.cl'
SOLIC = 'persona@ejemplo.cl'


def _etapa(i, estado, email, nombre, ini, fin=None):
    return {'id': i, 'estado': estado, 'usuario_asignado': {'email': email, 'nombres': 'X'},
            'fecha_inicio': ini, 'fecha_termino': fin, 'tarea': {'id': i, 'nombre': nombre}}


def _tramite(etapas, estado='pendiente', datos=None, **extra):
    return {'id': 1, 'estado': estado, 'proceso_id': 517, 'fecha_inicio': '2026-01-05 10:00:00',
            'etapas': etapas, 'datos': datos or [], **extra}


def test_resuelta_falta_cierre_del_solicitante():
    t = normalize_tramite(_tramite([
        _etapa(1, 'completado', SOLIC, 'Completar formulario', '2026-01-05 10:00:00', '2026-01-05 11:00:00'),
        _etapa(2, 'completado', CONAF, 'Emitir resolución', '2026-01-06 09:00:00', '2026-02-10 12:00:00'),
        _etapa(3, 'pendiente', SOLIC, 'Recepción de la respuesta', '2026-02-10 12:00:00'),
    ]))
    assert t['estado'] == 'completado'
    assert t['recepcion_pendiente'] is True
    assert t['fecha_resolucion'] == '2026-02-10 12:00:00'   # se mide hasta que CONAF resolvió
    assert t['suspendido'] is False


def test_etapa_en_manos_del_solicitante_no_es_atraso_conaf():
    # Devuelta para subsanar: sigue en trámite, pero la espera es del solicitante
    t = normalize_tramite(_tramite([
        _etapa(1, 'completado', SOLIC, 'Completar formulario', '2026-01-05 10:00:00', '2026-01-05 11:00:00'),
        _etapa(2, 'completado', CONAF, 'Revisión', '2026-01-06 09:00:00', '2026-01-20 12:00:00'),
        _etapa(3, 'pendiente', SOLIC, 'Subsanar observaciones', '2026-01-20 12:00:00'),
    ]))
    assert t['estado'] == 'pendiente'
    assert t['espera_solicitante'] is True
    assert t['recepcion_pendiente'] is False


def test_etapa_en_conaf_no_es_espera_del_solicitante():
    t = normalize_tramite(_tramite([
        _etapa(1, 'completado', SOLIC, 'Completar formulario', '2026-01-05 10:00:00', '2026-01-05 11:00:00'),
        _etapa(2, 'pendiente', CONAF, 'Revisión', '2026-01-06 09:00:00'),
    ]))
    assert t['estado'] == 'pendiente'
    assert t['espera_solicitante'] is False
    assert t['suspendido'] is False


def test_plazo_conaf_descuenta_dias_del_solicitante():
    """El plazo de CONAF cuenta desde la primera etapa CONAF, no desde el envío.
    Un permiso con 500 días del solicitante y solo 31 días con CONAF no debe
    mostrar fecha_limite_proceso vencida si CONAF aún tiene tiempo."""
    # Envío del formulario hace ~500 días (titular tardó mucho)
    t = normalize_tramite(_tramite([
        _etapa(1, 'completado', SOLIC, 'Completar formulario',
               '2024-01-05 10:00:00', '2025-05-10 10:00:00'),   # 490 días con el titular
        _etapa(2, 'pendiente', CONAF, 'Revisión',
               '2025-05-10 10:00:00'),                           # CONAF recién empezó
    ]))
    # El plazo base es 2 meses desde 2025-05-10 → ~2025-07-10
    # Que sería una fecha futura vista en julio 2025, pero pasada en nov 2026
    # Lo importante: NO debe basarse en 2024-01-05 (fecha del formulario)
    from datetime import datetime
    if t['fecha_limite_proceso']:
        fecha_lim = datetime.strptime(t['fecha_limite_proceso'][:19], '%Y-%m-%d %H:%M:%S')
        inicio_conaf = datetime(2025, 5, 10, 10, 0, 0)
        # La fecha límite debe ser ≥ inicio_conaf (no anterior a cuando llegó a CONAF)
        assert fecha_lim >= inicio_conaf, \
            f"fecha_limite_proceso {t['fecha_limite_proceso']} es anterior al inicio CONAF"


def test_suspension_por_etapa_o_campo_del_formulario():
    por_etapa = normalize_tramite(_tramite([
        _etapa(1, 'completado', SOLIC, 'Completar formulario', '2026-01-05 10:00:00', '2026-01-05 11:00:00'),
        _etapa(2, 'pendiente', CONAF, 'Solicitud en suspensión', '2026-01-06 09:00:00'),
    ]))
    assert por_etapa['suspendido'] is True

    por_campo = normalize_tramite(_tramite(
        [_etapa(1, 'completado', SOLIC, 'Completar formulario', '2026-01-05 10:00:00', '2026-01-05 11:00:00'),
         _etapa(2, 'pendiente', CONAF, 'Revisión', '2026-01-06 09:00:00')],
        datos=[{'suspender_tramite': 'Sí'}]))
    assert por_campo['suspendido'] is True
