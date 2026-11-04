"""Normaliza la capitalización de nombres de Convenio (ALL CAPS → título correcto).

Convierte campos que están en mayúsculas a capitalización normal en español,
preservando acrónimos (CONAF, SAG, etc.) y conectores en minúscula (de, del, en, y…).

Uso:
    python manage.py normalizar_convenios [--dry-run] [--campos nombre,razon_social,objetivo]
"""
import re
import unicodedata
from django.core.management.base import BaseCommand


# Conectores y preposiciones en español que van en minúscula (excepto inicio de oración)
_CONECTORES = {
    'a', 'al', 'ante', 'bajo', 'cabe', 'con', 'contra', 'de', 'del',
    'desde', 'e', 'el', 'en', 'entre', 'es', 'hacia', 'hasta', 'la',
    'las', 'lo', 'los', 'o', 'para', 'pero', 'por', 'que', 'se', 'según',
    'sin', 'sobre', 'su', 'sus', 'tras', 'u', 'un', 'una', 'unas', 'unos',
    'y',
}

# Acrónimos conocidos que siempre van en mayúscula
_ACRONIMOS = {
    'CONAF', 'CONADI', 'SAG', 'SEREMI', 'PDI', 'MMA', 'MINAGRI', 'MINSEGPRES',
    'MOP', 'MINVU', 'GORE', 'CONAMA', 'SERNAC', 'SERCOTEC', 'CORFO', 'CONAC',
    'SER', 'SNS', 'FOSIS', 'INDAP', 'DGA', 'DIBAM', 'CMN', 'SENDA', 'SERNAM',
    'SENADIS', 'SENAMA', 'SENAME', 'SII', 'FONASA', 'ISAPRE', 'AFP', 'RUT',
    'PDF', 'SAF', 'SBAP', 'SAY', 'CEA', 'CEF', 'CEI', 'CNR', 'CIREN',
    'MINREL', 'MINSAL', 'MINEDU', 'MDS', 'MDF', 'MDN', 'MIDESO', 'MTESS',
    'SISS', 'SUBTEL', 'SERNA', 'SMA', 'CMF', 'CNE', 'CDA', 'COSOC',
}


def _es_mayusculas(texto):
    """True si el texto tiene >65% de letras en mayúscula."""
    letras = [c for c in texto if c.isalpha()]
    if not letras:
        return False
    return sum(c.isupper() for c in letras) / len(letras) > 0.65


def _smart_title(texto):
    """Convierte texto ALL CAPS a capitalización española correcta."""
    if not texto or not _es_mayusculas(texto):
        return texto

    palabras = texto.split()
    resultado = []

    for i, palabra in enumerate(palabras):
        # Separar prefijo de puntuación (ej: "(CONAF)" → "(", "CONAF", ")")
        m = re.match(r'^([^a-zA-ZáéíóúüñÁÉÍÓÚÜÑ]*)([a-zA-ZáéíóúüñÁÉÍÓÚÜÑ.]+)([^a-zA-ZáéíóúüñÁÉÍÓÚÜÑ]*)$', palabra)
        if not m:
            resultado.append(palabra)
            continue

        pre, nucleo, suf = m.group(1), m.group(2), m.group(3)
        nucleo_sin_puntos = nucleo.replace('.', '').upper()

        if nucleo_sin_puntos in _ACRONIMOS:
            # Acrónimo conocido → siempre mayúscula
            resultado.append(pre + nucleo.upper() + suf)
        elif i > 0 and nucleo.lower() in _CONECTORES:
            # Conector en posición no inicial → minúscula (va antes del chequeo de longitud)
            resultado.append(pre + nucleo.lower() + suf)
        elif nucleo.isupper() and len(nucleo.replace('.', '')) <= 6:
            # Palabra corta toda en mayúscula → probablemente acrónimo, conservar
            resultado.append(pre + nucleo.upper() + suf)
        else:
            # Capitalizar primera letra, resto en minúscula
            n_lower = nucleo.lower()
            resultado.append(pre + n_lower[0].upper() + n_lower[1:] + suf)

    return ' '.join(resultado)


CAMPOS_DEFAULT = ['nombre', 'razon_social']


class Command(BaseCommand):
    help = 'Normaliza capitalización de convenios: ALL CAPS → título correcto'

    def add_arguments(self, parser):
        parser.add_argument('--dry-run', action='store_true',
                            help='Muestra cambios sin guardar')
        parser.add_argument('--campos', default=','.join(CAMPOS_DEFAULT),
                            help=f'Campos a normalizar (default: {",".join(CAMPOS_DEFAULT)})')

    def handle(self, *args, **options):
        from tramites.models import Convenio
        dry = options['dry_run']
        campos = [c.strip() for c in options['campos'].split(',') if c.strip()]

        convenios = Convenio.objects.all()
        cambiados = 0
        sin_cambio = 0

        for c in convenios:
            update_fields = []
            for campo in campos:
                original = getattr(c, campo, '')
                if not original:
                    continue
                nuevo = _smart_title(original)
                if nuevo != original:
                    setattr(c, campo, nuevo)
                    update_fields.append(campo)
                    if dry:
                        self.stdout.write(
                            f'  [{c.id}] {campo}:\n'
                            f'    ANTES: {original[:100]}\n'
                            f'    NUEVO: {nuevo[:100]}'
                        )
            if update_fields:
                cambiados += 1
                if not dry:
                    c.save(update_fields=update_fields)
            else:
                sin_cambio += 1

        self.stdout.write(self.style.SUCCESS(
            f'\nResumen: {cambiados} convenios {"que cambiarían" if dry else "actualizados"} | '
            f'{sin_cambio} sin cambio'
        ))
        if dry:
            self.stdout.write(self.style.WARNING('-- DRY RUN: ningún cambio guardado --'))
