from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tramites', '0010_convenio'),
    ]

    operations = [
        migrations.AlterField(
            model_name='convenio',
            name='rut',
            field=models.CharField(blank=True, max_length=200),
        ),
    ]
