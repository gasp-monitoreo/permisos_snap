"""Importa los convenios del Excel al modelo Convenio de PostgreSQL.

Uso:
    python manage.py importar_convenios <ruta_excel>

Opciones:
    --limpiar   Borra todos los convenios existentes antes de importar
"""
import re
from datetime import datetime

from django.core.management.base import BaseCommand, CommandError


ESTADO_MAP = {
    'vigente':    'vigente',
    'vencido':    'vencido',
    'terminado':  'terminado',
    'por vencer': 'por_vencer',
    'porvencer':  'por_vencer',
}

TIPO_ORG_MAP = {
    'empresa':             'empresa',
    'universidad':         'universidad',
    'municipalidad':       'municipalidad',
    'municipio':           'municipalidad',
    'junta de vecinos':    'junta_vecinos',
    'junta vecinos':       'junta_vecinos',
    'comunidad':           'comunidad',
    'asociación':          'comunidad',
    'asociacion':          'comunidad',
    'corporación':         'corporacion',
    'corporacion':         'corporacion',
    'ong':                 'ong',
    'fundación':           'fundacion',
    'fundacion':           'fundacion',
    'servicio público':    'servicio_publico',
    'servicio publico':    'servicio_publico',
}

TIPO_CONV_MAP = {
    'colaboración':        'colaboracion',
    'colaboracion':        'colaboracion',
    'uso de terreno':      'uso_terreno',
    'uso terreno':         'uso_terreno',
    'investigación':       'investigacion',
    'investigacion':       'investigacion',
    'educación':           'educacion',
    'educacion':           'educacion',
    'extensión':           'educacion',
    'extension':           'educacion',
    'prestación':          'prestacion',
    'prestacion':          'prestacion',
    'donación':            'donacion',
    'donacion':            'donacion',
    'transferencia':       'donacion',
}


def _norm(val):
    if val is None:
        return ''
    return str(val).strip()


def _map_estado(raw):
    k = _norm(raw).lower()
    return ESTADO_MAP.get(k, 'otro')


def _map_tipo_org(raw):
    k = _norm(raw).lower()
    for key, val in TIPO_ORG_MAP.items():
        if key in k:
            return val
    return 'otro'


def _map_tipo_conv(raw):
    k = _norm(raw).lower()
    for key, val in TIPO_CONV_MAP.items():
        if key in k:
            return val
    return 'otro'


def _parse_fecha(val):
    if not val or str(val).strip() in ('', 'nan', 'NaT', 'None'):
        return None
    s = str(val).strip()
    for fmt in ('%d/%m/%Y', '%Y-%m-%d', '%d-%m-%Y', '%d/%m/%y'):
        try:
            return datetime.strptime(s[:10], fmt).date()
        except Exception:
            pass
    # timestamp from pandas
    try:
        import pandas as pd
        ts = pd.Timestamp(val)
        if not pd.isna(ts):
            return ts.date()
    except Exception:
        pass
    return None


