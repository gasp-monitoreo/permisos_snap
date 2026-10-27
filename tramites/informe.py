"""Informe PDF de un permiso (ficha completa), generado en el servidor con PyMuPDF (Story).

Contiene lo mismo que la ficha: situación actual, resumen de tiempos (CONAF / titular / fuera
de plazo), datos del proyecto, territorio, seguimiento de CONAF por etapa, documentos,
cumplimiento del titular (registro geográfico, Numeral 6, acceso al portal), permisos
relacionados y, como anexo, todos los campos del formulario. Respeta la protección de datos
del perfil que lo descarga (Ley N°21.719): quien no es Editor recibe los datos tachados.
"""
import io
import os
import re
import unicodedata
from datetime import date, datetime
from html import escape

from django.conf import settings

VERDE, VERDE_OSC, AZUL, ROJO, AMBAR, GRIS = '#347A17', '#013722', '#3F7CB8', '#B9412F', '#D9A13B', '#5F6B62'
ESTADOS = {'pendiente': 'En trámite', 'completado': 'Aprobado', 'rechazado': 'Rechazado'}

CSS = """
* { font-family: sans-serif; }
body { font-size: 9.5pt; color: #0E2219; line-height: 1.4; }
h1 { font-size: 17pt; color: #013722; margin: 4pt 0 2pt 0; }
h2 { font-size: 11pt; color: #2C6B14; margin: 14pt 0 5pt 0; padding-bottom: 2pt; border-bottom: 1px solid #CDE4BC; text-transform: uppercase; }
h3 { font-size: 9.5pt; color: #013722; margin: 8pt 0 3pt 0; }
p { margin: 2pt 0 4pt 0; }
.muted { color: #5F6B62; }
.small { font-size: 8pt; }
table { width: 100%; border-collapse: collapse; margin: 2pt 0 6pt 0; }
td, th { padding: 3pt 5pt; vertical-align: top; text-align: left; }
th { background-color: #013722; color: #FFFFFF; font-size: 8pt; }
.kv { border-bottom: 1px solid #ECE9E1; padding: 3pt 0 4pt 0; }
.kv p.k { color: #5F6B62; font-size: 7.5pt; font-weight: bold; text-transform: uppercase; margin: 0; }
.kv p.v { margin: 1pt 0 0 0; text-align: justify; }
.caja p, td { text-align: justify; }
.grid td { border: 1px solid #E4E1D5; }
.caja { background-color: #FAF9F4; border: 1px solid #E4E1D5; padding: 6pt 8pt; }
.barra { font-size: 11pt; line-height: 1; letter-spacing: -1pt; margin: 2pt 0; }
.cifra { font-size: 15pt; font-weight: bold; color: #013722; }
"""


def _f(v, hora=False):
    if not v:
        return '–'
    try:
        d = datetime.fromisoformat(str(v).replace('Z', '+00:00')[:19])
        return d.strftime('%d-%m-%Y %H:%M' if hora else '%d-%m-%Y')
    except ValueError:
        return escape(str(v)[:10])


def _dt(v):
    try:
        return datetime.fromisoformat(str(v).replace('Z', '+00:00')[:19]) if v else None
    except ValueError:
        return None


def _e(v):
    return escape(str(v if v is not None else ''))


def _etiqueta(clave):
    s = re.sub(r'_\d+$', '', str(clave)).replace('_', ' ').strip()
    return s[:1].upper() + s[1:]


def _texto(v):
    if isinstance(v, (list, tuple)):
        return ', '.join(_texto(x) for x in v)
    if isinstance(v, dict):
        return '; '.join(f'{_etiqueta(k)}: {_texto(x)}' for k, x in v.items() if x not in (None, ''))
    s = str(v).strip()
    if s.lower() in ('true', 'si', 'sí'):
        return 'Sí'
    if s.lower() in ('false', 'no'):
        return 'No'
    return s


def _campo(datos, *patrones):
    for p in patrones:
        for k, v in datos.items():
            if re.search(p, k, re.I) and v not in (None, '') and not isinstance(v, (dict, list)):
                return _texto(v)
    return ''


def _es_conaf(email):
    return bool(re.search(r'@conaf\.(gob\.)?cl$', (email or '').strip(), re.I))


def _etapas(t):
    hoy = datetime.now()
    res = []
    for i, e in enumerate(sorted(t.get('etapas') or [], key=lambda e: e.get('id') or 0), start=1):
        ini, fin, vence = _dt(e.get('fecha_inicio')), _dt(e.get('fecha_termino')), _dt(e.get('fecha_vencimiento'))
        fin_ef = fin or (hoy if e.get('estado') == 'pendiente' else None)
        res.append({
            'n': i, 'nombre': e.get('tarea_nombre') or f'Etapa {i}', 'e': e, 'ini': ini, 'fin': fin_ef,
            'conaf': not e.get('email') or _es_conaf(e.get('email')),
            'dias': (fin_ef - ini).days if ini and fin_ef else None,
            'plazo': (vence - ini).days if ini and vence else None,
            'atraso': (fin_ef - vence).days if vence and fin_ef and fin_ef > vence else 0,
        })
    return res


def _tiempos(et):
    """Días en CONAF, con el titular y fuera de plazo (mismo criterio que la ficha)."""
    iv = [(s['ini'].timestamp(), s['fin'].timestamp(), s['conaf'],
           (s['ini'].timestamp() + s['plazo'] * 86400) if s['plazo'] is not None else None)
          for s in et if s['ini'] and s['fin']]
    if not iv:
        return None
    cortes = sorted({x for a, b, _, v in iv for x in (a, b, v) if x is not None})
    suma = {'conaf': 0, 'atraso': 0, 'titular': 0}
    for a, b in zip(cortes, cortes[1:]):
        m = (a + b) / 2
        act = [x for x in iv if x[0] <= m <= x[1]]
        c = [x for x in act if x[2]]
        tipo = ('atraso' if any(x[3] and m > x[3] for x in c) else 'conaf') if c else ('titular' if act else None)
        if tipo:
            suma[tipo] += b - a
    total = cortes[-1] - min(x[0] for x in iv)
    return {k: round(v / 86400) for k, v in suma.items()}, max(1, round(total / 86400))


def _situacion(t, et):
    actual = next((s for s in et if s['e'].get('estado') == 'pendiente'), None)
    if t.get('estado') == 'rechazado':
        return 'Rechazado por CONAF', ROJO, (f"Motivo: {t.get('motivo_rechazo')}" if t.get('motivo_rechazo') else '')
    if t.get('estado') == 'completado':
        extra = 'Falta que el titular cierre el trámite en Cero Filas.' if t.get('recepcion_pendiente') else ''
        return 'Aprobado por CONAF', VERDE, f"Resuelto el {_f(t.get('fecha_resolucion') or t.get('fecha_termino'))}. {extra}"
    if t.get('suspendido'):
        return 'En suspensión', GRIS, ''
    if t.get('espera_solicitante') and actual:
        return 'Esperando al titular', AZUL, f"Debe responder o subsanar desde el {_f(actual['e'].get('fecha_inicio'))} ({actual['dias']} días). No es atraso de CONAF."
    if actual:
        vencida = actual['atraso'] > 0
        quien = actual['e'].get('nombres') or 'sin asignar'
        return (('Atraso de CONAF' if vencida else 'En evaluación en CONAF'), ROJO if vencida else AMBAR,
                f"Etapa «{actual['nombre']}» desde el {_f(actual['e'].get('fecha_inicio'))} ({actual['dias']} días), a cargo de {quien}"
                + (f"; venció el {_f(actual['e'].get('fecha_vencimiento'))} ({actual['atraso']} días de atraso)." if vencida
                   else (f"; vence el {_f(actual['e'].get('fecha_vencimiento'))}." if actual['e'].get('fecha_vencimiento') else '.')))
    return ESTADOS.get(t.get('estado'), t.get('estado') or ''), GRIS, ''


def _norm(s):
    s = unicodedata.normalize('NFD', (s or '').lower())
    return re.sub(r'[^a-z0-9 ]', ' ', ''.join(c for c in s if unicodedata.category(c) != 'Mn')).split()


def _entregas(t):
    """Archivos entregados (Numeral 6) en el índice de Drive, por ID o por nombre del titular."""
    try:
        from .drive_utils import get_cached_index
        indice, _ = get_cached_index()
    except Exception:
        return None
    if not indice:
        return None
    tid, nombre = str(t.get('id')), set(_norm(t.get('nombre_solicitante')))
    for carpeta, d in indice.items():
        if isinstance(d, dict) and d.get('tipo') == 'nested' and tid in (d.get('ids') or {}):
            return d['ids'][tid]
    for carpeta, d in indice.items():
        toks = _norm(carpeta.replace('_', ' '))
        if toks and all(x in nombre for x in toks):
            if isinstance(d, dict) and d.get('tipo') == 'nested':
                return next(iter((d.get('ids') or {}).values()), [])
            return (d or {}).get('archivos', []) if isinstance(d, dict) else []
    return []


