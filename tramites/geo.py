"""Geometrías del registro geográfico: validación e importación de archivos GPS/SIG.

Todo se guarda como GeoJSON en WGS84 (longitud, latitud). Se aceptan:
  GeoJSON (.geojson/.json), KML/KMZ (Google Earth), GPX (GPS), CSV con coordenadas
  (decimales o UTM) y Shapefile comprimido (.zip con .shp/.shx/.dbf/.prj).
Las coordenadas UTM (huso 18 o 19 sur, WGS84/SIRGAS-Chile) se convierten a lat/lon.
Los archivos se leen en memoria y nunca se guardan en disco.
"""
import csv
import io
import json
import re
import zipfile
from xml.etree import ElementTree as ET

from .presion import _utm_a_latlon

MAX_VERTICES = 5000
MAX_ELEMENTOS = 2000
MAX_ARCHIVO = 10 * 1024 * 1024
TIPO_DE = {'Point': 'punto', 'LineString': 'linea', 'Polygon': 'poligono'}


class GeoError(ValueError):
    pass


def _en_chile(lon, lat):
    # Chile continental, insular (Juan Fernández, Rapa Nui) y antártico cercano
    return -110.0 <= lon <= -66.0 and -60.0 <= lat <= -17.0


def _punto(c):
    if not isinstance(c, (list, tuple)) or len(c) < 2:
        raise GeoError('Coordenada mal formada.')
    try:
        lon, lat = float(c[0]), float(c[1])
    except (TypeError, ValueError):
        raise GeoError('Coordenada no numérica.')
    if not _en_chile(lon, lat):
        raise GeoError(f'La coordenada ({lat:.5f}, {lon:.5f}) queda fuera de Chile. '
                       'Revise que la latitud y la longitud no estén invertidas.')
    return [round(lon, 7), round(lat, 7)]


def validar_geometria(g):
    """Geometría GeoJSON simple (Point, LineString, Polygon) normalizada, o GeoError."""
    if not isinstance(g, dict) or g.get('type') not in TIPO_DE:
        raise GeoError('Geometría no reconocida: use punto, línea o polígono.')
    t, c = g['type'], g.get('coordinates')
    if t == 'Point':
        return {'type': t, 'coordinates': _punto(c)}
    if t == 'LineString':
        pts = [_punto(p) for p in (c or [])]
        if len(pts) < 2:
            raise GeoError('Un transecto necesita al menos 2 puntos.')
        if len(pts) > MAX_VERTICES:
            raise GeoError(f'Máximo {MAX_VERTICES} vértices por elemento.')
        return {'type': t, 'coordinates': pts}
    anillos = []
    for anillo in (c or [])[:50]:
        pts = [_punto(p) for p in anillo]
        if pts and pts[0] != pts[-1]:
            pts.append(pts[0])           # cierra el polígono
        if len(pts) < 4:
            raise GeoError('Una parcela necesita al menos 3 vértices.')
        anillos.append(pts)
    if not anillos:
        raise GeoError('Polígono vacío.')
    if sum(len(a) for a in anillos) > MAX_VERTICES:
        raise GeoError(f'Máximo {MAX_VERTICES} vértices por elemento.')
    return {'type': t, 'coordinates': anillos}


def _simples(g):
    """Separa geometrías múltiples (MultiPoint, MultiPolygon, colecciones) en simples."""
    if not isinstance(g, dict):
        return []
    t = g.get('type')
    if t in TIPO_DE:
        return [g]
    if t in ('MultiPoint', 'MultiLineString', 'MultiPolygon'):
        return [{'type': t[5:], 'coordinates': c} for c in g.get('coordinates') or []]
    if t == 'GeometryCollection':
        return [s for x in g.get('geometries') or [] for s in _simples(x)]
    return []


def _elemento(geom, props, avisos):
    try:
        g = validar_geometria(geom)
    except GeoError as e:
        avisos.append(str(e))
        return None
    props = {str(k)[:60]: (v if isinstance(v, (int, float, bool)) or v is None else str(v)[:500])
             for k, v in (props or {}).items()}
    nombre = next((str(props[k]) for k in ('nombre', 'name', 'Name', 'NOMBRE', 'id', 'ID') if props.get(k)), '')
    return {'geometry': g, 'tipo': TIPO_DE[g['type']], 'nombre': nombre[:200], 'atributos': props}


# ─── Formatos ─────────────────────────────────────────────────────────────────
def _geojson(texto, avisos):
    try:
        d = json.loads(texto)
    except ValueError:
        raise GeoError('El archivo no es un GeoJSON válido.')
    crs = json.dumps(d.get('crs') or {})
    if re.search(r'EPSG:+(32718|32719|5361|5362)', crs):
        raise GeoError('El GeoJSON está en UTM; expórtelo en WGS84 (EPSG:4326) o súbalo como Shapefile.')
    feats = d.get('features') if d.get('type') == 'FeatureCollection' else [d if d.get('type') == 'Feature' else {'geometry': d}]
    res = []
    for f in feats or []:
        for g in _simples(f.get('geometry')):
            e = _elemento(g, f.get('properties'), avisos)
            if e:
                res.append(e)
    return res


