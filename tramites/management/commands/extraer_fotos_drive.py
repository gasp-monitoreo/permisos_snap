from django.core.management.base import BaseCommand, CommandError

from tramites import fotos
from tramites.drive_utils import DRIVE_FOLDER_ID, build_index, get_drive_service


class Command(BaseCommand):
    help = 'Extrae fotografías de los documentos entregados en Drive para usarlas como portadas'

    def add_arguments(self, parser):
        parser.add_argument('--reprocesar', action='store_true',
                            help='Vuelve a procesar documentos ya revisados')

    def handle(self, *args, **opts):
        svc, err = get_drive_service()
        if err:
            raise CommandError(f'Drive no disponible: {err}')
        self.stdout.write('Leyendo índice de Drive…')
        index = build_index(svc, DRIVE_FOLDER_ID)
        n = fotos.extraer(svc, index, reprocesar=opts['reprocesar'], log=self.stdout.write)
        total = len(fotos.fotos_activas())
        self.stdout.write(self.style.SUCCESS(f'{n} fotos nuevas · {total} activas en total'))
