// Aviso del tutorial al iniciar sesión. Si se marca «No quiero ver más este mensaje»,
// se guarda en el perfil (vale en cualquier computador o celular).
(function () {
  const aviso = document.getElementById('tuto-aviso');
  if (!aviso) return;
  const cerrar = () => {
    if (document.getElementById('tuto-no-mostrar').checked) {
      const token = (document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/) || [])[1] || '';
      fetch('/api/me/tutorial', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRFToken': token },
        body: JSON.stringify({ ocultar: true }),
      }).catch(() => {});
    }
    aviso.remove();
  };
  aviso.addEventListener('click', e => {
    if (e.target.closest('[data-tuto]') || e.target === aviso) cerrar();
  });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape' && document.body.contains(aviso)) { cerrar(); document.removeEventListener('keydown', esc); }
  });
})();
