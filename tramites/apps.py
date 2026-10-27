from django.apps import AppConfig


class TramitesConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'tramites'

    def ready(self):
        import sys
        import threading

        # Las cachés se inician solo en el servidor web. En comandos cortos (migrate,
        # collectstatic, shell…) la descarga en segundo plano deja al proceso esperando
        # a que termine y bloquea el arranque del contenedor.
        if 'gunicorn' not in sys.argv[0]:
            return

        def _init():
            try:
                from .fetcher import init_db_caches
                init_db_caches()
            except Exception as exc:
                print(f'[startup] Error inicializando caches: {exc}')
            try:
                from .tramites_cache import precalentar_anio_actual
                precalentar_anio_actual()
            except Exception as exc:
                print(f'[startup] Error precargando trámites: {exc}')
            try:
                from .drive_utils import get_cached_index
                get_cached_index()   # deja el índice Drive en memoria (o lo construye)
            except Exception as exc:
                print(f'[startup] Error precargando índice Drive: {exc}')

        threading.Thread(target=_init, daemon=True).start()
        try:
            from .fotos import programar
            programar()           # fotos de los informes entregados: búsqueda automática cada 6 h
        except Exception as exc:
            print(f'[startup] Error programando la búsqueda de fotos: {exc}')
