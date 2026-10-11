# Dependencias de terceros alojadas localmente

Ningún recurso de código se carga desde CDN públicos (requerimiento Cyber SOC SBAP).
La política CSP (`tramites/seguridad.py`) impide además cargar scripts de otros dominios.

| Componente | Versión | Origen verificado | Licencia |
|---|---|---|---|
| Leaflet (`leaflet-1.9.4/`) | 1.9.4 | Paquete oficial npm `leaflet@1.9.4` (integridad sha512 del registro) y contrastado con los hashes SRI publicados por cdnjs | BSD-2-Clause |
| DM Sans, DM Serif Display, Poppins 800 (`../fonts/`) | Google Fonts, oct. 2026 | fonts.gstatic.com (subconjuntos latin y latin-ext) | SIL OFL 1.1 |

## Hashes SHA-384 (para auditoría)

```
sha384-cxOPjt7s7Iz04uaHJceBmS+qpjv2JkIHNVcuOrM+YHwZOmJGBXI00mdUXEq65HTH  leaflet-1.9.4/leaflet.js
sha384-sHL9NAb7lN7rfvG5lfHpm643Xkcjzp4jFvuavGOndn6pjVqS6ny56CAt3nsEVT4H  leaflet-1.9.4/leaflet.css
```

Para actualizar una dependencia: descargar desde el paquete oficial, verificar su
integridad, reemplazar la carpeta, actualizar esta tabla y probar antes de desplegar.
