from django.apps import AppConfig


class TramitesConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'tramites'

    def ready(self):
        import threading

        def _init():
            try:
                from .fetcher import init_db_caches
                init_db_caches()
            except Exception as exc:
                print(f'[startup] Error inicializando caches: {exc}')

        threading.Thread(target=_init, daemon=True).start()