def _sin_ns(tag):
    return tag.rsplit('}', 1)[-1]


def _coords_kml(texto):
    pts = []
    for tupla in (texto or '').split():
        partes = tupla.split(',')
        if len(partes) >= 2:
            pts.append([partes[0], partes[1]])
    return pts


def _kml(texto, avisos):
    try:
        raiz = ET.fromstring(texto)
    except ET.ParseError:
        raise GeoError('El archivo KML está dañado.')
    res = []
    for pm in raiz.iter():
        if _sin_ns(pm.tag) != 'Placemark':
            continue
        props = {}
        for hijo in pm:
            n = _sin_ns(hijo.tag)
            if n in ('name', 'description') and (hijo.text or '').strip():
                props['nombre' if n == 'name' else 'descripcion'] = hijo.text.strip()
        for dato in pm.iter():
            if _sin_ns(dato.tag) in ('Data', 'SimpleData') and dato.get('name'):
                val = next((x.text for x in dato if _sin_ns(x.tag) == 'value'), dato.text)
                if val:
                    props[dato.get('name')] = val.strip()
        for geo in pm.iter():
            n = _sin_ns(geo.tag)
            if n == 'Point':
                c = next((x.text for x in geo.iter() if _sin_ns(x.tag) == 'coordinates'), '')
                g = {'type': 'Point', 'coordinates': (_coords_kml(c) or [None])[0]}
            elif n == 'LineString':
                c = next((x.text for x in geo.iter() if _sin_ns(x.tag) == 'coordinates'), '')
                g = {'type': 'LineString', 'coordinates': _coords_kml(c)}
            elif n == 'Polygon':
                anillos = []
                for borde in geo:
                    if _sin_ns(borde.tag) in ('outerBoundaryIs', 'innerBoundaryIs'):
                        c = next((x.text for x in borde.iter() if _sin_ns(x.tag) == 'coordinates'), '')
                        anillos.append(_coords_kml(c))
                g = {'type': 'Polygon', 'coordinates': anillos}
            else:
                continue
            e = _elemento(g, props, avisos)
            if e:
                res.append(e)
    return res


def _gpx(texto, avisos):
    try:
        raiz = ET.fromstring(texto)
    except ET.ParseError:
        raise GeoError('El archivo GPX está dañado.')
    res = []

    def nombre(el):
        return next(((x.text or '').strip() for x in el if _sin_ns(x.tag) == 'name'), '')

    def punto(el):
        return [el.get('lon'), el.get('lat')]
    for el in raiz:
        n = _sin_ns(el.tag)
        if n == 'wpt':
            e = _elemento({'type': 'Point', 'coordinates': punto(el)}, {'nombre': nombre(el)}, avisos)
            res += [e] if e else []
        elif n == 'rte':
            pts = [punto(p) for p in el if _sin_ns(p.tag) == 'rtept']
            e = _elemento({'type': 'LineString', 'coordinates': pts}, {'nombre': nombre(el)}, avisos)
            res += [e] if e else []
        elif n == 'trk':
            for seg in el:
                if _sin_ns(seg.tag) == 'trkseg':
                    pts = [punto(p) for p in seg if _sin_ns(p.tag) == 'trkpt']
                    e = _elemento({'type': 'LineString', 'coordinates': pts}, {'nombre': nombre(el)}, avisos)
                    res += [e] if e else []
    return res


_COL_LAT = ('lat', 'latitud', 'latitude', 'y')
_COL_LON = ('lon', 'lng', 'long', 'longitud', 'longitude', 'x')
_COL_E = ('este', 'easting', 'utm_e', 'utm_este', 'e')
_COL_N = ('norte', 'northing', 'utm_n', 'utm_norte', 'n')


def _num(v):
    return float(str(v).strip().replace(',', '.'))


def _csv(texto, avisos, huso=None):
    muestra = texto[:4096]
    try:
        dialecto = csv.Sniffer().sniff(muestra, delimiters=',;\t')
    except csv.Error:
        dialecto = csv.excel
    filas = list(csv.DictReader(io.StringIO(texto), dialect=dialecto))
    if not filas:
        raise GeoError('El CSV está vacío.')
    cols = {c.strip().lower(): c for c in filas[0].keys() if c}
    busca = lambda opciones: next((cols[o] for o in opciones if o in cols), None)
    clat, clon, ce, cn = busca(_COL_LAT), busca(_COL_LON), busca(_COL_E), busca(_COL_N)
    chuso = busca(('huso', 'zona', 'zone'))
    if not ((clat and clon) or (ce and cn)):
        raise GeoError('El CSV debe tener columnas «latitud» y «longitud» (decimales) o «este» y «norte» (UTM).')
    res = []
    for i, f in enumerate(filas, start=2):
        try:
            if clat and clon:
                lat, lon = _num(f[clat]), _num(f[clon])
                if lat > 0 and lon > 0:      # sin signo: en Chile ambas son negativas
                    lat, lon = -lat, -lon
            else:
                h = int(_num(f[chuso])) if chuso and f.get(chuso) else (huso or 19)
                lat, lon = _utm_a_latlon(_num(f[ce]), _num(f[cn]), h)
        except (TypeError, ValueError, KeyError):
            avisos.append(f'Fila {i}: coordenada vacía o no numérica.')
            continue
        props = {k: v for k, v in f.items() if k and k not in (clat, clon, ce, cn, chuso)}
        e = _elemento({'type': 'Point', 'coordinates': [lon, lat]}, props, avisos)
        if e:
            res.append(e)
    return res


