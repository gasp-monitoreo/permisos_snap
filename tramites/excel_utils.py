import io
from datetime import datetime

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter


def _thin_border():
    thin = Side(border_style='thin', color='CCCCCC')
    return Border(left=thin, right=thin, top=thin, bottom=thin)


def build_tramites_excel(tramites, proceso_map=None):
    proceso_map = proceso_map or {}
    wb = Workbook()
    ws = wb.active
    ws.title = 'Trámites'

    header_fill  = PatternFill('solid', fgColor='1B4F72')
    header_font  = Font(color='FFFFFF', bold=True, size=11)
    header_align = Alignment(horizontal='center', vertical='center', wrap_text=True)
    border       = _thin_border()
    estado_fills = {
        'pendiente':  PatternFill('solid', fgColor='FFF3CD'),
        'completado': PatternFill('solid', fgColor='D4EDDA'),
        'rechazado':  PatternFill('solid', fgColor='F8D7DA'),
    }

    headers = [
        'ID', 'Estado', 'Tipo de Trámite', 'Proceso ID',
        'Nombre Solicitante', 'Email Solicitante', 'Región',
        'Fecha Inicio', 'Fecha Modificación', 'Fecha Término',
        '% Avance', 'Etapas Completadas', 'Total Etapas',
        'Etapa Actual', 'Responsable Actual', 'Email Responsable',
        'Fecha Vencimiento Etapa', 'Archivo Autorización',
    ]
    for col, h in enumerate(headers, 1):
        cell = ws.cell(row=1, column=col, value=h)
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = header_align
        cell.border = border
    ws.row_dimensions[1].height = 30

    for row_num, t in enumerate(tramites, 2):
        proceso_nombre = proceso_map.get(t['proceso_id'], f"Proceso {t['proceso_id']}")
        etapa_actual   = t.get('etapa_actual') or {}
        estado         = t.get('estado', '')
        fill           = estado_fills.get(estado)
        values = [
            t['id'], estado.capitalize(), proceso_nombre, t['proceso_id'],
            t['nombre_solicitante'], t['email_solicitante'], t['region'],
            t['fecha_inicio'], t['fecha_modificacion'], t['fecha_termino'],
            f"{t['porcentaje_avance']}%", t['etapas_completadas'], t['total_etapas'],
            etapa_actual.get('nombres', ''), etapa_actual.get('nombres', ''),
            etapa_actual.get('email', ''), etapa_actual.get('fecha_vencimiento', ''),
            t.get('archivo_autorizacion', ''),
        ]
        for col, val in enumerate(values, 1):
            cell = ws.cell(row=row_num, column=col, value=val)
            cell.border = border
            cell.alignment = Alignment(vertical='center')
            if fill:
                cell.fill = fill

    col_widths = [8, 12, 30, 12, 30, 30, 15, 20, 20, 20, 10, 10, 10, 25, 25, 30, 22, 35]
    for i, w in enumerate(col_widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w

    ws2 = wb.create_sheet('Resumen')
    ws2['A1'] = 'RESUMEN DE TRÁMITES'
    ws2['A1'].font = Font(bold=True, size=14, color='1B4F72')
    for i, (label, key, clr) in enumerate([
        ('Total', None, None), ('Pendientes', 'pendiente', 'FFF3CD'),
        ('Completados', 'completado', 'D4EDDA'), ('Rechazados', 'rechazado', 'F8D7DA'),
    ], 3):
        ws2[f'A{i}'] = label
        ws2[f'A{i}'].font = Font(bold=True)
        count = len(tramites) if key is None else sum(1 for t in tramites if t['estado'] == key)
        ws2[f'B{i}'] = count
        if clr:
            ws2[f'B{i}'].fill = PatternFill('solid', fgColor=clr)
    ws2['A7'] = 'Generado'
    ws2['B7'] = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    ws2.column_dimensions['A'].width = 20
    ws2.column_dimensions['B'].width = 25

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf


def build_compliance_excel(resultados):
    HOY = datetime.now()
    wb  = Workbook()
    ws  = wb.active
    ws.title = 'Incumplimiento Numeral 6'

    header_fill  = PatternFill('solid', fgColor='7B1C1C')
    header_font  = Font(color='FFFFFF', bold=True, size=11)
    header_align = Alignment(horizontal='center', vertical='center', wrap_text=True)
    border       = _thin_border()

    headers = [
        'ID Trámite', 'Estado', 'Nombre Solicitante', 'Email Solicitante',
        'Título de la Investigación', 'Fecha Término Actividades',
        'Años Transcurridos', 'Última Modificación', 'Región(es)',
    ]
    for col, h in enumerate(headers, 1):
        cell = ws.cell(row=1, column=col, value=h)
        cell.fill = header_fill; cell.font = header_font
        cell.alignment = header_align; cell.border = border
    ws.row_dimensions[1].height = 35

    fill_alto  = PatternFill('solid', fgColor='F8D7DA')
    fill_medio = PatternFill('solid', fgColor='FFF3CD')

    for row_num, r in enumerate(resultados, 2):
        anios = r.get('anios_transcurridos', 0)
        fill  = fill_alto if anios >= 5 else fill_medio
        values = [
            r['id'], (r.get('estado') or '').capitalize(),
            r['nombre_solicitante'], r['email_solicitante'],
            r['titulo_investigacion'], r['fecha_termino_actividades'],
            anios, r.get('fecha_modificacion', ''), r.get('region', ''),
        ]
        for col, val in enumerate(values, 1):
            cell = ws.cell(row=row_num, column=col, value=val)
            cell.border = border
            cell.alignment = Alignment(vertical='center', wrap_text=(col == 5))
            cell.fill = fill

    col_widths = [12, 12, 30, 35, 50, 22, 16, 22, 30]
    for i, w in enumerate(col_widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w

    ws2 = wb.create_sheet('Información')
    ws2['A1'] = 'INCUMPLIMIENTO NUMERAL 6 – REGLAMENTO DE INVESTIGACIÓN CONAF'
    ws2['A1'].font = Font(bold=True, size=13, color='7B1C1C')
    ws2['A3'] = 'Descripción'
    ws2['B3'] = ('Trámites de Permiso de Investigación en el SNAP donde han transcurrido '
                 'más de 3 años desde la Fecha de Término de Actividades declarada.')
    ws2['B3'].alignment = Alignment(wrap_text=True)
    ws2['A4'] = 'Total en incumplimiento'
    ws2['B4'] = len(resultados)
    ws2['B4'].font = Font(bold=True, color='7B1C1C')
    ws2['A5'] = 'Generado'
    ws2['B5'] = HOY.strftime('%Y-%m-%d %H:%M:%S')
    for rn in range(3, 6):
        ws2[f'A{rn}'].font = Font(bold=True)
    ws2.column_dimensions['A'].width = 25
    ws2.column_dimensions['B'].width = 70
    ws2.row_dimensions[3].height = 50

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf
