"""Presión de permisos sobre áreas protegidas y ubicación de las actividades.

- Presión: por cada área protegida de una región, cuántos permisos están en ejecución
  hoy, programados (aprobados, aún no inician) o en evaluación. Usa los últimos 3 años
  de trámites (un permiso de 2025 puede seguir activo hoy).
- Ubicación: solo las coordenadas que el solicitante declaró en el formulario
  (decimales, grados-minutos o UTM). Los permisos sin coordenadas no se ubican en el mapa.
"""
import math
import re
import unicodedata
from datetime import date, datetime

from . import tramites_cache

ANIOS_ATRAS = 2          # año actual + 2 anteriores

# Regiones al oeste de ~72°W usan mayoritariamente el huso UTM 18; el resto, 19
HUSO_18 = {'Araucanía', 'Los Ríos', 'Los Lagos', 'Aysén'}

# Clave del formulario "region_de_<x>" → nombre de región en REGIONES_CHILE
_CLAVE_REGION = {
    'arica_y_parinacota': 'Arica y Parinacota', 'tarapaca': 'Tarapacá', 'antofagasta': 'Antofagasta',
    'atacama': 'Atacama', 'coquimbo': 'Coquimbo', 'valparaiso': 'Valparaíso',
    'metropolitana': 'Metropolitana', 'ohiggins': "O'Higgins", 'libertador': "O'Higgins",
    'maule': 'Maule', 'nuble': 'Ñuble', 'biobio': 'Biobío', 'araucania': 'Araucanía',
    'la_araucania': 'Araucanía', 'los_rios': 'Los Ríos', 'los_lagos': 'Los Lagos',
    'aysen': 'Aysén', 'magallanes': 'Magallanes',
}
_MINUS = {'de', 'del', 'la', 'las', 'los', 'el', 'y', 'e', 'a'}


def _sin_tildes(s):
    return ''.join(c for c in unicodedata.normalize('NFD', s) if unicodedata.category(c) != 'Mn')


# Las claves del formulario pierden tildes, ñ y ü ("pingino", "chaaral"): se restituyen
_ARREGLOS = {
    'pingino': 'pingüino', 'pinguino': 'pingüino', 'chaaral': 'chañaral', 'francico': 'francisco',
    'azucar': 'azúcar', 'nonguen': 'nonguén', 'milodon': 'milodón', 'conguillio': 'conguillío',
    'volcan': 'volcán', 'rio': 'río', 'aysen': 'aysén', 'tamarugal': 'tamarugal', 'nuble': 'ñuble',
    'pumalin': 'pumalín', 'nahuelbuta': 'nahuelbuta', 'queulat': 'queulat', 'magallanes': 'magallanes',
    'cabo': 'cabo', 'hornos': 'hornos', 'alerce': 'alerce', 'andino': 'andino', 'lauca': 'lauca',
    'isluga': 'isluga', 'tolhuaca': 'tolhuaca', 'malalcahuello': 'malalcahuello', 'nalcas': 'nalcas',
    'chiloe': 'chiloé', 'lago': 'lago', 'peñuelas': 'peñuelas', 'penuelas': 'peñuelas', 'campana': 'campana',
    'fernandez': 'fernández', 'patagonia': 'patagonia', 'jeinimeni': 'jeinimeni', 'kawesqar': 'kawésqar',
    'yendegaia': 'yendegaia', 'bernardo': 'bernardo', 'ohiggins': "o'higgins", 'mocho': 'mocho',
    'mochochoshuenco': 'mocho-choshuenco', 'huerquehue': 'huerquehue', 'villarrica': 'villarrica',
    'puyehue': 'puyehue', 'perez': 'pérez', 'rosales': 'rosales', 'radal': 'radal', 'siete': 'siete',
    'tazas': 'tazas', 'ingles': 'inglés', 'roble': 'roble', 'cipreses': 'cipreses', 'neblina': 'neblina',
}