def _huso_prj(prj):
    """Huso UTM sur declarado en el .prj, 0 si es geográfico (lat/lon), o None si no se reconoce."""
    p = prj.upper()
    m = re.search(r'UTM[_ ]ZONE[_ ](\d{2})\s*S|(\d{2})S["_ ]', p)
    if m:
        return int(m.group(1) or m.group(2))
    if p.startswith('GEOGCS') or 'PROJCS' not in p:
        return 0
    return None


def _shapefile(contenido, avisos):
    import shapefile   # pyshp
    try:
        z = zipfile.ZipFile(io.BytesIO(contenido))
    except zipfile.BadZipFile:
        raise GeoError('El .zip está dañado.')
    nombres = {n.lower(): n for n in z.namelist() if not n.startswith('__MACOSX')}
    shp = next((n for n in nombres if n.endswith('.shp')), None)
    if not shp:
        raise GeoError('El .zip no contiene un Shapefile (.shp).')
    base = shp[:-4]
    leer = lambda ext: z.read(nombres[base + ext]) if base + ext in nombres else None
    prj = (leer('.prj') or b'').decode('latin-1')
    huso = _huso_prj(prj) if prj else 0
    if huso is None:
        raise GeoError('Proyección no reconocida. Exporte el Shapefile en WGS84 (lat/lon) o UTM 18S/19S.')
    if not prj:
        avisos.append('El Shapefile no trae .prj: se asumió WGS84 (lat/lon).')
    r = shapefile.Reader(shp=io.BytesIO(leer('.shp')), shx=io.BytesIO(leer('.shx') or b'') if leer('.shx') else None,
                         dbf=io.BytesIO(leer('.dbf')) if leer('.dbf') else None, encoding='latin-1')
    a_lonlat = (lambda x, y: [x, y]) if not huso else (lambda x, y: list(reversed(_utm_a_latlon(x, y, huso))))
    res = []
    campos = [f[0] for f in r.fields[1:]]
    for sr in r.iterShapeRecords():
        g = sr.shape.__geo_interface__
        props = dict(zip(campos, sr.record)) if campos else {}

        def conv(c):
            if isinstance(c, (list, tuple)) and c and isinstance(c[0], (int, float)):
                return a_lonlat(c[0], c[1])
            return [conv(x) for x in c]
        for s in _simples({'type': g['type'], 'coordinates': conv(g['coordinates'])}):
            e = _elemento(s, props, avisos)
            if e:
                res.append(e)
    return res


def importar(nombre, contenido, huso=None):
    """(elementos, avisos) desde un archivo subido. Los elementos aún no se guardan."""
    if len(contenido) > MAX_ARCHIVO:
        raise GeoError('El archivo supera 10 MB.')
    ext = nombre.lower().rsplit('.', 1)[-1] if '.' in nombre else ''
    avisos = []
    texto = lambda b: b.decode('utf-8-sig', errors='replace')
    if ext in ('geojson', 'json'):
        res = _geojson(texto(contenido), avisos)
    elif ext == 'kml':
        res = _kml(contenido, avisos)
    elif ext == 'kmz':
        try:
            z = zipfile.ZipFile(io.BytesIO(contenido))
            kml = next(n for n in z.namelist() if n.lower().endswith('.kml'))
        except (zipfile.BadZipFile, StopIteration):
            raise GeoError('El KMZ no contiene un KML.')
        res = _kml(z.read(kml), avisos)
    elif ext == 'gpx':
        res = _gpx(contenido, avisos)
    elif ext in ('csv', 'txt'):
        res = _csv(texto(contenido), avisos, huso)
    elif ext == 'zip':
        res = _shapefile(contenido, avisos)
    else:
        raise GeoError('Formato no soportado. Use GeoJSON, KML, KMZ, GPX, CSV o Shapefile (.zip).')
    if not res:
        raise GeoError('No se encontraron puntos, líneas ni polígonos válidos en el archivo.'
                       + (f' {avisos[0]}' if avisos else ''))
    if len(res) > MAX_ELEMENTOS:
        avisos.append(f'El archivo trae {len(res)} elementos; se tomaron los primeros {MAX_ELEMENTOS}.')
        res = res[:MAX_ELEMENTOS]
    # un mismo aviso repetido por cada fila no aporta: se resumen
    vistos, unicos = set(), []
    for a in avisos:
        if a not in vistos:
            vistos.add(a)
            unicos.append(a)
    return res, unicos[:20]
