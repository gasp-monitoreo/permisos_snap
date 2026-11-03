"""Vincula los PDFs de Google Drive con los registros de Convenio.

Lee todos los archivos de la carpeta Drive de convenios, los cruza con
el campo nombre_archivo de cada Convenio por nombre (exacto o más parecido)
y actualiza drive_id y drive_url.

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


class Command(BaseCommand):
    help = 'Vincula PDFs de Google Drive con registros Convenio por nombre de archivo'

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
        self.stdout.write(f'  {len(archivos)} archivos en Drive')

        # Índice normalizado → archivo
        idx = {_normalizar(a['name']): a for a in archivos}
        # También sin extensión
        idx_sin_ext = {}
        for a in archivos:
            nombre_sin = re.sub(r'\.[^.]+$', '', a['name'])
            k = _normalizar(nombre_sin)
            if k not in idx_sin_ext:
                idx_sin_ext[k] = a

        convenios = Convenio.objects.all()
        vinculados = sin_pdf = ya_ok = no_encontrado = 0

        for c in convenios:
            # --- slot 1 ---
            if not c.nombre_archivo:
                sin_pdf += 1
                continue

            if c.drive_id:
                ya_ok += 1
            else:
                k_completo = _normalizar(c.nombre_archivo)
                k_sin_ext  = _normalizar(re.sub(r'\.[^.]+$', '', c.nombre_archivo))

                archivo = idx.get(k_completo) or idx_sin_ext.get(k_sin_ext)

                if archivo:
                    vinculados += 1
                    self.stdout.write(f'  ✓ [{c.id}] {c.nombre_archivo[:60]} → {archivo["id"]}')
                    if not dry:
                        c.drive_id  = archivo['id']
                        c.drive_url = archivo['url']
                        c.save(update_fields=['drive_id', 'drive_url'])
                else:
                    no_encontrado += 1
                    self.stdout.write(self.style.WARNING(
                        f'  ? [{c.id}] Sin match: {c.nombre_archivo[:80]}'
                    ))

            # --- slot 2 ---
            if c.nombre_archivo2 and not c.drive_id2:
                k2 = _normalizar(c.nombre_archivo2)
                k2s = _normalizar(re.sub(r'\.[^.]+$', '', c.nombre_archivo2))
                a2 = idx.get(k2) or idx_sin_ext.get(k2s)
                if a2:
                    self.stdout.write(f'  ✓ [{c.id}] PDF2: {c.nombre_archivo2[:60]} → {a2["id"]}')
                    if not dry:
                        c.drive_id2  = a2['id']
                        c.drive_url2 = a2['url']
                        c.save(update_fields=['drive_id2', 'drive_url2'])

        self.stdout.write(self.style.SUCCESS(
            f'\nResumen: {vinculados} vinculados | {ya_ok} ya tenían ID | '
            f'{no_encontrado} sin match | {sin_pdf} sin nombre de archivo'
        ))
        if dry:
            self.stdout.write(self.style.WARNING('-- DRY RUN: ningún cambio guardado --'))