def _fila_etapa(x):
    e = x['e']
    dias = '–' if x['dias'] is None else str(x['dias'])
    if x['plazo']:
        dias += f" / {x['plazo']}"
    if x['atraso']:
        dias += f'<br/><span style="color:{ROJO}">+{x["atraso"]} d</span>'
    termino = _f(e.get('fecha_termino')) if e.get('fecha_termino') else 'en curso'
    return (f"<tr><td>{x['n']}. {_e(x['nombre'])}</td>"
            f"<td>{'CONAF' if x['conaf'] else 'Titular'}<br/><span class='small muted'>{_e(e.get('nombres') or '')}<br/>{_e(e.get('email') or '')}</span></td>"
            f"<td>{_f(e.get('fecha_inicio'))}</td><td>{termino}</td><td>{_f(e.get('fecha_vencimiento'))}</td>"
            f"<td style='text-align:right'>{dias}</td></tr>")


def _kv(filas):
    filas = [(k, v) for k, v in filas if v not in (None, '', '–')]
    return ''.join(f'<div class="kv"><p class="k">{_e(k)}</p><p class="v">{_e(v)}</p></div>' for k, v in filas)


def html_informe(t, extra):
    from .adjuntos import CLAVES_RESOLUCION, adjuntos_de
    from .core import extract_titulo
    from .presion import periodo_actividades
    d = t.get('datos_raw') or {}
    et = _etapas(t)
    titulo = extract_titulo(d) or _campo(d, r'nombre_del_proyecto', r'nombre_proyecto') or 'Permiso en áreas protegidas'
    sit, color, detalle = _situacion(t, et)
    ini, fin = periodo_actividades(t)
    es_inv = extra['tipo'] == 'inv'
    partes = []

    # Encabezado
    partes.append(f"""
    <table><tr><td style="width:62%"><p style="height:40pt"> </p></td>
      <td style="text-align:right" class="muted small">Informe de permiso · generado el {datetime.now():%d-%m-%Y %H:%M}<br/>
      Corporación Nacional Forestal · Áreas Silvestres Protegidas</td></tr></table>
    <p class="muted small">PERMISO N.° {t.get('id')} · {'INVESTIGACIÓN CIENTÍFICA' if es_inv else 'FILMACIÓN Y FOTOGRAFÍA'}</p>
    <h1>{_e(titulo)}</h1>
    <p><b>{_e(t.get('nombre_solicitante') or 'Sin nombre')}</b>{' · ' + _e(_campo(d, r'institucion_patrocinante', r'^nombre_empresa', r'^institucion')) if _campo(d, r'institucion_patrocinante', r'^nombre_empresa', r'^institucion') else ''}
      {' · ' + _e(t.get('email_solicitante')) if t.get('email_solicitante') else ''}</p>
    <div class="caja" style="border-left: 4pt solid {color}"><p class="muted small">SITUACIÓN ACTUAL</p>
      <p><b style="font-size:12pt;color:{color}">● </b><b style="font-size:12pt">{_e(sit)}</b></p><p>{_e(detalle)}</p></div>""")
    if extra.get('protegido'):
        partes.append('<p class="small caja"><b>Protección de datos.</b> Conforme a la Ley N°21.719 y a la Ley N°21.663, los datos sensibles '
                      '(RUT, correos, teléfonos, coordenadas exactas) aparecen tachados (█████) para perfiles sin rol Editor.</p>')

    # Cifras y tiempos
    tiempos = _tiempos(et)
    cifras = [('Ingreso', _f(t.get('fecha_inicio'))), ('Resolución', _f(t.get('fecha_resolucion')) if t.get('estado') != 'pendiente' else 'pendiente'),
              ('Avance', f"{t.get('porcentaje_avance') or 0}% · {t.get('etapas_completadas') or 0} de {t.get('total_etapas') or len(et)} etapas")]
    if tiempos:
        cifras.insert(2, ('Días de trámite', str(tiempos[1])))
    partes.append('<table><tr>' + ''.join(f'<td class="caja" style="width:{100 // len(cifras)}%"><span class="muted small">{k.upper()}</span><br/><span class="cifra">{_e(v)}</span></td>' for k, v in cifras) + '</tr></table>')
    if tiempos:
        s, total = tiempos
        conaf = s['conaf'] + s['atraso']
        celdas = [(VERDE, s['conaf'], 'CONAF'), (ROJO, s['atraso'], 'Fuera de plazo'), (AZUL, s['titular'], 'Titular')]
        celdas = [c for c in celdas if c[1] > 0]
        fuera = f' (de ellos {s["atraso"]} fuera del plazo de la etapa)' if s['atraso'] else ''
        suma = sum(c[1] for c in celdas) or 1
        bloques = ''.join(f'<span style="color:{c}">{"█" * max(1, round(v / suma * 60))}</span>' for c, v, _ in celdas)
        leyenda = ' &nbsp; '.join(f'<span style="color:{c}">■</span> {n} {v} d' for c, v, n in celdas)
        partes.append(f'<h2>Tiempos del trámite</h2><p class="barra">{bloques}</p><p class="small">{leyenda}</p>'
            + f'<p class="small muted">En CONAF <b>{conaf} días</b>{fuera} · '
              f'con el titular (enviar, subsanar, cerrar) <b>{s["titular"]} días</b> · total {total} días.</p>')

    # Proyecto
    partes.append('<h2>El proyecto</h2>' + _kv([
        ('Objetivo', _campo(d, r'^objetivo_general$', r'^objetivos?_del_proyecto$', r'objetivo', r'^descripcion')),
        ('Metodología y actividades', _campo(d, r'metodolog', r'^breve_descripcion_actividades', r'^actividades', r'descripcion_actividades')),
        ('Especies o grupos de estudio', _campo(d, r'^especies?$', r'nombre_cientifico', r'nombre_comun', r'especie')),
        ('Colecta o toma de muestras', _campo(d, r'colect', r'muestra', r'captura')),
        ('Equipo', _campo(d, r'investigadores_asociados', r'^equipo', r'integrantes')),
        ('Financiamiento', _campo(d, r'financiamiento', r'fondo')),
        ('Período en terreno', f'{ini:%d-%m-%Y} al {(fin or ini):%d-%m-%Y}' if ini else ''),
        ('Proceso', extra.get('proceso', '')),
    ]))

    # Territorio
    partes.append('<h2>Territorio</h2>' + _kv([
        ('Regiones', ', '.join(t.get('regiones_list') or [])),
        ('Áreas protegidas', ', '.join(t.get('areas_protegidas') or [])),
        ('Ubicación declarada', _campo(d, r'localizacion_geografica', r'^ubicacion', r'coordenad')),
    ]))
    regs = extra.get('registros') or []
    if regs:
        filas = ''.join(f"<tr><td>{_e(f['properties'].get('nombre'))}</td><td>{_e(f['properties'].get('categoria_nombre') or f['properties'].get('tipo'))}</td>"
                        f"<td>{_e(_coords(f['geometry']))}</td><td>{_e((f['properties'].get('metodo') or '')[:180])}</td></tr>" for f in regs[:60])
        partes.append(f'<h3>Sitios registrados por el titular ({len(regs)})</h3><table class="grid"><tr><th>Nombre</th><th>Tipo</th><th>Ubicación</th><th>Método</th></tr>{filas}</table>'
                      + ('<p class="small muted">Coordenadas aproximadas (~1 km) por protección de datos.</p>' if extra.get('protegido') else ''))

    # Seguimiento
    if et:
        filas = ''.join(_fila_etapa(x) for x in et)
        partes.append(f'<h2>Seguimiento CONAF</h2><table class="grid"><tr><th>Etapa</th><th>A cargo</th><th>Inicio</th><th>Término</th><th>Plazo</th><th>Días (usados / plazo)</th></tr>{filas}</table>')
    if t.get('motivo_rechazo'):
        partes.append(f'<p class="caja"><b>Motivo del rechazo:</b> {_e(t.get("motivo_rechazo"))}</p>')

    # Documentos
    adj = adjuntos_de(t)
    if adj:
        filas = ''.join(f"<tr><td>{'Resolución / autorización de CONAF' if k in CLAVES_RESOLUCION else _e(_etiqueta(k))}</td><td>{_e(v.rsplit('.', 1)[-1].upper())}</td></tr>" for k, v in adj)
        partes.append(f'<h2>Documentos del trámite</h2><table class="grid"><tr><th>Documento</th><th>Formato</th></tr>{filas}</table>'
                      '<p class="small muted">Disponibles en la ficha del permiso en la plataforma (sin cuenta en Cero Filas).</p>')

    # Cumplimiento
    cum = []
    acc = extra.get('acceso')
    cum.append(('Registro geográfico', f"{len(regs)} sitio(s) registrado(s)" if regs else 'Pendiente: el titular no ha registrado sus sitios de trabajo'))
    cum.append(('Acceso al portal del investigador', (f"{'Vigente' if acc.vigente() else 'No vigente'} hasta el {acc.vence:%d-%m-%Y}"
                                                       + (f" · último ingreso {acc.ultimo_ingreso:%d-%m-%Y}" if acc.ultimo_ingreso else ' · aún no ingresa')) if acc else 'Sin acceso generado'))
    if es_inv:
        base = _dt(t.get('fecha_termino') or t.get('fecha_resolucion'))
        plazo = date(base.year + 3, base.month, min(base.day, 28)) if base else None
        ent = extra.get('entregas')
        cum.append(('Entrega de resultados (Numeral 6)', (f"{len(ent)} archivo(s) entregado(s)" if ent else 'Sin resultados entregados')
                    + (f" · plazo {plazo:%d-%m-%Y}" if plazo else '')))
        if ent:
            cum.append(('Archivos entregados', ', '.join(a.get('nombre', '') for a in ent[:15])))
    if t.get('recepcion_pendiente'):
        cum.append(('Cierre en Cero Filas', 'Pendiente: el titular debe confirmar la recepción'))
    partes.append('<h2>Cumplimiento del titular</h2>' + _kv(cum))

    # Relacionados
    rel = extra.get('relacionados') or []
    if rel:
        filas = ''.join(f"<tr><td>#{r['id']}</td><td>{_e(r['titulo'])}</td><td>{_e(r['estado'])}</td><td>{_f(r['fecha'])}</td></tr>" for r in rel[:20])
        partes.append(f'<h2>Otros permisos del mismo titular</h2><table class="grid"><tr><th>N.°</th><th>Proyecto</th><th>Estado</th><th>Ingreso</th></tr>{filas}</table>')

    # Anexo: solicitud completa
    filas = []
    for k, v in d.items():
        if v in (None, '', [], {}) or re.match(r'^[0-9a-f]{10,}$', str(k)):
            continue
        filas.append(f'<div class="kv"><p class="k">{_e(_etiqueta(k))}</p><p class="v">{_e(_texto(v)[:1500])}</p></div>')
    partes.append(f'<h2>Anexo · Solicitud completa ({len(filas)} campos)</h2>{"".join(filas)}')
    return '<body>' + ''.join(partes) + '</body>'


