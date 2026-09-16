"""Create the initial superuser from env vars if not already present."""
import os

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = 'Create initial superuser from INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD env vars'

    def handle(self, *args, **options):
        email = os.environ.get('INITIAL_ADMIN_EMAIL', '').strip()
        password = os.environ.get('INITIAL_ADMIN_PASSWORD', '').strip()
        if not email or not password:
            return

        User = get_user_model()
        if User.objects.filter(username=email).exists():
            return

        User.objects.create_superuser(username=email, email=email, password=password)
        self.stdout.write(f'[ensure_admin] Superusuario creado: {email}')
