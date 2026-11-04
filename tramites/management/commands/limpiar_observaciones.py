"""Convierte las observaciones técnicas de cotejo PDF en texto natural legible.

Las observaciones generadas por el proceso de cotejo tienen la forma:
  [VERIFICADO CON PDF fecha] Titulo oficial: "...". Firmante CONAF: ... CAMBIOS/COTEJO: ...

Este comando las reemplaza por un párrafo natural con los datos relevantes:
  objetivo / firmante / representante / resoluciones / anexos

Uso:
    python manage.py limpiar_observaciones [--dry-run] [--id ID]
"""
import re
from django.core.management.base import BaseCommand


# Frases técnicas que siempre se omiten
_OMITIR_PATRONES = [
    r'\[VERIFICADO CON PDF[^\]]+\]\s*',
    r'Titulo oficial:\s*"[^"]+"\.\s*',
    r'Tipo:\s*[^.]+\.\s*',
    r'Firmante CONAF:\s*[^.]+\.\s*',
    r'Nota:\s*PDF (?:escaneado|imagen|con texto)[^.]*\.\s*',
    r'Nota:\s*leído con [^.]+\.\s*',
    r'Fecha de firma inferida[^.]*\.\s*',
    r'\[Cotejo:[^\]]+\]\s*',
]


def _extraer(patron, texto, grupo=1):
    m = re.search(patron, texto, re.DOTALL)
    return m.group(grupo).strip() if m else ''


def _limpiar(obs):
    """Transforma una observación técnica en texto natural."""
    if not obs:
        return ''
    obs = str(obs).strip()
    if obs.lower() == 'nan':
        return ''

    # ── 1. Separar prefijo antes de " || " ──────────────────────────────────
    prefix = ''
    if ' || ' in obs:
        pre, obs = obs.split(' || ', 1)
        pre = pre.strip()
        if pre.lower() not in ('nan', ''):
            prefix = pre

    # ── 2. Si no es observación de cotejo, limpiar y devolver ───────────────
    if '[VERIFICADO CON PDF' not in obs:
        # Puede ser texto simple; solo limpiar "nan"
        texto = obs.strip()
        if texto.lower() == 'nan':
            texto = ''
        partes = [p for p in [texto, prefix] if p]
        return ' '.join(partes).strip()

    # ── 3. Extraer datos estructurados ──────────────────────────────────────
    # Firmante CONAF
    firmante = _extraer(r'Firmante CONAF:\s*([^.]+)', obs)

    # Objetivo: preferir la versión del PDF sobre la planilla
    objetivo = _extraer(r'OBJETIVO\s*\(PDF dice\s*"([^"]+)"', obs)
    if not objetivo:
        # Si no hay cotejo de objetivo, buscar en "OBJETIVO (PDF dice...)"
        objetivo = _extraer(r'OBJETIVO\s*"([^"]+)"', obs)

    # ── 4. Eliminar el bloque CAMBIOS/COTEJO ────────────────────────────────
    # El bloque termina justo antes de "(Confianza lectura PDF:...)"
    texto_sin_cambios = re.sub(
        r'CAMBIOS/COTEJO:.*?\(Confianza lectura PDF:[^)]+\)\.\s*',
        '', obs, flags=re.DOTALL
    )
    # Fallback: si no hay marcador Confianza, eliminar hasta el último ")"
    # que cierra un "planilla mantiene" o "anterior"
    if 'CAMBIOS/COTEJO:' in texto_sin_cambios:
        texto_sin_cambios = re.sub(
            r'CAMBIOS/COTEJO:.*?(?=\nNota:|\nRepresentante|\nResolución|\nIncluye|\nFecha del|$)',
            '', texto_sin_cambios, flags=re.DOTALL
        )

    # ── 5. Eliminar marcadores técnicos ─────────────────────────────────────
    for pat in _OMITIR_PATRONES:
        texto_sin_cambios = re.sub(pat, '', texto_sin_cambios, flags=re.DOTALL)

    # Limpiar espacios múltiples y puntos dobles
    notas = re.sub(r'\s+', ' ', texto_sin_cambios).strip().strip('.')

    # ── 6. Ensamblar resultado ───────────────────────────────────────────────
    partes = []

    if objetivo:
        p = objetivo.rstrip('.')
        # Capitalizar primera letra si está en mayúsculas
        if p and p[0].islower():
            p = p[0].upper() + p[1:]
        partes.append(p + '.')

    if firmante:
        partes.append(f'Firmante por CONAF: {firmante}.')

    if notas:
        # Separar por oraciones y filtrar las vacías
        for oracion in re.split(r'(?<=[.!?])\s+', notas):
            oracion = oracion.strip()
            if oracion and oracion.lower() not in ('nan', ''):
                partes.append(oracion if oracion.endswith('.') else oracion + '.')

    if prefix:
        partes.append(prefix if prefix.endswith('.') else prefix + '.')

    return ' '.join(partes).strip()


class Command(BaseCommand):
    help = 'Convierte observaciones de cotejo PDF en texto natural legible'

    def add_arguments(self, parser):
        parser.add_argument('--dry-run', action='store_true',
                            help='Muestra cambios sin guardar')
        parser.add_argument('--id', type=int, default=None,
                            help='Procesar solo un convenio por ID (para pruebas)')

    def handle(self, *args, **options):
        from tramites.models import Convenio
        dry = options['dry_run']
        solo_id = options['id']

        qs = Convenio.objects.exclude(observaciones='')
        if solo_id:
            qs = qs.filter(id=solo_id)

        cambiados = sin_cambio = vaciados = 0

        for c in qs:
            original = c.observaciones or ''
            nuevo = _limpiar(original)

            if nuevo == original:
                sin_cambio += 1
                continue

            cambiados += 1
            if not nuevo:
                vaciados += 1

            if dry:
                self.stdout.write(f'\n=== [{c.id}] {c.nombre[:60]} ===')
                self.stdout.write(f'  ANTES: {original[:200]}')
                self.stdout.write(f'  NUEVO: {nuevo[:200]}')
            else:
                c.observaciones = nuevo
                c.save(update_fields=['observaciones'])

        self.stdout.write(self.style.SUCCESS(
            f'\nResumen: {cambiados} {"que cambiarían" if dry else "actualizados"} | '
            f'{sin_cambio} sin cambio | {vaciados} quedarían vacíos'
        ))
        if dry:
            self.stdout.write(self.style.WARNING('-- DRY RUN --'))
