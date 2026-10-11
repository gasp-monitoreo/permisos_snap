from django.db import models


class ComplianceRecord(models.Model):
    tramite_id             = models.IntegerField(unique=True, db_index=True)
    proceso_id             = models.IntegerField(default=0)
    estado                 = models.CharField(max_length=50)
    nombre_solicitante     = models.CharField(max_length=255)
    email_solicitante      = models.CharField(max_length=255)
    titulo_investigacion   = models.TextField(blank=True)
    texto_clasificacion    = models.TextField(blank=True)
    colecta_muestras       = models.CharField(max_length=500, blank=True)
    fecha_termino_actividades = models.CharField(max_length=20)
    anios_transcurridos    = models.FloatField()
    fecha_modificacion     = models.CharField(max_length=50, blank=True)
    region                 = models.CharField(max_length=200, blank=True)
    regiones_list          = models.JSONField(default=list)

    class Meta:
        ordering = ['fecha_termino_actividades']

    def to_dict(self):
        return {
            'id':                       self.tramite_id,
            'estado':                   self.estado,
            'nombre_solicitante':       self.nombre_solicitante,
            'email_solicitante':        self.email_solicitante,
            'titulo_investigacion':     self.titulo_investigacion,
            'texto_clasificacion':      self.texto_clasificacion,
            'colecta_muestras':         self.colecta_muestras,
            'fecha_termino_actividades':self.fecha_termino_actividades,
            'anios_transcurridos':      self.anios_transcurridos,
            'fecha_modificacion':       self.fecha_modificacion,
            'region':                   self.region,
            'regiones_list':            self.regiones_list,
        }


class PortadaHistoricoRecord(models.Model):
    tramite_id           = models.IntegerField(unique=True, db_index=True)
    proceso_id           = models.IntegerField()
    estado               = models.CharField(max_length=50)
    nombre_solicitante   = models.CharField(max_length=255)
    email_solicitante    = models.CharField(max_length=255)
    titulo_investigacion = models.TextField(blank=True)
    texto_clasificacion  = models.TextField(blank=True)
    regiones_list        = models.JSONField(default=list)
    fecha_inicio         = models.CharField(max_length=50, blank=True)

    def to_dict(self):
        return {
            'id':                   self.tramite_id,
            'proceso_id':           self.proceso_id,
            'estado':               self.estado,
            'nombre_solicitante':   self.nombre_solicitante,
            'email_solicitante':    self.email_solicitante,
            'titulo_investigacion': self.titulo_investigacion,
            'texto_clasificacion':  self.texto_clasificacion,
            'regiones_list':        self.regiones_list,
            'fecha_inicio':         self.fecha_inicio,
        }


class CacheStatus(models.Model):
    name         = models.CharField(max_length=50, unique=True)
    fetched_at   = models.DateTimeField()
    record_count = models.IntegerField(default=0)


# ─── Perfiles de usuario ──────────────────────────────────────────────────────
SECCIONES = {
    'portada':      'Portada',
    'resumen_inv':  'Investigación · Resumen',
    'resumen_film': 'Filmación y Fotografía · Resumen',
    'busqueda':     'Búsqueda',
    'exportar':     'Exportar (Excel, cumplimiento y correos)',
}
TIPOS_PERFIL = [('inv', 'Investigación'), ('film', 'Filmación y fotografía'),
                ('ambos', 'Investigación y filmación'), ('nacional', 'Nacional')]


def secciones_por_defecto(tipo):
    base = ['portada', 'busqueda']
    if tipo in ('inv', 'ambos', 'nacional'):
        base.append('resumen_inv')
    if tipo in ('film', 'ambos', 'nacional'):
        base.append('resumen_film')
    return base


class PerfilUsuario(models.Model):
    """Perfil de acceso a la plataforma. El superusuario administra todos los perfiles.

    Permisos de acción:
      ver/consultar → siempre (si el usuario está activo)
      agregar       → subir archivos entregados, crear borradores y enviar correos
      editar        → actualizar datos desde CeroFilas y Drive
      borrar        → reservado para acciones de eliminación
    """
    user         = models.OneToOneField('auth.User', on_delete=models.CASCADE, related_name='perfil')
    tipo         = models.CharField(max_length=10, choices=TIPOS_PERFIL, default='nacional')
    region       = models.CharField(max_length=50, blank=True)      # nombre en REGIONES_CHILE; vacío = nacional
    solo_su_region = models.BooleanField(default=False)              # restringe datos a su región
    secciones    = models.JSONField(default=list)                     # claves de SECCIONES
    puede_agregar = models.BooleanField(default=False)
    puede_editar  = models.BooleanField(default=False)
    puede_borrar  = models.BooleanField(default=False)
    debe_cambiar_password = models.BooleanField(default=True)       # clave temporal pendiente
    ver_tutorial = models.BooleanField(default=True)                # aviso del manual al iniciar sesión
    creado_en    = models.DateTimeField(auto_now_add=True)
    actualizado_en = models.DateTimeField(auto_now=True)

    def secciones_visibles(self):
        if self.user.is_superuser:
            return list(SECCIONES)
        return [s for s in SECCIONES if s in (self.secciones or [])]

    def puede(self, accion):
        if self.user.is_superuser:
            return True
        return accion == 'ver' or bool(getattr(self, f'puede_{accion}', False))

    def region_forzada(self):
        """Región a la que se restringen los datos, o None si ve todo el país."""
        return self.region if (self.solo_su_region and self.region and not self.user.is_superuser) else None

    def como_dict(self):
        return {
            'tipo': self.tipo, 'region': self.region, 'solo_su_region': self.solo_su_region,
            'secciones': self.secciones_visibles(),
            'permisos': {a: self.puede(a) for a in ('ver', 'agregar', 'editar', 'borrar')},
            'superusuario': self.user.is_superuser,
            'ver_tutorial': self.ver_tutorial,
        }
