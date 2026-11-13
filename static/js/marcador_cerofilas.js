/* Marcador «Descargar trámites» — se ejecuta en una pestaña de conaf.cerofilas.gob.cl.
   La plataforma lo entrega por /api/cerofilas/marcador (solo superusuario) con el token
   ya incluido. Descarga los trámites con la API, de a poco y desde el navegador (que sí
   puede resolver el CAPTCHA del WAF), y guarda un archivo para subirlo a la plataforma. */
(async () => {
  const TOKEN = '__TOKEN__';
  const PLATAFORMA = '__PLATAFORMA__';
  const PAUSA_MS = 1500;
  if (location.hostname !== 'conaf.cerofilas.gob.cl') {
    alert('Abra https://conaf.cerofilas.gob.cl/backend/ (con su sesión iniciada) y presione el marcador en esa pestaña.');
    return;
  }
  if (document.getElementById('snap-descarga')) return;

  const resp = prompt(
    'Descargar trámites de CeroFilas para la plataforma de permisos.\n\n' +
    '• Escriba un número de días para traer solo los trámites modificados en esos días (uso diario).\n' +
    '• Escriba «todo 2024» para traer todos los trámites creados desde ese año (tarda varios minutos).',
    '7');
  if (resp === null) return;
  const texto = resp.trim().toLowerCase();
  let modo, desde;
  const m = texto.match(/^todo\s+(\d{4})$/);
  if (m) {
    modo = 'completo';
    desde = Math.floor(new Date(+m[1], 0, 1).getTime() / 1000);
  } else if (/^\d+$/.test(texto) && +texto > 0) {
    modo = 'cambios';
    desde = Math.floor(Date.now() / 1000) - (+texto) * 86400;
  } else {
    alert('No entendí «' + resp + '». Escriba un número de días (ej. 7) o «todo 2024».');
    return;
  }

  const caja = document.createElement('div');
  caja.id = 'snap-descarga';
  caja.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;width:min(440px,calc(100vw - 32px));' +
    'background:#fff;color:#1f2937;border:2px solid #2f6b3a;border-radius:10px;padding:14px 16px;' +
    'font:14px/1.45 Arial,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25)';
  caja.innerHTML = '<b style="color:#2f6b3a">Descarga para la plataforma de permisos</b>' +
    '<div id="snap-estado" style="margin-top:6px"></div><div id="snap-extra" style="margin-top:8px"></div>';
  document.body.appendChild(caja);
  const estado = (h) => { caja.querySelector('#snap-estado').innerHTML = h; };
  const extra = caja.querySelector('#snap-extra');
  const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

  const pedirVerificacion = () => new Promise((listo) => {
    extra.innerHTML =
      '<p style="margin:0 0 6px">CeroFilas pide la verificación «no soy un robot». Resuélvala aquí abajo ' +
      '(o <a href="/backend/procesos" target="_blank">en una pestaña nueva</a>) y luego presione Continuar.</p>' +
      '<iframe src="/backend/procesos" style="width:100%;height:320px;border:1px solid #ccc;border-radius:6px"></iframe>' +
      '<button id="snap-seguir" style="margin-top:8px;padding:6px 14px;background:#2f6b3a;color:#fff;border:0;border-radius:6px;cursor:pointer">Continuar</button>';
    extra.querySelector('#snap-seguir').onclick = () => { extra.innerHTML = ''; listo(); };
  });

  const items = [];
  let pagina = null, n = 0, fallos = 0;
  const filtro = (modo === 'cambios' ? 'updated_at_start=' : 'created_at_start=') + desde;
  try {
    for (;;) {
      const url = '/backend/api/tramites?maxResults=50&' + filtro + '&token=' + encodeURIComponent(TOKEN) +
        (pagina ? '&pageToken=' + encodeURIComponent(pagina) : '');
      estado('Descargando… página ' + (n + 1) + ' · ' + items.length + ' trámites');
      const r = await fetch(url, { credentials: 'same-origin' });
      if (r.status === 405 || r.headers.get('x-amzn-waf-action')) {
        estado('En pausa · ' + items.length + ' trámites descargados');
        await pedirVerificacion();
        continue;
      }
      if (r.status === 401 || r.status === 403) {
        throw new Error('CeroFilas rechazó el token de la API (HTTP ' + r.status + '). Pida un marcador nuevo en la plataforma.');
      }
      if (!r.ok) {
        if (++fallos > 3) throw new Error('CeroFilas respondió HTTP ' + r.status + ' varias veces.');
        await esperar(PAUSA_MS * 4);
        continue;
      }
      fallos = 0;
      const j = await r.json();
      const t = j.tramites || {};
      items.push(...(t.items || []));
      pagina = t.nextPageToken || null;
      n++;
      if (!pagina) break;
      await esperar(PAUSA_MS);
    }

    estado('Preparando el archivo… (' + items.length + ' trámites)');
    const json = JSON.stringify({ origen: 'cerofilas', modo, desde, generado: new Date().toISOString(), items });
    let blob = new Blob([json], { type: 'application/json' });
    let ext = '.json';
    if (window.CompressionStream) {
      blob = await new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).blob();
      ext = '.json.gz';
    }
    const hoy = new Date();
    const nombre = 'tramites_cerofilas_' + hoy.getFullYear() + '-' + String(hoy.getMonth() + 1).padStart(2, '0') + '-' +
      String(hoy.getDate()).padStart(2, '0') + '_' + modo + ext;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = nombre;
    document.body.appendChild(a);
    a.click();
    a.remove();
    estado('✅ Listo: ' + items.length + ' trámites guardados en <b>' + nombre + '</b> (carpeta Descargas).');
    extra.innerHTML = 'Ahora súbalo en la plataforma: <a href="' + PLATAFORMA + '" target="_blank">abrir la plataforma</a> → ' +
      'botón <b>⇪ CeroFilas</b> → «Cargar archivo».<br><button id="snap-cerrar" style="margin-top:8px">Cerrar</button>';
    extra.querySelector('#snap-cerrar').onclick = () => caja.remove();
  } catch (e) {
    estado('❌ ' + e.message);
    extra.innerHTML = '<button id="snap-cerrar">Cerrar</button>';
    extra.querySelector('#snap-cerrar').onclick = () => caja.remove();
  }
})();
