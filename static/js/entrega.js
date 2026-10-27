/* ═══════════════════════════════════════════════
   Entrega de resultados (Numeral 6) en el detalle del trámite (vista interna CONAF).
   Muestra los archivos entregados y, al superusuario / usuarios con agregar,
   permite subir nuevos o generar/gestionar el acceso del investigador al portal N6.
   API: /api/tramites/{id}/n6/… y /api/accesos/… (tramites/api.py + portal.py)
   ═══════════════════════════════════════════════ */
'use strict';
window.EntregaN6 = (() => {
  const TIPOS = {
    informe:     'Informe técnico o de avance',
    publicacion: 'Publicación científica',
    datos:       'Base de datos o datos brutos',
    material:    'Material educativo o divulgativo',
    otro:        'Otro material entregado',
  };
  const fmt = bytes => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const fecha = iso => iso ? new Date(iso.length === 10 ? iso + 'T12:00:00' : iso).toLocaleDateString('es-CL') : '–';
  async function pedir(url, opciones = {}) {
    const r = await fetch(url, opciones);
    const d = (r.headers.get('Content-Type') || '').includes('json') ? await r.json() : null;
    if (!r.ok || !d || d.ok === false) throw new Error(d?.error || `Error ${r.status}`);
    return d;
  }

  function listaHtml(archivos, puedeSubir) {
    if (!archivos.length) return '<p class="rg-resumen">Aún no hay archivos entregados.</p>';
    return `<ul class="n6-lista">${archivos.map(a => `<li class="n6-item">
      <span class="n6-icono">📄</span>
      <span class="n6-info">
        <strong>${escHtml(a.nombre)}</strong>
        <small>${escHtml(a.tipo_nombre)} · ${fmt(a.tamano)} · subido ${a.es_investigador ? 'por el titular' : 'por CONAF'} el ${fecha(a.subido_en)}</small>
        ${a.descripcion ? `<em>${escHtml(a.descripcion)}</em>` : ''}
      </span>
      <span class="n6-acciones">
        <a class="btn-secondary" href="/investigaciones/_n6/${a.tramite_id}/${encodeURIComponent(a.archivo)}" download="${escHtml(a.archivo)}">Descargar</a>
        ${puedeSubir ? `<button class="btn-secondary n6-del" data-id="${a.id}">Eliminar</button>` : ''}
      </span>
    </li>`).join('')}</ul>`;
  }

  function accesoN6Html(acc) {
    if (!window.PERFIL?.superusuario) return '';
    const estado = !acc ? '<span class="rg-estado">Sin acceso generado</span>'
      : acc.vigente ? `<span class="rg-estado ok">Acceso vigente hasta ${fecha(acc.vence)}</span>`
      : `<span class="rg-estado no">${acc.revocado ? 'Acceso revocado' : `Acceso vencido el ${fecha(acc.vence)}`}</span>`;
    const ultimo = acc?.ultimo_ingreso ? ` · último ingreso ${fecha(acc.ultimo_ingreso)}` : acc ? ' · aún no ha ingresado' : '';
    return `<div class="rg-acceso">
      <div>${estado}<small>${acc ? `Usuario ${escHtml(acc.usuario)}${ultimo}` : 'El titular podrá subir sus informes, publicaciones y datos desde el portal del investigador.'}</small></div>
      <div class="rg-acceso-btns">
        <button class="btn-primary" data-n6="generar">${acc ? 'Renovar acceso y nueva clave' : 'Generar acceso para el titular'}</button>
        ${acc?.vigente ? '<button class="btn-secondary" data-n6="revocar">Revocar</button>' : ''}
      </div>
      <div class="n6-credenciales" id="n6-credenciales" hidden></div>
    </div>`;
  }

  function credencialesN6Html(r, t) {
    const fecha2 = r.acceso.vence ? fecha(r.acceso.vence) : '–';
    const msg = `Estimado/a ${t.nombre_solicitante || ''}:

Para el permiso N.° ${t.id}, CONAF le solicita entregar sus resultados (Numeral 6 del Reglamento) en el portal del investigador:

Enlace: ${r.enlace}
Usuario: ${r.acceso.usuario}
Clave: ${r.clave}

En el portal encontrará la pestaña «Entrega N.° 6» donde puede subir sus informes técnicos, publicaciones científicas, bases de datos u otro material comprometido (hasta 80 MB por archivo). El acceso está vigente hasta el ${fecha2}.

Saludos cordiales,
CONAF`;
    return `<p class="rg-aviso">Copie estos datos ahora: la clave no se vuelve a mostrar. Si se pierde, use «Renovar acceso».</p>
      <dl class="rg-dl"><dt>Enlace</dt><dd>${escHtml(r.enlace)}</dd><dt>Usuario</dt><dd><code>${escHtml(r.acceso.usuario)}</code></dd>
      <dt>Clave</dt><dd><code>${escHtml(r.clave)}</code></dd></dl>
      <textarea class="rg-msg" readonly rows="11">${escHtml(msg)}</textarea>
      <button class="btn-secondary" data-n6="copiar">Copiar mensaje para enviar al titular</button>`;
  }

  // contenedor: donde va el bloque · alContar(n): avisa cuántos archivos hay
  async function montar(t, contenedor = null, alContar = null) {
    const body = contenedor || document.getElementById('modal-tramite-body');
    if (!body) return;
    if (contenedor) contenedor.innerHTML = '';
    body.insertAdjacentHTML('beforeend', `<div class="detail-section rg-seccion" id="n6-seccion" style="margin-top:18px">
      <div class="detail-section-title">📋 Entrega de resultados (Numeral 6)</div>
      <div id="n6-cuerpo"><div class="empty-msg">Cargando…</div></div></div>`);
    const cuerpo = document.getElementById('n6-cuerpo');
    let d, accD;
    try {
      [d, accD] = await Promise.all([
        pedir(`/api/tramites/${t.id}/n6`),
        window.PERFIL?.superusuario ? pedir(`/api/tramites/${t.id}/registro-geografico`) : Promise.resolve(null),
      ]);
    } catch (e) {
      if (cuerpo) cuerpo.innerHTML = `<div class="empty-msg">${escHtml(e.message)}</div>`;
      return;
    }
    if (!document.body.contains(cuerpo)) return;
    const acc = accD?.acceso || null;
    const puedeSubir = !!window.PERFIL?.permisos?.agregar;
    if (alContar) alContar(d.archivos.length);
    cuerpo.innerHTML = `
      ${listaHtml(d.archivos, puedeSubir)}
      ${puedeSubir ? `<details class="n6-upload" id="n6-upload-det">
        <summary class="fx-btn" style="cursor:pointer">Subir archivo como CONAF</summary>
        <form class="n6-form" id="n6-form-conaf" enctype="multipart/form-data">
          <label>Nombre descriptivo<input name="nombre" required placeholder="Ej: Informe final 2024" maxlength="255"></label>
          <label>Tipo<select name="tipo">${Object.entries(TIPOS).map(([k, v]) => `<option value="${k}">${escHtml(v)}</option>`).join('')}</select></label>
          <label>Descripción (opcional)<textarea name="descripcion" rows="2" maxlength="2000" placeholder="Autores, año, DOI…"></textarea></label>
          <label>Archivo (hasta 80 MB)<input type="file" name="archivo" required accept=".pdf,.doc,.docx,.csv,.xls,.xlsx,.pptx,.odt,.zip,.jpg,.jpeg,.png,.txt,.mp4,.avi,.mov"></label>
          <p class="pt-error" id="n6-err-conaf" hidden></p>
          <button class="btn-primary" type="submit">Subir</button>
        </form>
      </details>` : ''}
      ${accesoN6Html(acc)}`;

    // upload form CONAF
    document.getElementById('n6-form-conaf')?.addEventListener('submit', async e => {
      e.preventDefault();
      const form = e.target, err = document.getElementById('n6-err-conaf'), btn = form.querySelector('[type=submit]');
      err.hidden = true; btn.disabled = true; btn.textContent = 'Subiendo…';
      try {
        const fd = new FormData(form);
        const r = await pedir(`/api/tramites/${t.id}/n6/subir`, { method: 'POST', body: fd });
        d.archivos.unshift(r.archivo);
        if (alContar) alContar(d.archivos.length);
        cuerpo.querySelector('.n6-lista, .rg-resumen').outerHTML = listaHtml(d.archivos, puedeSubir);
        form.reset();
        document.getElementById('n6-upload-det').open = false;
        _bindN6Acciones(cuerpo, t, d, acc, puedeSubir, alContar);
      } catch (ex) {
        err.textContent = ex.message; err.hidden = false;
        btn.disabled = false; btn.textContent = 'Subir';
      }
    });

    _bindN6Acciones(cuerpo, t, d, acc, puedeSubir, alContar);
  }

  function _bindN6Acciones(cuerpo, t, d, acc, puedeSubir, alContar) {
    cuerpo.querySelectorAll('.n6-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('¿Eliminar este archivo?')) return;
        btn.disabled = true;
        try {
          await pedir(`/api/tramites/${t.id}/n6/${btn.dataset.id}`, { method: 'DELETE' });
          d.archivos = d.archivos.filter(a => String(a.id) !== btn.dataset.id);
          if (alContar) alContar(d.archivos.length);
          cuerpo.querySelector('.n6-lista, .rg-resumen').outerHTML = listaHtml(d.archivos, puedeSubir);
          _bindN6Acciones(cuerpo, t, d, acc, puedeSubir, alContar);
        } catch (ex) { alert(ex.message); btn.disabled = false; }
      });
    });

    cuerpo.querySelectorAll('[data-n6]').forEach(b => {
      b.addEventListener('click', async () => {
        if (b.dataset.n6 === 'copiar') {
          const ta = cuerpo.querySelector('.rg-msg');
          try { await navigator.clipboard.writeText(ta.value); b.textContent = 'Copiado ✓'; }
          catch { ta.select(); b.textContent = 'Seleccionado: copie con Ctrl+C'; }
          return;
        }
        if (b.dataset.n6 === 'revocar' && !confirm('¿Revocar el acceso? El titular ya no podrá ingresar al portal.')) return;
        if (b.dataset.n6 === 'generar' && acc && !confirm('Se generará una clave nueva; la anterior dejará de funcionar. ¿Continuar?')) return;
        b.setAttribute('aria-busy', 'true'); b.disabled = true;
        try {
          if (b.dataset.n6 === 'generar') {
            const r = await pedir('/api/accesos', { method: 'POST', body: JSON.stringify({ tramite_id: t.id }) });
            acc = r.acceso;
            cuerpo.querySelector('.rg-acceso').outerHTML = accesoN6Html(acc);
            const cred = document.getElementById('n6-credenciales');
            cred.innerHTML = credencialesN6Html(r, t);
            cred.hidden = false;
          } else {
            const r = await pedir(`/api/accesos/${acc.id}/revocar`, { method: 'POST', body: '{}' });
            acc = r.acceso;
            cuerpo.querySelector('.rg-acceso').outerHTML = accesoN6Html(acc);
          }
          _bindN6Acciones(cuerpo, t, d, acc, puedeSubir, alContar);
        } catch (err) {
          alert(err.message);
          b.disabled = false; b.removeAttribute('aria-busy');
        }
      });
    });
  }

  return { montar };
})();
