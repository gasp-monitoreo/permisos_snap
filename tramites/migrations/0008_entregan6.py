from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('tramites', '0007_auditlog'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='EntregaN6',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('tramite_id', models.IntegerField(db_index=True)),
                ('nombre', models.CharField(max_length=255)),
                ('tipo', models.CharField(
                    choices=[
                        ('informe', 'Informe técnico o de avance'),
                        ('publicacion', 'Publicación científica'),
                        ('datos', 'Base de datos o datos brutos'),
                        ('material', 'Material educativo o divulgativo'),
                        ('otro', 'Otro material entregado'),
                    ],
                    default='informe',
                    max_length=20,
                )),
                ('descripcion', models.TextField(blank=True)),
                ('archivo', models.CharField(max_length=500)),
                ('tamano', models.IntegerField(default=0)),
                ('subido_por', models.ForeignKey(
                    null=True,
                    on_delete=django.db.models.deletion.SET_NULL,
                    related_name='+',
                    to=settings.AUTH_USER_MODEL,
                )),
                ('subido_en', models.DateTimeField(auto_now_add=True)),
            ],
            options={
                'ordering': ['-subido_en'],
            },
        ),
    ]
