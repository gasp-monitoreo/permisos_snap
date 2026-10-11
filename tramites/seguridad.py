"""Política de seguridad de contenido (CSP).

Todo el código (JS, CSS, fuentes) se aloja en la propia plataforma: el navegador
rechaza scripts, estilos o fuentes de cualquier otro dominio (CDN incluidos), lo que
cierra la puerta a ataques de cadena de suministro vía CDN públicos (p. ej. JSDelivr).
Única excepción: imágenes de teselas del mapa base (Esri), que no son código.
"""
CSP = '; '.join([
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",        # inline: manejadores onclick heredados de app.js
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data: blob: https://server.arcgisonline.com",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
])


class CSPMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        resp = self.get_response(request)
        resp.headers.setdefault('Content-Security-Policy', CSP)
        resp.headers.setdefault('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
        return resp
