"""Vincula los PDFs de Google Drive con los registros de Convenio.

Estrategia de matching (en orden de prioridad):
  1. Si nombre_archivo está relleno → busca ese archivo exacto en Drive.
  2. Si nombre_archivo está vacío → infiere el archivo usando el año (anio)
     y el nombre del convenio normalizado contra los títulos de Drive.
     Los archivos Drive siguen el patrón "YEAR - TITULO.pdf".

Uso:
    python manage.py vincular_pdfs_convenios [--dry-run]
"""
import unicodedata
import re

from django.core.management.base import BaseCommand

CONVENIOS_DRIVE_FOLDER = '1rTjd2Ejtuzmva0OCDp_z5albHWeG0IVN'


def _normalizar(s):
    """Minúsculas, sin tildes, sin caracteres especiales."""
    s = str(s or '').strip().lower()
    s = unicodedata.normalize('NFD', s)
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')
    s = re.sub(r'[^a-z0-9]+', ' ', s).strip()
    return s


def _palabras(s):
    return set(_normalizar(s).split())


def _similitud(a, b):
    """Similitud Jaccard entre palabras de dos strings normalizados."""
    pa, pb = _palabras(a), _palabras(b)
    if not pa or not pb:
        return 0.0
    return len(pa & pb) / len(pa | pb)


def _parsear_nombre_drive(nombre):
    """Extrae (anio, titulo_norm) de un nombre Drive tipo '2021 - TITULO.pdf'."""
    nombre_sin = re.sub(r'\.[^.]+$', '', nombre)
    m = re.match(r'^(\d{4})\s*[-–]\s*(.+)$', nombre_sin)
    if m:
        return int(m.group(1)), _normalizar(m.group(2))
    return None, _normalizar(nombre_sin)


def _listar_drive(service, folder_id):
    """Devuelve lista de dicts {id, name, url}."""
    items, page_token = [], None
    while True:
        resp = service.files().list(
            q=f"'{folder_id}' in parents and trashed=false",
            fields='nextPageToken, files(id, name, mimeType)',
            orderBy='name',
            pageSize=1000,
            pageToken=page_token,
        ).execute()
        for f in resp.get('files', []):
            items.append({
                'id':   f['id'],
                'name': f['name'],
                'url':  f'https://drive.google.com/file/d/{f["id"]}/view',
            })
        page_token = resp.get('nextPageToken')
        if not page_token:
            break
    return items


SIMILITUD_MINIMA = 0.55  # umbral Jaccard para aceptar match por nombre


class Command(BaseCommand):
    help = 'Vincula PDFs de Google Drive con registros Convenio'

    def add_arguments(self, parser):
        parser.add_argument('--dry-run', action='store_true',
                            help='Muestra coincidencias sin actualizar la BD')

    def handle(self, *args, **options):
        dry = options['dry_run']

        from tramites.drive_utils import get_drive_service
        from tramites.models import Convenio

        svc, err = get_drive_service()
        if err:
            self.stderr.write(self.style.ERROR(f'Drive no disponible: {err}'))
            return

        self.stdout.write('Listando archivos en Drive…')
        archivos = _listar_drive(svc, CONVENIOS_DRIVE_FOLDER)
        # Sólo PDFs (excluye .txt, .doc, etc.)
        pdfs = [a for a in archivos if re.search(r'\.pdf$', a['name'], re.I)]
        self.stdout.write(f'  {len(pdfs)} PDFs en Drive ({len(archivos)} archivos totales)')

        # Índice 1: por nombre completo normalizado → archivo
        idx_nombre = {_normalizar(a['name']): a for a in pdfs}
        # Índice 2: por nombre sin extensión normalizado → archivo
        idx_sin_ext = {}
        for a in pdfs:
            k = _normalizar(re.sub(r'\.[^.]+$', '', a['name']))
            if k not in idx_sin_ext:
                idx_sin_ext[k] = a
        # Índice 3: por (anio, titulo_norm) para matching por nombre del convenio
        idx_anio_titulo = {}
        for a in pdfs:
            anio_d, titulo_norm = _parsear_nombre_drive(a['name'])
            if anio_d:
                idx_anio_titulo.setdefault(anio_d, []).append((titulo_norm, a))

        convenios = Convenio.objects.all()
        vinculados = sin_pdf = ya_ok = no_encontrado = infiridos = 0

        for c in convenios:
            # --- slot 1 ---
            if c.drive_id:
                ya_ok += 1
            elif c.nombre_archivo:
                # Estrategia A: match exacto por nombre_archivo
                k_completo = _normalizar(c.nombre_archivo)
                k_sin_ext  = _normalizar(re.sub(r'\.[^.]+$', '', c.nombre_archivo))
                archivo = idx_nombre.get(k_completo) or idx_sin_ext.get(k_sin_ext)
                if archivo:
                    vinculados += 1
                    self.stdout.write(f'  ✓ A [{c.id}] {c.nombre_archivo[:60]} → {archivo["id"]}')
                    if not dry:
                        c.drive_id  = archivo['id']
                        c.drive_url = archivo['url']
                        c.save(update_fields=['drive_id', 'drive_url'])
                else:
                    no_encontrado += 1
                    self.stdout.write(self.style.WARNING(
                        f'  ? [{c.id}] Sin match: {c.nombre_archivo[:80]}'
                    ))
            elif c.anio and c.nombre:
                # Estrategia B: inferir por año + similitud de título
                candidatos = idx_anio_titulo.get(c.anio, [])
                nombre_norm = _normalizar(c.nombre)
                mejor = max(candidatos, key=lambda x: _similitud(x[0], nombre_norm), default=None)
                if mejor and _similitud(mejor[0], nombre_norm) >= SIMILITUD_MINIMA:
                    sim = _similitud(mejor[0], nombre_norm)
                    archivo = mejor[1]
                    infiridos += 1
                    self.stdout.write(
                        f'  ✓ B [{c.id}] sim={sim:.2f} | {c.nombre[:50]} → {archivo["name"][:50]}'
                    )
                    if not dry:
                        c.nombre_archivo = archivo['name']
                        c.drive_id  = archivo['id']
                        c.drive_url = archivo['url']
                        c.save(update_fields=['nombre_archivo', 'drive_id', 'drive_url'])
                else:
                    no_encontrado += 1
                    sim_str = f'{_similitud(mejor[0], nombre_norm):.2f}' if mejor else '—'
                    self.stdout.write(self.style.WARNING(
                        f'  ? B [{c.id}] sim={sim_str} Sin match: {c.nombre[:70]}'
                    ))
            else:
                sin_pdf += 1

            # --- slot 2 ---
            if c.nombre_archivo2 and not c.drive_id2:
                k2 = _normalizar(c.nombre_archivo2)
                k2s = _normalizar(re.sub(r'\.[^.]+$', '', c.nombre_archivo2))
                a2 = idx_nombre.get(k2) or idx_sin_ext.get(k2s)
                if a2:
                    self.stdout.write(f'  ✓ [{c.id}] PDF2: {c.nombre_archivo2[:60]} → {a2["id"]}')
                    if not dry:
                        c.drive_id2  = a2['id']
                        c.drive_url2 = a2['url']
                        c.save(update_fields=['drive_id2', 'drive_url2'])

        self.stdout.write(self.style.SUCCESS(
            f'\nResumen: {vinculados} por nombre_archivo | {infiridos} inferidos por año+nombre | '
            f'{ya_ok} ya tenían ID | {no_encontrado} sin match | {sin_pdf} sin año/nombre'
        ))
        if dry:
            self.stdout.write(self.style.WARNING('-- DRY RUN: ningún cambio guardado --'))
