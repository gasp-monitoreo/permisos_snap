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
