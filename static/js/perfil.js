/* Aplica el perfil del usuario (window.PERFIL, desde la plantilla) al cargar:
   sección inicial, tipo y región por defecto, y acciones que su perfil no permite. */
'use strict';
(() => {
  const P = window.PERFIL || {};
  const secs = P.secciones || [];

  // Tipo inicial del Resumen: si solo ve filmación, parte en filmación
  if (!secs.includes('resumen_inv') && secs.includes('resumen_film')) {
    STATE.tipo = 'film';
    STATE.dashFilter = 'film';
  }
  // Región: los encargados regionales parten en su región (fija si solo_su_region)
  // (un enlace con ?region=… manda, salvo que el perfil esté fijo en su región)
  if (P.region && !P.superusuario && (P.solo_su_region || !new URLSearchParams(location.search).get('region'))) STATE.region = P.region;

  document.addEventListener('DOMContentLoaded', () => {
    // Enviar correos requiere permiso de agregar
    if (!P.permisos?.agregar) {
      document.getElementById('btn-abrir-correos')?.closest('.export-form-card')?.remove();
    }
    // Sección inicial: la primera del menú (Portada si la tiene)
    const primera = document.querySelector('.sb-nav .tab-btn');
    if (primera) {
      primera.click();
    } else {
      document.querySelector('.app-main').innerHTML =
        '<div class="empty-msg" style="padding:60px">Su perfil aún no tiene secciones asignadas. Contacte al administrador de la plataforma.</div>';
    }
  });
})();