def nombre_area(clave):
    """'parque_nacional__nevado_de_tres_cruces' → 'Parque Nacional Nevado de Tres Cruces'."""
    palabras = [p for p in re.split(r'[_\s]+', str(clave).strip()) if p]
    palabras = [_ARREGLOS.get(p.lower(), p) for p in palabras]
    return ' '.join(p if i and p.lower() in _MINUS else p[:1].upper() + p[1:] for i, p in enumerate(palabras))


def _clave_area(nombre):
    return re.sub(r'[^a-z]', '', _sin_tildes(nombre.lower()).replace('de', ''))


def _unificar_areas(areas):
    """Fusiona variantes del mismo nombre (errores de tipeo en las opciones del formulario)."""
    from difflib import SequenceMatcher
    grupos = []                          # [(clave, [nombres])]
    for nombre in sorted(areas, key=lambda n: -len(areas[n]['permisos'])):
        k = _clave_area(nombre)
        destino = next((g for g in grupos if SequenceMatcher(None, k, g[0]).ratio() >= 0.9), None)
        if destino:
            destino[1].append(nombre)
        else:
            grupos.append((k, [nombre]))
    res = {}
    for _, nombres in grupos:
        base = areas[nombres[0]]
        vistos = {p['id'] for p in base['permisos']}
        for otro in nombres[1:]:
            for p in areas[otro]['permisos']:
                if p['id'] in vistos:
                    continue
                vistos.add(p['id'])
                base['permisos'].append(p)
                base[p['situacion']] += 1
                base[p['tipo']] += 1
        res[base['area']] = base
    return res


def _lista(valor):
    v = str(valor or '').strip()
    if v.startswith('['):
        return [a or b for a, b in re.findall(r"'([^']+)'|\"([^\"]+)\"", v)]
    return [v] if v else []


def areas_por_region(t):
    """{región: [áreas]} a partir de los campos region_de_<x> del formulario."""
    res = {}
    for k, v in (t.get('datos_raw') or {}).items():
        m = re.match(r'^region_de(?:l)?_(.+)$', k)
        if not m or not v:
            continue
        clave = re.sub(r'_\d+$', '', m.group(1))
        region = _CLAVE_REGION.get(clave) or next((r for c, r in _CLAVE_REGION.items() if clave.startswith(c)), None)
        if not region:
            continue
        for a in _lista(v):
            res.setdefault(region, []).append(nombre_area(a))
    if not res and len(t.get('regiones_list') or []) == 1:
        res[t['regiones_list'][0]] = [nombre_area(a) for a in t.get('areas_protegidas') or []]
    return res


# ─── Fechas de actividad ──────────────────────────────────────────────────────
def _fecha(s):
    s = str(s or '').strip()[:10]
    for fmt in ('%d-%m-%Y', '%Y-%m-%d', '%d/%m/%Y'):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            pass
    return None


def periodo_actividades(t, region=None):
    d = t.get('datos_raw') or {}
    ini, fin = _fecha(d.get('fecha_inicio_actividades')), _fecha(d.get('fecha_termino_actividades'))
    if not ini:   # filmación: fechas por región (fecha_inicio_<region>)
        sufijos = [c for c, r in _CLAVE_REGION.items() if r == region] if region else list(_CLAVE_REGION)
        inis = [_fecha(d.get(f'fecha_inicio_{s}')) for s in sufijos]
        fins = [_fecha(d.get(f'fecha_termino_{s}')) for s in sufijos]
        inis, fins = [x for x in inis if x], [x for x in fins if x]
        ini, fin = (min(inis) if inis else None), (max(fins) if fins else None)
    if ini and fin and fin < ini:
        ini, fin = fin, ini
    return ini, fin