def _coords(g):
    c = g.get('coordinates')
    if g.get('type') == 'Point' and c:
        return f'{c[1]}, {c[0]}'
    pts = c if g.get('type') == 'LineString' else (c[0] if c else [])
    return f"{g.get('type') == 'LineString' and 'Transecto' or 'Parcela'} de {len(pts)} vértices, desde {pts[0][1]}, {pts[0][0]}" if pts else ''


def pdf(t, extra, usuario):
    import pymupdf
    story = pymupdf.Story(html=html_informe(t, extra), user_css=CSS)
    buf = io.BytesIO()
    w = pymupdf.DocumentWriter(buf)
    pagina = pymupdf.paper_rect('a4')
    marco = pagina + (42, 40, -42, -46)
    mas = True
    while mas:
        dev = w.begin_page(pagina)
        mas, _ = story.place(marco)
        story.draw(dev)
        w.end_page()
    w.close()
    # pie de página con numeración y marca de protección
    doc = pymupdf.open(stream=buf.getvalue(), filetype='pdf')
    pie = f"Permisos SNAP · CONAF · Permiso N.° {t.get('id')} · descargado por {getattr(usuario, 'email', '') or getattr(usuario, 'username', '')}"
    logo = os.path.join(settings.BASE_DIR, 'static', 'img', 'logo.png')
    if os.path.exists(logo):          # el logo se pone directo (más nítido que desde el HTML)
        doc[0].insert_image(pymupdf.Rect(42, 34, 92, 88), filename=logo, keep_proportion=True)
    for i, pag in enumerate(doc, start=1):
        r = pag.rect
        pag.draw_line((42, r.height - 34), (r.width - 42, r.height - 34), color=(0.89, 0.88, 0.84), width=0.6)
        pag.insert_text((42, r.height - 22), pie, fontsize=7, color=(0.37, 0.42, 0.38))
        pag.insert_text((r.width - 90, r.height - 22), f'Página {i} de {len(doc)}', fontsize=7, color=(0.37, 0.42, 0.38))
    doc.set_metadata({'title': f'Permiso {t.get("id")}', 'creator': 'Permisos SNAP · CONAF'})
    return doc.tobytes(garbage=3, deflate=True)