class Command(BaseCommand):
    help = 'Importa convenios desde un archivo Excel al modelo Convenio'

    def add_arguments(self, parser):
        parser.add_argument('excel', type=str, help='Ruta al archivo Excel')
        parser.add_argument('--limpiar', action='store_true', help='Borra convenios antes de importar')

    def handle(self, *args, **options):
        try:
            import pandas as pd
        except ImportError:
            raise CommandError('pandas no está instalado. Ejecuta: pip install pandas openpyxl')

        ruta = options['excel']
        self.stdout.write(f'Leyendo {ruta}…')

        try:
            df = pd.read_excel(ruta, sheet_name=0)
        except Exception as e:
            raise CommandError(f'No se pudo leer el Excel: {e}')

        self.stdout.write(f'  {len(df)} filas, columnas: {list(df.columns)}')

        from tramites.models import Convenio

        if options['limpiar']:
            n = Convenio.objects.count()
            Convenio.objects.all().delete()
            self.stdout.write(self.style.WARNING(f'  {n} convenios eliminados.'))

        col = {c.upper().strip(): c for c in df.columns}

        def g(names):
            """Retorna valor de la primera columna que coincida (case-insensitive)."""
            for n in names:
                key = n.upper().strip()
                if key in col:
                    return col[key]
            return None

        cols = {
            'region':      g(['REGION', 'REGIÓN']),
            'rut':         g(['RUT']),
            'razon':       g(['RAZON_SOCIAL', 'RAZÓN SOCIAL', 'RAZON SOCIAL']),
            'tipo_conv':   g(['TIPO CONVENIO', 'TIPO_CONVENIO']),
            'nombre':      g(['NOMBRE CONVENIO', 'NOMBRE_CONVENIO', 'NOMBRE']),
            'objetivo':    g(['OBJETIVO DEL CONVENIO', 'OBJETIVO']),
            'fecha_firma': g(['FECHA DE FIRMA', 'FECHA_FIRMA']),
            'anio':        g(['AÑO', 'ANO', 'ANIO']),
            'duracion':    g(['DURACIÓN', 'DURACION']),
            'termino':     g(['TÉRMINO', 'TERMINO']),
            'renovacion':  g(['RENOVACIÓN AUTOMATICA', 'RENOVACION AUTOMATICA', 'RENOVACIÓN AUTOMÁTICA']),
            'adendas':     g(['FECHA DE ADENDAS', 'FECHA_ADENDAS']),
            'tipo_org':    g(['TIPO DE ORGANIZACIÓN', 'TIPO ORGANIZACIÓN', 'TIPO_ORGANIZACION']),
            'estado':      g(['ESTADO']),
            't_bienes':    g(['TRANSFERENCIA DE BIENES Y SERVICIOS', 'TRANSFERENCIA BIENES']),
            't_presup':    g(['TRANSFERENCIA PRESUPUESTARIA']),
            'beneficios':  g(['BENEFICIOS DE INGRESO', 'BENEFICIOS']),
            'responsable': g(['RESPONSABLE EN CONAF', 'RESPONSABLE']),
            'obs':         g(['OBSERVACIONES']),
            'pdf1':        g(['ARCHIVO PDF (ENLACE)', 'ARCHIVO PDF']),
            'pdf2':        g(['ARCHIVO PDF 2', 'ARCHIVO_PDF_2']),
        }

        creados = 0
        errores = 0
        for _, row in df.iterrows():
            def rv(key):
                c = cols.get(key)
                return _norm(row[c]) if c else ''

            nombre = rv('nombre')
            if not nombre or nombre.lower() in ('nan', 'none', ''):
                continue

            try:
                anio_raw = rv('anio')
                anio = int(float(anio_raw)) if anio_raw and anio_raw not in ('nan','') else None
            except Exception:
                anio = None

            Convenio.objects.create(
                region              = rv('region'),
                rut                 = rv('rut'),
                razon_social        = rv('razon'),
                tipo_convenio       = _map_tipo_conv(rv('tipo_conv')),
                nombre              = nombre,
                objetivo            = rv('objetivo'),
                fecha_firma         = _parse_fecha(row[cols['fecha_firma']] if cols['fecha_firma'] else None),
                anio                = anio,
                duracion            = rv('duracion'),
                termino             = rv('termino'),
                renovacion_automatica = rv('renovacion'),
                fecha_adendas       = rv('adendas'),
                tipo_organizacion   = _map_tipo_org(rv('tipo_org')),
                estado              = _map_estado(rv('estado')),
                transf_bienes       = rv('t_bienes'),
                transf_presup       = rv('t_presup'),
                beneficios_ingreso  = rv('beneficios'),
                responsable_conaf   = rv('responsable'),
                observaciones       = rv('obs'),
                nombre_archivo      = rv('pdf1'),
                nombre_archivo2     = rv('pdf2'),
            )
            creados += 1

        self.stdout.write(self.style.SUCCESS(
            f'  Importados: {creados}  |  Errores: {errores}'
        ))