def situacion(t, region=None, hoy=None):
    """'ejecucion' | 'programado' | 'evaluacion' | None (terminado / rechazado / sin fechas)."""
    hoy = hoy or date.today()
    ajuste = (t.get('ajuste') or {}).get('sit')
    if ajuste in ('cerrado_admin', 'rechazado'):      # ajuste manual: desistido, anulado, rechazado…
        return None
    if t.get('estado') == 'rechazado' or t.get('borrador'):
        return None
    if ajuste == 'completado' and t.get('estado') == 'pendiente':
        t = {**t, 'estado': 'completado'}
    if t.get('estado') == 'pendiente':
        return 'evaluacion'
    ini, fin = periodo_actividades(t, region)
    if not ini:
        return None
    fin = fin or ini
    if ini <= hoy <= fin:
        return 'ejecucion'
    if ini > hoy:
        return 'programado'
    return None


# ─── Coordenadas declaradas ───────────────────────────────────────────────────
_DEC = re.compile(r'(-?\d{2}[.,]\d{3,})\s*[°º]?\s*([NnSs])?\s*[,;/ ]\s*(-?\d{2,3}[.,]\d{3,})\s*[°º]?\s*([EeOoWw])?')
_DMS = re.compile(r'(\d{2,3})\s*[°º]\s*(?:(\d{1,2}(?:[.,]\d+)?)\s*(?:[\'’′´]|min))?\s*(?:(\d{1,2}(?:[.,]\d+)?)\s*(?:"|”|″|\'\'|’’|seg))?\s*([NnSsEeOoWw])?')
_UTM = re.compile(r'(?<![\d.,])([1-8]\d{5})(?:[.,]\d+)?\s*(?:m\s*)?(?:[EeOo]\b)?[^\d]{0,25}?([2-8]\d{6})(?:[.,]\d+)?\s*(?:m\s*)?(?:[NnSs]\b)?')
_HUSO = re.compile(r'(?:huso|zona|zone|utm)\s*(1[89])|\b(1[89])\s*[HhGgJjKkFfSs]\b', re.I)


def _f(x):
    return float(str(x).replace(',', '.'))


def _en_chile(lat, lon):
    return -56.5 <= lat <= -17.0 and -110.0 <= lon <= -66.0


def _utm_a_latlon(e, n, huso):
    """UTM (hemisferio sur, WGS84) → (lat, lon)."""
    a, f = 6378137.0, 1 / 298.257223563
    k0, e2 = 0.9996, f * (2 - f)
    ep2 = e2 / (1 - e2)
    x, y = e - 500000.0, n - 10000000.0
    m = y / k0
    mu = m / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256))
    e1 = (1 - math.sqrt(1 - e2)) / (1 + math.sqrt(1 - e2))
    p1 = (mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * math.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * math.sin(4 * mu)
          + (151 * e1 ** 3 / 96) * math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * math.sin(8 * mu))
    n1 = a / math.sqrt(1 - e2 * math.sin(p1) ** 2)
    t1, c1 = math.tan(p1) ** 2, ep2 * math.cos(p1) ** 2
    r1 = a * (1 - e2) / (1 - e2 * math.sin(p1) ** 2) ** 1.5
    d = x / (n1 * k0)
    lat = p1 - (n1 * math.tan(p1) / r1) * (d ** 2 / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * ep2) * d ** 4 / 24
                                          + (61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * ep2 - 3 * c1 ** 2) * d ** 6 / 720)
    lon = (d - (1 + 2 * t1 + c1) * d ** 3 / 6 + (5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * ep2 + 24 * t1 ** 2) * d ** 5 / 120) / math.cos(p1)
    return math.degrees(lat), (huso - 1) * 6 - 180 + 3 + math.degrees(lon)


