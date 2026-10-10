"""Convierte el shapefile oficial de límites del SNAP en un GeoJSON liviano.

    python manage.py importar_limites_snap data/snap_shp/SNAP_CONAF_nov_2025

El shapefile viene en SIRGAS-Chile 2002 geográficas, equivalente a WGS84 en la
práctica (diferencia < 1 m), por lo que no se reproyecta. La geometría se simplifica
(~100 m) para que el archivo sea manejable (~13 MB) sin perder precisión útil: la
verificación de puntos usa además una tolerancia de ~200 m en el borde.
"""
import json
import os

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

TOLERANCIA_GRADOS = 0.001    # ≈ 100 m


class Command(BaseCommand):
    help = 'Genera data/limites_snap.geojson a partir del shapefile oficial de áreas protegidas'

    def add_arguments(self, parser):
        parser.add_argument('shapefile', help='Ruta al shapefile (sin extensión o con .shp)')
        parser.add_argument('--tolerancia', type=float, default=TOLERANCIA_GRADOS)

    def handle(self, *args, **opts):
        import shapefile
        from shapely.geometry import mapping, shape
        from shapely.validation import make_valid

        ruta = opts['shapefile'].removesuffix('.shp')
        if not os.path.exists(ruta + '.shp'):
            raise CommandError(f'No existe {ruta}.shp')
        r = shapefile.Reader(ruta, encoding='utf-8')
        features = []
        total = len(r)
        for i, sr in enumerate(r.iterShapeRecords(), 1):
            rec = sr.record.as_dict()
            # Simplificación rápida (Douglas-Peucker) y luego reparación de la geometría:
            # preserve_topology=True es muy lento en los polígonos marinos más grandes.
            geom = shape(sr.shape.__geo_interface__).simplify(opts['tolerancia'], preserve_topology=False)
            if not geom.is_valid:
                geom = make_valid(geom)
            geom = geom.buffer(0) if geom.geom_type not in ('Polygon', 'MultiPolygon') else geom
            if geom.is_empty:
                continue
            self.stdout.write(f'  [{i}/{total}] {rec.get("NOMBRE_TOT")}')
            features.append({
                'type': 'Feature',
                'properties': {
                    'nombre': (rec.get('NOMBRE_TOT') or '').strip(),
                    'unidad': (rec.get('NOMBRE_UNI') or '').strip(),
                    'categoria': (rec.get('CATEGORIA') or '').strip(),
                    'region': (rec.get('REGION') or '').strip(),
                    'sup_ha': rec.get('Sup_ha'),
                },
                'geometry': mapping(geom),
            })
        destino = os.path.join(settings.BASE_DIR, 'data', 'limites_snap.geojson')
        os.makedirs(os.path.dirname(destino), exist_ok=True)
        with open(destino, 'w', encoding='utf-8') as f:
            json.dump({'type': 'FeatureCollection', 'features': features}, f, ensure_ascii=False,
                      separators=(',', ':'))
        mb = os.path.getsize(destino) / 1e6
        self.stdout.write(self.style.SUCCESS(f'{len(features)} áreas → {destino} ({mb:.1f} MB)'))
