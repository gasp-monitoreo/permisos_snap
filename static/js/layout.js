/* Layout: menú lateral contraíble, título de la barra superior y fotos de portada. */
(() => {
  const root = document.documentElement;
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const mobile = () => window.matchMedia('(max-width: 900px)').matches;

  // ── Menú lateral ──────────────────────────────────────────────
  function toggleSidebar() {
    if (mobile()) { root.classList.toggle('sb-open'); return; }
    const collapsed = root.classList.toggle('sb-collapsed');
    try { localStorage.setItem('sidebar-collapsed', collapsed ? '1' : '0'); } catch (e) {}
    // Chart.js recalcula tamaños al terminar la transición
    setTimeout(() => window.dispatchEvent(new Event('resize')), 260);
  }
  $('sb-toggle').addEventListener('click', toggleSidebar);
  $('topbar-menu').addEventListener('click', toggleSidebar);
  $('sb-backdrop').addEventListener('click', () => root.classList.remove('sb-open'));

  // Textos que dependen del tipo: data-tipo-text="texto investigación|texto filmación"
  function aplicarTipo(tipo) {
    document.querySelectorAll('[data-tipo-text]').forEach(el => {
      const [inv, film] = el.dataset.tipoText.split('|');
      el.textContent = tipo === 'film' ? film : inv;
    });
    document.querySelectorAll('.hero[data-hero="1"]').forEach(h => {
      const f = fotoPara(Number(h.dataset.hero) + (tipo === 'film' ? 6 : 0));
      if (f) setHero(h, f);
    });
  }

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.title = btn.dataset.title;
    btn.addEventListener('click', () => {
      $('topbar-title').textContent = btn.dataset.title;
      if (btn.dataset.tipo && btn.dataset.tipo !== tipoActual) {
        tipoActual = btn.dataset.tipo;
        aplicarTipo(tipoActual);
      }
      root.classList.remove('sb-open');
      window.scrollTo({ top: 0 });
    });
  });

  // ── Fotos ─────────────────────────────────────────────────────
  let fotos = [];
  let orden = [];
  let rotacion = null;
  let tipoActual = 'inv';

  const fotoPara = i => orden.length ? orden[i % orden.length] : null;

  const credito = f => `Foto: ${esc(f.investigador)}`;
  const driveUrl = f => `https://drive.google.com/file/d/${encodeURIComponent(f.drive_id)}/view`;

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function setHero(hero, f) {
    let layer = document.createElement('div');
    layer.className = 'hero-img';
    layer.style.backgroundImage = `url("${f.url}")`;
    hero.prepend(layer);
    const img = new Image();
    img.onload = () => {
      requestAnimationFrame(() => layer.classList.add('visible'));
      // deja solo la capa nueva y la anterior (para el fundido)
      hero.querySelectorAll('.hero-img').forEach((l, i) => { if (i > 1) l.remove(); });
    };
    img.src = f.url;
    hero.classList.add('has-photo');
    hero.querySelector('.hero-credit').innerHTML =
      `<a href="${driveUrl(f)}" target="_blank" rel="noopener" title="${esc(f.documento)}">${credito(f)}</a>`;
  }

  function pintarHeroes() {
    if (!fotos.length) return;
    orden = shuffle([...fotos]);
    document.querySelectorAll('.hero[data-hero]').forEach(h => {
      const extra = tipoActual === 'film' && h.dataset.hero === '1' ? 6 : 0;
      setHero(h, fotoPara(Number(h.dataset.hero) + extra));
    });
    // la portada rota entre todas las fotos
    const portada = document.querySelector('.hero[data-hero="0"]');
    clearInterval(rotacion);
    if (portada && orden.length > 1) {
      let i = 0;
      rotacion = setInterval(() => {
        if (document.hidden || !portada.offsetParent) return;
        i = (i + 1) % orden.length;
        const capas = portada.querySelectorAll('.hero-img');
        capas.forEach(c => c.classList.add('leaving'));
        setHero(portada, orden[i]);
      }, 8000);
    }
  }

  function pintarGaleria() {
    const el = $('galeria-fotos');
    const invs = new Set(fotos.map(f => f.investigador));
    $('hero-chips-portada').innerHTML = fotos.length
      ? `<span class="hero-chip">${fotos.length} fotografías</span><span class="hero-chip">${invs.size} investigaciones</span>`
      : '';
    if (!fotos.length) {
      el.innerHTML = $('btn-galeria-gestionar')
        ? '<div class="empty-msg">Aún no hay fotos. Usa «Gestionar fotos» → «Buscar fotos nuevas en Drive».</div>'
        : '<div class="empty-msg">Aún no hay fotos disponibles.</div>';
      return;
    }
    el.innerHTML = fotos.slice(0, 12).map(f => `
      <a class="galeria-item" href="${driveUrl(f)}" target="_blank" rel="noopener" title="${esc(f.documento)}">
        <img src="${f.url}" alt="" loading="lazy">
        <span class="galeria-cap"><strong>${esc(f.investigador)}</strong>${esc(f.documento)}</span>
      </a>`).join('');
  }

  async function cargarFotos() {
    try {
      const r = await fetch('/api/fotos');
      fotos = (await r.json()).data || [];
    } catch (e) { fotos = []; }
    pintarHeroes();
    pintarGaleria();
  }

  // ── Gestión de fotos ──────────────────────────────────────────
  async function cargarAdmin() {
    const r = await fetch('/api/fotos?todas=true');
    const j = await r.json();
    const lista = j.data || [];
    $('fotos-admin').innerHTML = lista.length ? lista.map(f => `
      <div class="galeria-item ${f.activa === false ? 'oculta' : ''}">
        <img src="${f.url}" alt="" loading="lazy">
        <span class="galeria-cap"><strong>${esc(f.investigador)}</strong>${esc(f.documento)}</span>
        <button class="foto-toggle" data-archivo="${esc(f.archivo)}" data-activa="${f.activa !== false}">
          ${f.activa === false ? 'Mostrar' : 'Ocultar'}
        </button>
      </div>`).join('') : '<div class="empty-msg">Sin fotos extraídas todavía.</div>';
    pintarJob(j.job);
    return j.job;
  }

  function pintarJob(job) {
    const btn = $('btn-fotos-extraer');
    btn.disabled = !!(job && job.corriendo);
    $('fotos-job').textContent = job && job.corriendo
      ? 'Descargando documentos y extrayendo fotos… puede tardar varios minutos.'
      : (job && job.ultimo ? `Última búsqueda: ${job.ultimo}` : '');
  }

  async function esperarJob() {
    const job = await cargarAdmin();
    if (job && job.corriendo) setTimeout(esperarJob, 5000);
    else cargarFotos();
  }

  // Gestión de fotos: el botón y el modal solo existen para superusuarios
  const puedeGestionar = !!$('btn-galeria-gestionar');
  if (puedeGestionar) {
    $('btn-galeria-gestionar').addEventListener('click', () => {
      $('modal-fotos').style.display = 'flex';
      cargarAdmin();
    });
    $('modal-fotos-close').addEventListener('click', () => { $('modal-fotos').style.display = 'none'; });

    $('btn-fotos-extraer').addEventListener('click', async () => {
      const r = await fetch('/api/fotos/extraer', { method: 'POST' });
      const j = await r.json();
      if (!j.ok) {
        $('fotos-job').innerHTML = `No se pudo acceder a Drive (${esc(j.error)}). <a href="/auth/gmail/start" target="_blank">Autorizar Google</a>`;
        return;
      }
      pintarJob({ corriendo: true });
      setTimeout(esperarJob, 4000);
    });

    $('fotos-admin').addEventListener('click', async e => {
      const b = e.target.closest('.foto-toggle');
      if (!b) return;
      const activa = b.dataset.activa !== 'true';
      await fetch(`/api/fotos/${encodeURIComponent(b.dataset.archivo)}/activa?activa=${activa}`, { method: 'POST' });
      const item = b.closest('.galeria-item');
      item.classList.toggle('oculta', !activa);
      b.dataset.activa = String(activa);
      b.textContent = activa ? 'Ocultar' : 'Mostrar';
      cargarFotos();
    });
  }

  cargarFotos();
})();