def coordenadas(texto, region=None, maximo=20):
    """Lista de (lat, lon) declaradas en un texto libre."""
    texto = str(texto or '')
    puntos = []

    for m in _DEC.finditer(texto):
        lat, lon = _f(m.group(1)), _f(m.group(3))
        lat, lon = -abs(lat), -abs(lon)
        if _en_chile(lat, lon):
            puntos.append((lat, lon))

    if not puntos:
        vals = []
        for m in _DMS.finditer(texto):
            g, mi, s = _f(m.group(1)), _f(m.group(2) or 0), _f(m.group(3) or 0)
            if mi >= 60 or s >= 60:
                continue
            vals.append(g + mi / 60 + s / 3600)
        lat = None
        for v in vals:          # empareja latitud (17–56) seguida de longitud (66–110)
            if 17 <= v <= 56.5:
                lat = v
            elif 66 <= v <= 110 and lat is not None:
                puntos.append((-lat, -v))
                lat = None

    if not puntos:
        mh = _HUSO.search(texto)
        huso = int(mh.group(1) or mh.group(2)) if mh else (18 if region in HUSO_18 else 19)
        for m in _UTM.finditer(texto):
            e, n = float(m.group(1)), float(m.group(2))
            lat, lon = _utm_a_latlon(e, n, huso)
            if _en_chile(lat, lon):
                puntos.append((round(lat, 6), round(lon, 6)))

    vistos, res = set(), []
    for p in puntos:
        k = (round(p[0], 4), round(p[1], 4))
        if k not in vistos:
            vistos.add(k)
            res.append(p)
    return res[:maximo]


# ─── Límites oficiales del SNAP (data/limites_snap.geojson) ──────────────────
# Generado con: python manage.py importar_limites_snap <shapefile>
TOLERANCIA_BORDE = 0.002      # ≈ 200 m: absorbe imprecisión de coordenadas junto al límite
SIMPLIF_MAPA = 0.001          # ≈ 100 m: geometría liviana para dibujar en el navegador
_limites_cache = None


def _limites():
    global _limites_cache
    if _limites_cache is None:
        import json
        import os
        from django.conf import settings
        from shapely.geometry import shape
        from shapely.prepared import prep
        _limites_cache = []
        ruta = os.path.join(settings.BASE_DIR, 'data', 'limites_snap.geojson')
        if os.path.exists(ruta):
            with open(ruta, encoding='utf-8') as f:
                for feat in json.load(f)['features']:
                    pr = feat['properties']
                    g = shape(feat['geometry'])
                    _limites_cache.append({
                        'nombre': pr['nombre'],
                        'unidad': _clave_area(pr.get('unidad') or _sin_categoria(pr['nombre'])),
                        'region': _sin_tildes((pr.get('region') or '').lower()),
                        'geom': g,
                        'dentro': prep(g.buffer(TOLERANCIA_BORDE)),
                        'mapa': None,
                    })
    return _limites_cache


_CATEGORIA = re.compile(
    r'^(parque nacional|parque natural|reserva nacional|reserva forestal|monumento natural|'
    r'santuario de la naturaleza|santuario naturaleza|sitio ramsar|area marina costera protegida|'
    r'isla \w+ area anexa a (?:reserva nacional|parque nacional)?)\s+', re.I)


def _sin_categoria(nombre):
    """'Reserva Nacional Federico Albert' → 'Federico Albert' (la categoría varía entre fuentes)."""
    s = _sin_tildes(nombre.lower()).strip()
    while True:
        nuevo = _CATEGORIA.sub('', s)
        if nuevo == s:
            return s
        s = nuevo


def _parecido_parcial(corto, largo):
    """Mejor parecido de `corto` con cualquier tramo de `largo` del mismo largo."""
    from difflib import SequenceMatcher
    if len(corto) > len(largo):
        corto, largo = largo, corto
    return max(SequenceMatcher(None, corto, largo[i:i + len(corto)]).ratio()
               for i in range(len(largo) - len(corto) + 1))


def limite_de(nombre, region=None):
    """Polígono oficial del área, comparando el nombre de la unidad sin la categoría.

    Tolera variantes de escritura ("Ielol"/"Nielol", "Humboldt"/"Humbolt") y nombres más
    largos en el formulario ("Villarrica Sector Sur", "Pumalín Douglas Tompkins"). La región
    desempata unidades homónimas.
    """
    from difflib import SequenceMatcher
    u = _clave_area(_sin_categoria(nombre))
    reg = _sin_tildes((region or '').lower())
    mejor, puntaje = None, 0.0
    for lim in _limites():
        lu = lim['unidad']
        s = SequenceMatcher(None, u, lu).ratio()
        if min(len(u), len(lu)) >= 6:
            s = max(s, _parecido_parcial(lu, u) - 0.02)
        if reg and reg.split()[0] in lim['region']:
            s += 0.03
        if s > puntaje:
            mejor, puntaje = lim, s
    return mejor if puntaje >= 0.88 else None


