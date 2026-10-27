from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tramites', '0005_ajuste_estado'),
    ]

    operations = [
        migrations.CreateModel(
            name='DriveFolderMap',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('folder_name', models.CharField(db_index=True, help_text='Nombre exacto de la carpeta en Drive (ej: Ocampo_Karina)', max_length=255, unique=True)),
                ('tramite_ids', models.JSONField(default=list, help_text='Lista de IDs de trámite CeroFilas (ej: [31144311])')),
                ('notas', models.TextField(blank=True, help_text='Email del investigador, título del proyecto, etc.')),
            ],
            options={
                'verbose_name': 'Mapeo carpeta Drive',
                'verbose_name_plural': 'Mapeos carpetas Drive',
                'ordering': ['folder_name'],
            },
        ),
    ]
