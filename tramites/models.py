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
    # Todos los perfiles ven ambos resúmenes; el tipo solo restringe qué pueden editar
    return ['portada', 'resumen_inv', 'resumen_film', 'busqueda']


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
    areas        = models.JSONField(default=list, blank=True)         # áreas protegidas a cargo (vacío = todas las de su ámbito)
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
            'areas': self.areas or [],
            'superusuario': self.user.is_superuser,
            've_sensible': self.user.is_superuser or self.puede('editar'),   # Ley N°21.719
            'ver_tutorial': self.ver_tutorial,
        }


# ─── Portal del investigador: registro geográfico de los permisos ─────────────
class AccesoInvestigador(models.Model):
    """Acceso temporal de un investigador o productora al portal de registro geográfico.

    Lo genera el superusuario para un trámite y lo envía al solicitante (enlace, usuario
    y clave). Solo permite ver y editar el registro geográfico de ese trámite: no entra
    a ninguna otra parte de la plataforma. Vence solo (fin del permiso + 90 días).
    """
    user        = models.OneToOneField('auth.User', on_delete=models.CASCADE, related_name='acceso_investigador')
    tramite_id  = models.IntegerField(unique=True, db_index=True)
    titulo      = models.TextField(blank=True)                 # copia para listar sin consultar CeroFilas
    solicitante = models.CharField(max_length=255, blank=True)
    tipo        = models.CharField(max_length=10, blank=True)  # 'inv' o 'film'
    areas       = models.JSONField(default=list)
    regiones    = models.JSONField(default=list)
    vence       = models.DateField()
    revocado    = models.BooleanField(default=False)
    creado_por  = models.ForeignKey('auth.User', on_delete=models.SET_NULL, null=True, related_name='+')
    creado_en   = models.DateTimeField(auto_now_add=True)
    ultimo_ingreso = models.DateTimeField(null=True, blank=True)

    def vigente(self):
        from datetime import date
        return not self.revocado and self.user.is_active and self.vence >= date.today()

    def como_dict(self):
        return {
            'id': self.id, 'tramite_id': self.tramite_id, 'usuario': self.user.username,
            'titulo': self.titulo, 'solicitante': self.solicitante, 'tipo': self.tipo,
            'areas': self.areas, 'regiones': self.regiones, 'vence': self.vence.isoformat(),
            'vigente': self.vigente(), 'revocado': self.revocado,
            'creado_en': self.creado_en.isoformat() if self.creado_en else None,
            'ultimo_ingreso': self.ultimo_ingreso.isoformat() if self.ultimo_ingreso else None,
        }


CATEGORIAS_REGISTRO = {
    'muestreo':  'Punto de muestreo',
    'camara':    'Cámara trampa',
    'estacion':  'Estación de monitoreo',
    'parcela':   'Parcela',
    'transecto': 'Transecto',
    'captura':   'Sitio de captura o colecta',
    'filmacion': 'Locación de filmación o fotografía',
    'otro':      'Otro',
}


class RegistroGeografico(models.Model):
    """Punto, línea (transecto) o polígono (parcela) declarado para un permiso.
    La geometría se guarda como GeoJSON en WGS84 (longitud, latitud)."""
    TIPOS = [('punto', 'Punto'), ('linea', 'Transecto o línea'), ('poligono', 'Parcela o polígono')]
    tramite_id  = models.IntegerField(db_index=True)
    tipo        = models.CharField(max_length=10, choices=TIPOS)
    geometria   = models.JSONField()
    nombre      = models.CharField(max_length=200)
    categoria   = models.CharField(max_length=20, blank=True)
    metodo      = models.TextField(blank=True)
    descripcion = models.TextField(blank=True)
    fecha_inicio = models.DateField(null=True, blank=True)
    fecha_fin    = models.DateField(null=True, blank=True)
    atributos   = models.JSONField(default=dict, blank=True)
    origen      = models.CharField(max_length=200, blank=True)    # 'mapa', 'coordenadas' o nombre del archivo
    creado_por  = models.ForeignKey('auth.User', on_delete=models.SET_NULL, null=True, related_name='+')
    creado_en   = models.DateTimeField(auto_now_add=True)
    modificado_en = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['creado_en']

    def como_feature(self):
        return {
            'type': 'Feature', 'id': self.id, 'geometry': self.geometria,
            'properties': {
                'id': self.id, 'tramite_id': self.tramite_id, 'tipo': self.tipo, 'nombre': self.nombre,
                'categoria': self.categoria, 'categoria_nombre': CATEGORIAS_REGISTRO.get(self.categoria, ''),
                'metodo': self.metodo, 'descripcion': self.descripcion,
                'fecha_inicio': self.fecha_inicio.isoformat() if self.fecha_inicio else None,
                'fecha_fin': self.fecha_fin.isoformat() if self.fecha_fin else None,
                'atributos': self.atributos, 'origen': self.origen,
                'modificado_en': self.modificado_en.isoformat() if self.modificado_en else None,
            },
        }