def _geojson_mapa(lim):
    if lim['mapa'] is None:
        from shapely.geometry import mapping
        lim['mapa'] = mapping(lim['geom'].simplify(SIMPLIF_MAPA, preserve_topology=True))
    return lim['mapa']


# ─── Cálculo principal ────────────────────────────────────────────────────────
def _tramites_recientes():
    anio = datetime.now(tramites_cache.TZ).year
    vistos, res = set(), []
    for a in range(anio - ANIOS_ATRAS, anio + 1):
        for t in tramites_cache.obtener(a, a)['data']:
            if t['id'] not in vistos:
                vistos.add(t['id'])
                res.append(t)
    from .ajustes import aplicar
    return aplicar(res)


def _tipo(t):
    from .core import INVESTIGACION_PROCESO_IDS
    return 'inv' if t.get('proceso_id') in INVESTIGACION_PROCESO_IDS else 'film'


def presion_region(region, tipo=None):
    """Áreas protegidas de la región con permisos activos y sus puntos para el mapa.
    tipo: 'inv' | 'film' | None (ambos)."""
    hoy = date.today()
    areas = {}
    for t in _tramites_recientes():
        if tipo and _tipo(t) != tipo:
            continue
        apr = areas_por_region(t)
        if region not in apr:
            continue
        sit = situacion(t, region, hoy)
        if not sit:
            continue
        d = t.get('datos_raw') or {}
        texto_loc = ' '.join(str(d.get(k) or '') for k in (
            'localizacion_geografica_del_proy', 'breve_descripcion_actividades_AS', 'descripcion', 'ubicacion'))
        pts = coordenadas(texto_loc, region)
        ini, fin = periodo_actividades(t, region)
        titulo = (d.get('titulo_del_proyecto') or d.get('titulo_investigacion') or d.get('nombre_proyecto')
                  or d.get('nombre_del_proyecto') or d.get('titulo') or '').strip()
        for area in dict.fromkeys(apr[region]):
            a = areas.setdefault(area, {'area': area, 'ejecucion': 0, 'programado': 0, 'evaluacion': 0,
                                        'inv': 0, 'film': 0, 'permisos': []})
            a[sit] += 1
            a[_tipo(t)] += 1
            a['permisos'].append({
                'id': t['id'], 'tipo': _tipo(t), 'situacion': sit, 'titulo': titulo[:180],
                'inicio': ini.isoformat() if ini else None, 'termino': fin.isoformat() if fin else None,
                'puntos': pts,
            })

    from shapely.geometry import Point
    res = []
    for a in _unificar_areas(areas).values():
        a['activos'] = a['ejecucion'] + a['programado'] + a['evaluacion']
        # Solo se conservan las coordenadas que caen dentro del límite oficial del área
        # (un permiso multisitio declara puntos de varias áreas en el mismo texto).
        lim = limite_de(a['area'], region)
        a['limite'] = _geojson_mapa(lim) if lim else None
        a['limite_nombre'] = lim['nombre'] if lim else None
        a['km2'] = centro_y_superficie(lim)[1] if lim else None
        a['puntos_fuera'] = 0
        caja = None if lim else _caja_region(region)
        for p in a['permisos']:
            if lim:
                dentro = [pt for pt in p['puntos'] if lim['dentro'].contains(Point(pt[1], pt[0]))]
            elif caja:   # sin límite oficial: al menos dentro de la región (descarta coordenadas mal escritas)
                dentro = [pt for pt in p['puntos'] if caja[0] <= pt[0] <= caja[1] and caja[2] <= pt[1] <= caja[3]]
            else:
                dentro = p['puntos']
            a['puntos_fuera'] += len(p['puntos']) - len(dentro)
            p['puntos'] = dentro
        res.append(a)
    res.sort(key=lambda x: (-x['ejecucion'], -x['activos'], x['area']))
    return res


