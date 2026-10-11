// Agrega el token CSRF a toda petición que modifica datos (POST/PUT/PATCH/DELETE)
// hacia este mismo sitio. La API lo exige para que otra página no pueda usar la sesión.
(function () {
  const leer = () => (document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/) || [])[1]
    || document.querySelector('[name=csrfmiddlewaretoken]')?.value || '';
  const fetchOriginal = window.fetch.bind(window);
  window.fetch = function (recurso, opciones = {}) {
    const metodo = (opciones.method || (recurso instanceof Request ? recurso.method : 'GET')).toUpperCase();
    const url = new URL(recurso instanceof Request ? recurso.url : String(recurso), location.href);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(metodo) && url.origin === location.origin) {
      const h = new Headers(opciones.headers || (recurso instanceof Request ? recurso.headers : undefined));
      if (!h.has('X-CSRFToken')) h.set('X-CSRFToken', leer());
      opciones = { ...opciones, headers: h, credentials: opciones.credentials || 'same-origin' };
    }
    return fetchOriginal(recurso, opciones);
  };
})();