# ─── Ajuste manual del estado de un permiso ───────────────────────────────────
SITUACIONES_AJUSTE = {
    'desistido':         'Desistido por el solicitante',
    'sin_respuesta':     'Cerrado por falta de respuesta del solicitante',
    'aprobado_externo':  'Aprobado (registrado fuera de Cero Filas)',
    'rechazado_externo': 'Rechazado (registrado fuera de Cero Filas)',
    'anulado':           'Anulado (duplicado o error de ingreso)',
    'revertido':         'Sin ajuste: vuelve al estado de Cero Filas',
}


class AjusteEstado(models.Model):
    """Corrección del estado de un permiso que Cero Filas no refleja (p. ej. el solicitante
    desistió y nadie lo registró). Siempre con justificación y autor; el historial no se borra:
    el ajuste vigente es el último (y «revertido» lo anula)."""
    tramite_id     = models.IntegerField(db_index=True)
    situacion      = models.CharField(max_length=20, choices=list(SITUACIONES_AJUSTE.items()))
    fecha_efectiva = models.DateField()
    motivo         = models.TextField()
    autor          = models.ForeignKey('auth.User', on_delete=models.SET_NULL, null=True, related_name='+')
    autor_nombre   = models.CharField(max_length=255, blank=True)   # se conserva aunque se borre la cuenta
    creado_en      = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-creado_en', '-id']


class AdjuntoAjuste(models.Model):
    """Respaldo de un ajuste (correo, carta, captura). Se guarda en la base de datos para que
    quede incluido en los respaldos diarios."""
    ajuste  = models.ForeignKey(AjusteEstado, on_delete=models.CASCADE, related_name='adjuntos')
    nombre  = models.CharField(max_length=200)
    tipo    = models.CharField(max_length=100)
    tamano  = models.IntegerField()
    datos   = models.BinaryField()


class DriveFolderMap(models.Model):
    """Mapeo manual: nombre de carpeta en Drive → tramite_id(s) para carpetas flat sin subcarpetas.
    Permite asociar archivos entregados con sus permisos de investigación correspondientes."""
    folder_name = models.CharField(max_length=255, unique=True, db_index=True,
                                   help_text='Nombre exacto de la carpeta en Drive (ej: Ocampo_Karina)')
    tramite_ids = models.JSONField(default=list,
                                   help_text='Lista de IDs de trámite CeroFilas (ej: [31144311])')
    notas       = models.TextField(blank=True,
                                   help_text='Email del investigador, título del proyecto, etc.')

    class Meta:
        ordering            = ['folder_name']
        verbose_name        = 'Mapeo carpeta Drive'
        verbose_name_plural = 'Mapeos carpetas Drive'

    def __str__(self):
        return f'{self.folder_name} → {self.tramite_ids}'


# ─── Entrega de resultados del investigador (Numeral 6 del Reglamento) ────────
TIPOS_ENTREGA = [
    ('informe',     'Informe técnico o de avance'),
    ('publicacion', 'Publicación científica'),
    ('datos',       'Base de datos o datos brutos'),
    ('material',    'Material educativo o divulgativo'),
    ('otro',        'Otro material entregado'),
]

MAX_N6_MB = 80
N6_EXTENSIONS = {'.pdf', '.doc', '.docx', '.csv', '.xls', '.xlsx', '.pptx', '.odt',
                 '.zip', '.jpg', '.jpeg', '.png', '.txt', '.mp4', '.avi', '.mov'}