_cajas_region = {}


def _caja_region(region, margen=0.4):
    """(lat_min, lat_max, lon_min, lon_max) de las áreas protegidas oficiales de la región,
    con un margen. None si la región no tiene áreas en el archivo de límites."""
    if region not in _cajas_region:
        clave = _sin_tildes((region or '').lower()).split()[0] if region else ''
        cajas = [lim['geom'].bounds for lim in _limites() if clave and clave in lim['region']]
        _cajas_region[region] = (
            min(c[1] for c in cajas) - margen, max(c[3] for c in cajas) + margen,
            min(c[0] for c in cajas) - margen, max(c[2] for c in cajas) + margen,
        ) if cajas else None
    return _cajas_region[region]


# ─── Vista territorial: escala nacional ───────────────────────────────────────
def centro_y_superficie(lim):
    """(lat, lon) de un punto interior del área y su superficie aproximada en km²."""
    if 'centro' not in lim:
        import math
        g = lim['geom']
        c = g.representative_point()
        lim['centro'] = (round(c.y, 5), round(c.x, 5))
        lim['km2'] = round(g.area * 111.32 ** 2 * math.cos(math.radians(c.y)), 1)
    return lim['centro'], lim['km2']


def presion_nacional(tipo=None):
    """Áreas protegidas de todo el país con permisos activos (en ejecución, programados o
    en evaluación), con su ubicación y superficie para el mapa nacional."""
    hoy = date.today()
    por_region = {}
    for t in _tramites_recientes():
        if tipo and _tipo(t) != tipo:
            continue
        for region, nombres in areas_por_region(t).items():
            sit = situacion(t, region, hoy)
            if not sit:
                continue
            areas = por_region.setdefault(region, {})
            for area in dict.fromkeys(nombres):
                a = areas.setdefault(area, {'area': area, 'region': region, 'ejecucion': 0, 'programado': 0,
                                            'evaluacion': 0, 'inv': 0, 'film': 0, 'permisos': []})
                a[sit] += 1
                a[_tipo(t)] += 1
                a['permisos'].append({'id': t['id'], 'situacion': sit, 'tipo': _tipo(t)})
    res = []
    for region, areas in por_region.items():
        for a in _unificar_areas(areas).values():
            a['activos'] = a['ejecucion'] + a['programado'] + a['evaluacion']
            a['ids_ejecucion'] = [x['id'] for x in a['permisos'] if x['situacion'] == 'ejecucion']
            a['ids'] = [x['id'] for x in a['permisos']]
            a['permisos'] = len(a['permisos'])
            lim = limite_de(a['area'], region)
            (lat, lon), km2 = centro_y_superficie(lim) if lim else ((None, None), None)
            a.update(lat=lat, lon=lon, km2=km2)
            res.append(a)
    res.sort(key=lambda x: (-x['activos'], x['area']))
    return res


# ─── Áreas protegidas por región de cada permiso (para filtrar por ámbito) ─────
_areas_region_cache = {}


def con_areas_por_region(lista):
    """Copia de los trámites con «areas_region» = {región: [áreas]} según el formulario
    (campos region_de_<x>). Así, en un permiso multirregional, al elegir una región solo
    cuentan las áreas que declaró para esa región."""
    res = []
    for t in lista:
        clave = (t.get('id'), t.get('fecha_modificacion'))
        apr = _areas_region_cache.get(clave)
        if apr is None:
            apr = {r: list(dict.fromkeys(a)) for r, a in areas_por_region(t).items()}
            if len(_areas_region_cache) > 20000:
                _areas_region_cache.clear()
            _areas_region_cache[clave] = apr
        res.append({**t, 'areas_region': apr})
    return res
