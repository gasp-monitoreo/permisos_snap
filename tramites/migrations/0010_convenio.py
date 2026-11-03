import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ('tramites', '0009_entregan6_drive'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='Convenio',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('region', models.CharField(blank=True, max_length=200)),
                ('rut', models.CharField(blank=True, max_length=30)),
                ('razon_social', models.CharField(blank=True, max_length=500)),
                ('tipo_convenio', models.CharField(choices=[('colaboracion', 'Convenio de Colaboración'), ('uso_terreno', 'Convenio de Uso de Terreno'), ('investigacion', 'Convenio de Investigación'), ('educacion', 'Convenio de Educación y Extensión'), ('prestacion', 'Convenio de Prestación de Servicios'), ('donacion', 'Donación / Transferencia de Bienes'), ('otro', 'Otro')], default='otro', max_length=20)),
                ('nombre', models.TextField()),
                ('objetivo', models.TextField(blank=True)),
                ('fecha_firma', models.DateField(blank=True, null=True)),
                ('anio', models.IntegerField(blank=True, null=True)),
                ('duracion', models.CharField(blank=True, max_length=200)),
                ('termino', models.CharField(blank=True, max_length=200)),
                ('renovacion_automatica', models.CharField(blank=True, max_length=100)),
                ('fecha_adendas', models.TextField(blank=True)),
                ('tipo_organizacion', models.CharField(choices=[('empresa', 'Empresa'), ('universidad', 'Universidad'), ('municipalidad', 'Municipalidad'), ('junta_vecinos', 'Junta de Vecinos'), ('comunidad', 'Comunidad o Asociación'), ('corporacion', 'Corporación'), ('ong', 'ONG'), ('fundacion', 'Fundación'), ('servicio_publico', 'Servicio Público'), ('otro', 'Otro')], default='otro', max_length=20)),
                ('estado', models.CharField(choices=[('vigente', 'Vigente'), ('vencido', 'Vencido'), ('por_vencer', 'Por vencer'), ('terminado', 'Terminado'), ('otro', 'Otro')], default='vigente', max_length=20)),
                ('transf_bienes', models.TextField(blank=True)),
                ('transf_presup', models.TextField(blank=True)),
                ('beneficios_ingreso', models.TextField(blank=True)),
                ('responsable_conaf', models.CharField(blank=True, max_length=255)),
                ('observaciones', models.TextField(blank=True)),
                ('nombre_archivo', models.CharField(blank=True, max_length=500)),
                ('drive_id', models.CharField(blank=True, max_length=200)),
                ('drive_url', models.CharField(blank=True, max_length=500)),
                ('nombre_archivo2', models.CharField(blank=True, max_length=500)),
                ('drive_id2', models.CharField(blank=True, max_length=200)),
                ('drive_url2', models.CharField(blank=True, max_length=500)),
                ('creado_en', models.DateTimeField(auto_now_add=True)),
                ('actualizado_en', models.DateTimeField(auto_now=True)),
                ('subido_por', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'ordering': ['-anio', 'razon_social'],
            },
        ),
    ]
