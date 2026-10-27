from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tramites', '0006_drivefoldermap'),
    ]

    operations = [
        migrations.CreateModel(
            name='AuditLog',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('usuario_id', models.IntegerField(db_index=True, null=True)),
                ('usuario_nombre', models.CharField(blank=True, max_length=255)),
                ('accion', models.CharField(
                    choices=[
                        ('ajuste_creado', 'Ajuste de estado registrado'),
                        ('acceso_creado', 'Acceso temporal generado'),
                        ('acceso_revocado', 'Acceso temporal revocado'),
                        ('archivo_subido', 'Archivo entregado subido'),
                        ('usuario_creado', 'Usuario creado'),
                        ('usuario_editado', 'Perfil de usuario editado'),
                        ('password_restablecida', 'Contraseña restablecida'),
                        ('registro_creado', 'Registro geográfico creado'),
                        ('registro_editado', 'Registro geográfico editado'),
                        ('registro_borrado', 'Registro geográfico eliminado'),
                    ],
                    db_index=True,
                    max_length=30,
                )),
                ('objeto_tipo', models.CharField(blank=True, max_length=20)),
                ('objeto_id', models.CharField(blank=True, max_length=40)),
                ('descripcion', models.TextField()),
                ('datos', models.JSONField(blank=True, default=dict)),
                ('ip', models.GenericIPAddressField(blank=True, null=True)),
                ('creado_en', models.DateTimeField(auto_now_add=True, db_index=True)),
                ('revertido', models.BooleanField(default=False)),
                ('revertido_por', models.IntegerField(null=True)),
                ('revertido_en', models.DateTimeField(null=True)),
                ('revertido_nota', models.TextField(blank=True)),
            ],
            options={
                'ordering': ['-creado_en', '-id'],
            },
        ),
    ]