class EntregaN6(models.Model):
    """Archivo entregado por el titular (o subido por CONAF) para el Numeral 6.
    Se guarda en disco bajo INVESTIGACIONES_DIR/_n6/<tramite_id>/ o se vincula desde Drive."""
    tramite_id  = models.IntegerField(db_index=True)
    nombre      = models.CharField(max_length=255)
    tipo        = models.CharField(max_length=20, choices=TIPOS_ENTREGA, default='informe')
    descripcion = models.TextField(blank=True)
    archivo     = models.CharField(max_length=500)   # basename en disco (vacío si es Drive)
    tamano      = models.IntegerField(default=0)     # bytes
    drive_id    = models.CharField(max_length=200, blank=True, default='')  # Google Drive file ID
    drive_url   = models.CharField(max_length=500, blank=True, default='')  # URL de descarga en Drive
    subido_por  = models.ForeignKey('auth.User', on_delete=models.SET_NULL, null=True, related_name='+')
    subido_en   = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-subido_en']

    def como_dict(self):
        es_inv = False
        if self.subido_por_id:
            try:
                es_inv = bool(self.subido_por.acceso_investigador)
            except Exception:
                pass
        return {
            'id': self.id, 'tramite_id': self.tramite_id,
            'nombre': self.nombre, 'tipo': self.tipo,
            'tipo_nombre': dict(TIPOS_ENTREGA).get(self.tipo, self.tipo),
            'descripcion': self.descripcion, 'archivo': self.archivo,
            'tamano': self.tamano, 'drive_id': self.drive_id, 'drive_url': self.drive_url,
            'es_investigador': es_inv,
            'subido_por': (self.subido_por.get_full_name() or self.subido_por.username) if self.subido_por else '',
            'subido_en': self.subido_en.isoformat() if self.subido_en else None,
        }


# ─── Historial de auditoría (superusuario) ────────────────────────────────────
ACCIONES_AUDITORIA = [
    ('ajuste_creado',        'Ajuste de estado registrado'),
    ('acceso_creado',        'Acceso temporal generado'),
    ('acceso_revocado',      'Acceso temporal revocado'),
    ('archivo_subido',       'Archivo entregado subido'),
    ('usuario_creado',       'Usuario creado'),
    ('usuario_editado',      'Perfil de usuario editado'),
    ('password_restablecida','Contraseña restablecida'),
    ('registro_creado',      'Registro geográfico creado'),
    ('registro_editado',     'Registro geográfico editado'),
    ('registro_borrado',     'Registro geográfico eliminado'),
]

ACCIONES_REVERSIBLES = {
    'ajuste_creado',
    'acceso_creado',
    'archivo_subido',
    'usuario_editado',
    'registro_creado',
    'registro_editado',
}


class AuditLog(models.Model):
    """Registro inmutable de acciones relevantes realizadas por usuarios.
    Solo el superusuario puede verlo. Permite revertir acciones específicas."""
    usuario_id     = models.IntegerField(null=True, db_index=True)
    usuario_nombre = models.CharField(max_length=255, blank=True)
    accion         = models.CharField(max_length=30, choices=ACCIONES_AUDITORIA, db_index=True)
    objeto_tipo    = models.CharField(max_length=20, blank=True)   # tramite, acceso, ajuste, usuario, registro, archivo
    objeto_id      = models.CharField(max_length=40, blank=True)   # ID del objeto afectado
    descripcion    = models.TextField()
    datos          = models.JSONField(default=dict, blank=True)     # datos para revertir
    ip             = models.GenericIPAddressField(null=True, blank=True)
    creado_en      = models.DateTimeField(auto_now_add=True, db_index=True)
    revertido      = models.BooleanField(default=False)
    revertido_por  = models.IntegerField(null=True)
    revertido_en   = models.DateTimeField(null=True)
    revertido_nota = models.TextField(blank=True)

    class Meta:
        ordering = ['-creado_en', '-id']

    @property
    def es_reversible(self):
        return not self.revertido and self.accion in ACCIONES_REVERSIBLES

    def como_dict(self):
        return {
            'id': self.id,
            'usuario_nombre': self.usuario_nombre,
            'accion': self.accion,
            'accion_nombre': dict(ACCIONES_AUDITORIA).get(self.accion, self.accion),
            'objeto_tipo': self.objeto_tipo,
            'objeto_id': self.objeto_id,
            'descripcion': self.descripcion,
            'ip': self.ip,
            'creado_en': self.creado_en.isoformat() if self.creado_en else None,
            'revertido': self.revertido,
            'revertido_nota': self.revertido_nota,
            'es_reversible': self.es_reversible,
        }
