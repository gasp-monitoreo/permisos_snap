from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ('tramites', '0008_entregan6'),
    ]

    operations = [
        migrations.AddField(
            model_name='entregan6',
            name='drive_id',
            field=models.CharField(blank=True, default='', max_length=200),
        ),
        migrations.AddField(
            model_name='entregan6',
            name='drive_url',
            field=models.CharField(blank=True, default='', max_length=500),
        ),
    ]
