/* =========================================================================
 * Integrador Visual — aplicación principal
 * ========================================================================= */
'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const DEG = Math.PI / 180;
  const WORK_MAX = 2200;      // lado mayor de la imagen de trabajo (vista)
  const ORIG_MAX = 9000;      // límite de la foto original
  const ITEM_MAX = 2048;      // límite de la foto de equipo

  /* ------------------------------ Estado ------------------------------ */
  const S = {
    bg: null,             // {name, w, h}
    orig: null, origCtx: null,
    work: null, workScale: 1, workData: null,
    comp: null,
    ref: { pts: null, W: 600, H: 400 },
    calib: { method: 'cota', cotas: [], knownAspect: '', f: null, fSrc: '', aspect: null, scale: null, spread: null },
    exifF: null,          // focal en px leída del EXIF (si existe)
    ruler: null,          // {a, b} en px de la imagen
    H: null, Hinv: null,  // plano (mm) -> imagen original (px) y su inversa
    zone: { useRef: true, pts: null, depth: null },
    cam: { auto: true, f: 0.85 },
    light: { az: -120, el: 50, op: 55, soft: 55 },
    items: [], sel: -1, nextId: 1,
    occl: null, occlTint: null, occlHas: false, occR: 30,
    view: { zoom: 1, x: 0, y: 0 },
    mode: 'move', marking: null, // {kind:'ref'|'zone', pts:[]}
    helpers: true, compare: false, split: 0.5,
    drag: null, spaceDown: false,
    checks: [],
  };

  const view = $('view');
  const vctx = view.getContext('2d');

  /* ------------------------------ Utilidades ------------------------------ */
  let toastT = 0;
  function toast(msg, ms = 3200) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.add('hidden'), ms);
  }
  const fmt = (v, d = 0) => Number(v).toLocaleString('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d });
  const num = (el, def = 0) => { const v = parseFloat(el.value); return isFinite(v) ? v : def; };
  // Dentro de claude.ai las descargas directas están bloqueadas: se usa la capacidad
  // "downloads" (el visor pide confirmación). Fuera de claude.ai, enlace normal.
  let dlCap;
  const getDownloads = () => {
    if (dlCap === undefined) dlCap = window.claude && window.claude.use ? window.claude.use('downloads').catch(() => null) : Promise.resolve(null);
    return dlCap;
  };
  getDownloads();
  async function download(blob, name) {
    const cap = await getDownloads();
    if (cap) {
      try { await cap.save({ filename: name, data: blob }); }
      catch (err) { if (err && err.code !== 'declined') throw new Error(err.message || err.code || 'no se pudo guardar'); }
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  const safeName = s => (s || 'integracion').replace(/[^\w\-áéíóúñÁÉÍÓÚÑ ]+/g, '').trim().replace(/\s+/g, '_') || 'integracion';
  const canvasBlob = (c, type, q) => new Promise(r => c.toBlob(r, type, q));

  /* ------------------------------ Foto base ------------------------------ */
  /** Focal equivalente en 35 mm del EXIF -> focal en píxeles (por diagonal). */
  async function exifFocal(file, w, h) {
    try {
      const buf = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
      if (buf.getUint16(0) !== 0xFFD8) return null;
      let o = 2;
      while (o + 4 < buf.byteLength) {
        const marker = buf.getUint16(o), len = buf.getUint16(o + 2);
        if (marker === 0xFFE1 && buf.getUint32(o + 4) === 0x45786966) {
          const t = o + 10, le = buf.getUint16(t) === 0x4949;
          const u16 = p => buf.getUint16(t + p, le), u32 = p => buf.getUint32(t + p, le);
          const readIFD = (p, want) => {
            const n = u16(p);
            for (let i = 0; i < n; i++) { const e = p + 2 + i * 12; if (u16(e) === want) return { type: u16(e + 2), val: e + 8 }; }
            return null;
          };
          const exifPtr = readIFD(u32(4), 0x8769);
          if (!exifPtr) return null;
          const f35 = readIFD(u32(exifPtr.val), 0xA405);
          if (!f35) return null;
          const mm = u16(f35.val);
          if (!(mm > 8 && mm < 400)) return null;
          // la diagonal del formato 35 mm (43,27 mm) equivale a la diagonal de la foto
          return mm * Math.hypot(w, h) / 43.27;
        }
        if ((marker & 0xFF00) !== 0xFF00) break;
        o += 2 + len;
      }
    } catch (e) { /* sin EXIF */ }
    return null;
  }

  async function loadBackground(file, keepScene = false) {
    const img = await Img.loadImage(file);
    S.orig = Img.imageToCanvas(img, ORIG_MAX);
    S.origCtx = S.orig.getContext('2d', { willReadFrequently: true });
    S.bg = { name: file.name || 'foto', w: S.orig.width, h: S.orig.height };
    S.exifF = await exifFocal(file, S.bg.w, S.bg.h);
    if (!keepScene) { S.calib.cotas = []; S.ruler = null; }
    S.work = Img.imageToCanvas(S.orig, WORK_MAX);
    S.workScale = S.work.width / S.orig.width;
    S.workData = S.work.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, S.work.width, S.work.height);
    S.comp = Img.makeCanvas(S.work.width, S.work.height);
    S.occl = Img.makeCanvas(S.work.width, S.work.height);
    S.occlHas = false;
    if (!keepScene) {
      S.ref.pts = null; S.zone.pts = null; S.H = null; S.Hinv = null;
    }
    $('bgInfo').textContent = `${S.bg.name} · ${S.bg.w} × ${S.bg.h} px`;
    $('empty').classList.add('hidden');
    fitView();
    computeH();
    S.items.forEach(markAdjust);
    updateUI();
    requestRender(true);
    if (!keepScene) {
      setHint('Ahora marca la <b>superficie de referencia</b> (paso 3): 4 esquinas de un rectángulo real cuyas medidas conozcas.');
    }
  }

  /* ------------------------------ Vista ------------------------------ */
  function resizeView() {
    const r = view.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    view.width = Math.max(1, Math.round(r.width * dpr));
    view.height = Math.max(1, Math.round(r.height * dpr));
    requestRender(false);
  }
  function fitView() {
    if (!S.bg) return;
    const r = view.getBoundingClientRect();
    const z = Math.min(r.width / S.bg.w, r.height / S.bg.h) * 0.94;
    S.view.zoom = z;
    S.view.x = (r.width - S.bg.w * z) / 2;
    S.view.y = (r.height - S.bg.h * z) / 2;
    requestRender(false);
  }
  const toScreen = p => [S.view.x + p[0] * S.view.zoom, S.view.y + p[1] * S.view.zoom];
  const toImage = p => [(p[0] - S.view.x) / S.view.zoom, (p[1] - S.view.y) / S.view.zoom];
  function zoomAt(f, sx, sy) {
    const z = Math.min(40, Math.max(0.02, S.view.zoom * f));
    const k = z / S.view.zoom;
    S.view.x = sx - (sx - S.view.x) * k;
    S.view.y = sy - (sy - S.view.y) * k;
    S.view.zoom = z;
    requestRender(false);
  }
  function eventPos(e) {
    const r = view.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  /* ------------------------------ Calibración ------------------------------ */
  /**
   * Modo "cota": el rectángulo marcado no tiene medidas conocidas.
   * Cada cota (2 puntos + mm) se pasa a coordenadas del cuadrado unidad del
   * rectángulo (du, dv). Su longitud real cumple  L² = W²·du² + H²·dv².
   *  - Proporción conocida (4:3, 16:9…): una sola cota da la escala.
   *  - Dos o más cotas en direcciones distintas: W y H por mínimos cuadrados,
   *    exacto sin suponer nada de la cámara.
   *  - Si no: proporción deducida de la perspectiva (focal por puntos de fuga,
   *    EXIF o valor típico) y escala media de las cotas.
   */
  function computeCotaCalib() {
    const C = S.calib, q = S.ref.pts, D = Math.max(S.bg.w, S.bg.h);
    let f = null, src = '';
    if (!S.cam.auto) { f = S.cam.f * D; src = 'manual'; }
    else {
      f = Geo.focalFromQuad(q, S.bg.w, S.bg.h); src = 'perspectiva';
      if (!f && S.exifF) { f = S.exifF; src = 'exif'; }
      if (!f) { f = 0.85 * D; src = 'defecto'; }
    }
    C.f = f; C.fSrc = src;
    const Hu = Geo.homography([[0, 0], [1, 0], [1, 1], [0, 1]], q), Hui = Hu && Geo.inv(Hu);
    if (!Hui) { C.scale = null; return false; }
    C.cotas.forEach(c => {
      const A = Geo.apply(Hui, c.a[0], c.a[1]), B = Geo.apply(Hui, c.b[0], c.b[1]);
      c.du = B[0] - A[0]; c.dv = B[1] - A[1];
    });
    const valid = C.cotas.filter(c => c.mm > 0 && Math.hypot(c.du, c.dv) > 1e-6);
    const r = Geo.rectifyQuad(q, S.bg.w, S.bg.h, f);
    C.persAspect = r ? r.aspect : null;
    let W = null, H = null;
    const known = parseFloat(C.knownAspect) || null;
    if (known) {
      const sc = valid.map(c => c.mm / Math.hypot(known * c.du, c.dv));
      if (sc.length) { H = sc.reduce((x, y) => x + y, 0) / sc.length; W = known * H; C.aspectSrc = 'formato'; }
    } else if (valid.length >= 2) {
      let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
      valid.forEach(c => {
        const u2 = c.du * c.du, v2 = c.dv * c.dv, L2 = c.mm * c.mm;
        a11 += u2 * u2; a12 += u2 * v2; a22 += v2 * v2; b1 += L2 * u2; b2 += L2 * v2;
      });
      const det = a11 * a22 - a12 * a12;
      if (det > 0.02 * a11 * a22) {
        const X = (b1 * a22 - b2 * a12) / det, Y = (a11 * b2 - a12 * b1) / det;
        if (X > 0 && Y > 0) { W = Math.sqrt(X); H = Math.sqrt(Y); C.aspectSrc = 'cotas'; }
      }
    }
    if (W == null && C.persAspect && valid.length) {
      const a = C.persAspect;
      const sc = valid.map(c => c.mm / Math.hypot(a * c.du, c.dv));
      H = sc.reduce((x, y) => x + y, 0) / sc.length; W = a * H; C.aspectSrc = 'perspectiva';
    }
    C.aspect = W && H ? W / H : C.persAspect;
    if (W == null) { C.scale = null; return false; }
    // Coherencia: cuánto se desvía cada cota de lo que predice el modelo
    C.cotas.forEach(c => {
      const pred = Math.hypot(W * c.du, H * c.dv);
      c.dev = c.mm > 0 ? pred / c.mm - 1 : null;
    });
    const devs = valid.map(c => Math.abs(c.dev));
    const dof = valid.length - (C.aspectSrc === 'cotas' ? 2 : 1);
    C.spread = dof > 0 ? Math.max(...devs) * 2 : null;
    C.scale = H;
    S.ref.W = W; S.ref.H = H;
    return true;
  }

  function computeH() {
    S.H = S.Hinv = null;
    if (!S.ref.pts || !S.bg) { renderCalibInfo(); return; }
    if (S.calib.method === 'cota' && !computeCotaCalib()) { renderCalibInfo(); return; }
    const { W, H } = S.ref;
    const h = Geo.homography([[0, 0], [W, 0], [W, H], [0, H]], S.ref.pts);
    if (h) { S.H = h; S.Hinv = Geo.inv(h); }
    renderCalibInfo();
  }
  function getCam() {
    if (!S.H) return null;
    const D = Math.max(S.bg.w, S.bg.h);
    if (S.calib.method === 'cota' && (S.calib.aspectSrc === 'perspectiva' || !S.cam.auto)) return Geo.camera(S.H, S.bg.w, S.bg.h, S.calib.f);
    return Geo.camera(S.H, S.bg.w, S.bg.h, S.cam.auto ? null : S.cam.f * D, S.exifF);
  }

  /** Medidas aproximadas (mm) de un cuadrilátero de la imagen sobre el plano. */
  function quadSizeMm(pts) {
    if (!S.Hinv) return null;
    const p = pts.map(imgToPlane), d = Geo.dist2;
    return [(d(p[0], p[1]) + d(p[3], p[2])) / 2, (d(p[0], p[3]) + d(p[1], p[2])) / 2];
  }
  const segMm = (a, b) => S.Hinv ? Geo.dist2(imgToPlane(a), imgToPlane(b)) : null;

  function renderCalibInfo() {
    const box = $('calInfo');
    if (!box) return;
    const C = S.calib, lines = [];
    if (C.method === 'cota') {
      if (!S.ref.pts) lines.push('<span class="muted">Paso 1: marca el rectángulo.</span>');
      else {
        const fov = C.f ? 2 * Math.atan(S.bg.w / 2 / C.f) / DEG : 0;
        const srcTxt = { perspectiva: 'deducida de la perspectiva', exif: 'de los datos EXIF de la foto', defecto: 'valor típico (perspectiva poco marcada)', manual: 'manual' }[C.fSrc] || '';
        lines.push(`Focal: ${srcTxt} · ≈${fov.toFixed(0)}° de campo horizontal`);
        const aSrc = { formato: 'formato indicado', cotas: 'calculada con las cotas (exacta)', perspectiva: 'deducida de la perspectiva' }[C.aspectSrc] || 'deducida de la perspectiva';
        if (C.aspect) lines.push(`Proporción del rectángulo: <b>${C.aspect.toFixed(3)} : 1</b> · ${C.scale ? aSrc : 'estimación'}`);
        if ((!C.scale || C.aspectSrc === 'perspectiva') && C.fSrc === 'defecto')
          lines.push('<span class="warn">⚠ El rectángulo se ve casi de frente: su proporción no se puede deducir bien. Indica su formato (p. ej. 4:3) o traza dos cotas en direcciones distintas (ancho y alto).</span>');
        if (!C.scale) lines.push('<span class="muted">Paso 2: traza una cota conocida para fijar los milímetros.</span>');
        else {
          lines.push(`Rectángulo marcado ≈ <b>${fmt(S.ref.W)} × ${fmt(S.ref.H)} mm</b>`);
          if (C.spread != null) {
            const p = C.spread * 100;
            lines.push(`<span class="${p > 6 ? 'warn' : 'ok'}">${p > 6 ? '⚠' : '✓'} Coherencia entre cotas: ${fmt(p, 1)} % de diferencia</span>`);
          } else if (C.aspectSrc === 'cotas') lines.push('<span class="muted">Con 2 cotas el ajuste es exacto; una 3.ª cota permitiría comprobar la precisión.</span>');
          else lines.push('<span class="muted">Consejo: añade otra cota (mejor en otra dirección) para comprobar la precisión.</span>');
        }
      }
    }
    box.innerHTML = lines.join('<br>');
    renderCotaList();
    const zi = $('zoneInfo');
    if (zi) {
      const ownZone = (S.calib.method === 'cota' || !S.zone.useRef) && S.zone.pts;
      const zs = ownZone ? quadSizeMm(S.zone.pts) : (S.H && S.calib.method !== 'cota' ? [S.ref.W, S.ref.H] : null);
      zi.innerHTML = zs ? `Zona disponible ≈ <b>${fmt(zs[0])} × ${fmt(zs[1])} mm</b>` : '';
    }
  }

  function renderCotaList() {
    const ul = $('cotaList');
    if (!ul) return;
    ul.innerHTML = '';
    S.calib.cotas.forEach((c, i) => {
      const li = document.createElement('li');
      const dev = c.dev != null && S.calib.cotas.length > 1 ? ` <span class="${Math.abs(c.dev) > 0.04 ? 'warn' : 'muted'}">${c.dev > 0 ? '+' : ''}${fmt(c.dev * 100, 1)} %</span>` : '';
      li.innerHTML = `<span class="cnum">${i + 1}</span><span class="nm">${escapeHtml(c.label)}</span>
        <input type="number" min="0" step="0.1" value="${c.mm}" aria-label="mm de la cota ${i + 1}"><span class="small muted">mm</span>${dev}
        <button class="ghost tiny-btn" title="Quitar cota">✕</button>`;
      li.querySelector('input').addEventListener('change', e => { c.mm = Math.max(0, parseFloat(e.target.value) || 0); calibChanged(); });
      li.querySelector('button').addEventListener('click', () => { S.calib.cotas.splice(i, 1); calibChanged(); });
      ul.appendChild(li);
    });
  }

  function calibChanged() {
    computeH();
    if (S.H) S.items.forEach(it => { if (!it.placed) placeItem(it); });
    S.items.forEach(markAdjust);
    updateCamLabel();
    requestRender(true);
  }
  const imgToPlane = p => Geo.apply(S.Hinv, p[0], p[1]);

  function zonePoly() {
    if (S.calib.method === 'cota') return S.zone.pts ? S.zone.pts.map(imgToPlane) : null;
    if (S.zone.useRef || !S.zone.pts) return [[0, 0], [S.ref.W, 0], [S.ref.W, S.ref.H], [0, S.ref.H]];
    return S.zone.pts.map(imgToPlane);
  }

  /* ------------------------------ Equipos ------------------------------ */
  function defaultAdj() {
    return { match: 60, light: 60, exposure: 0, contrast: 0, saturation: 0, temperature: 0, blur: 0.6, grain: 0, grainAuto: true, gloss: 0, feather: 1 };
  }

  function newItem(srcCanvas, name) {
    const ctx = srcCanvas.getContext('2d', { willReadFrequently: true });
    const id = ctx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
    const it = {
      id: S.nextId++, name: name || `Equipo ${S.nextId - 1}`,
      src: { w: id.width, h: id.height, data: id.data },
      srcCanvas,
      mask: new Uint8Array(id.width * id.height).fill(255),
      quad: [[0, 0], [id.width, 0], [id.width, id.height], [0, id.height]],
      w: 300, h: 200, d: 80, mount: 'flush', protrude: 4, gap: 1.5,
      cx: 0, cy: 0, rot: 0, snap: 0,
      housing: '#3a3d42', housingAuto: true,
      adj: defaultAdj(),
      photoStats: Img.rgbaStats(id.data, false),
      tex: null, texKey: '', mips: null, adjDirty: true,
      lightF: [1, 1, 1, 1], noise: 0, edge: [60, 60, 60], thumb: '',
    };
    return it;
  }

  function itemTexKey(it) {
    return [it.quad.flat().map(v => v.toFixed(1)).join(','), (it.w / it.h).toFixed(5), it.adj.feather, it.maskVer || 0].join('|');
  }

  /** Endereza los laterales marcados en la foto del equipo (si los hay). */
  function ensureSideTex(it) {
    ['sideLR', 'sideTB'].forEach(k => {
      const sd = it[k];
      if (!sd || !sd.quad) return;
      const realH = k === 'sideLR' ? it.h : it.w;
      const key = [sd.quad.flat().map(v => v.toFixed(1)).join(','), it.d, realH, it.maskVer || 0, it.adj.feather].join('|');
      if (sd.key === key) return;
      sd.key = key;
      sd.tex = it.d > 0 ? Img.rectify(it.src, it.mask, sd.quad, it.d, realH, it.adj.feather, 1024) : null;
      sd.mips = null;
    });
  }

  function ensureTex(it) {
    const k = itemTexKey(it);
    if (it.tex && it.texKey === k) return;
    it.tex = Img.rectify(it.src, it.mask, it.quad, it.w, it.h, it.adj.feather, ITEM_MAX);
    it.texKey = k;
    it.adjDirty = true;
  }

  function itemGeom(it, cam) {
    const c = Math.cos(it.rot * DEG), s = Math.sin(it.rot * DEG);
    const L2P = (u, v) => { const dx = u - it.w / 2, dy = v - it.h / 2; return [it.cx + c * dx - s * dy, it.cy + s * dx + c * dy]; };
    const rotN = n => [c * n[0] - s * n[1], s * n[0] + c * n[1]];
    const loc = [[0, 0], [it.w, 0], [it.w, it.h], [0, it.h]];
    const base = loc.map(p => L2P(p[0], p[1]));
    const P = it.protrude;
    // Inclinación (eje horizontal) y orientación (eje vertical) respecto a la
    // superficie. Gira sobre la arista que queda apoyada, sin atravesar el panel.
    const tx = P > 0 ? (it.tiltX || 0) * DEG : 0, ty = P > 0 ? (it.tiltY || 0) * DEG : 0;
    const L3 = (u, v, z) => {
      if (tx) {
        const v0 = tx >= 0 ? it.h : 0, dv = v - v0;
        const dv2 = dv * Math.cos(tx) + z * Math.sin(tx), z2 = -dv * Math.sin(tx) + z * Math.cos(tx);
        v = v0 + dv2; z = z2;
      }
      if (ty) {
        const u0 = ty >= 0 ? 0 : it.w, du = u - u0;
        const du2 = du * Math.cos(ty) - z * Math.sin(ty), z2 = du * Math.sin(ty) + z * Math.cos(ty);
        u = u0 + du2; z = z2;
      }
      const q = L2P(u, v);
      return [q[0], q[1], z];
    };
    const back3 = loc.map(p => L3(p[0], p[1], 0));
    const front3 = loc.map(p => L3(p[0], p[1], P));
    const baseImg = back3.map(p => cam.project(p[0], p[1], p[2]));
    const frontImg = front3.map(p => cam.project(p[0], p[1], p[2]));
    const expand = g => [[-g, -g], [it.w + g, -g], [it.w + g, it.h + g], [-g, it.h + g]].map(p => L2P(p[0], p[1]));
    const normals = [[0, -1], [1, 0], [0, 1], [-1, 0]].map(rotN);
    return { L2P, base, baseImg, frontImg, back3, front3, expand, normals, P, tilted: !!(tx || ty) };
  }

  /** Recalcula el ajuste fotométrico de un equipo según su posición en la escena. */
  function adjustItem(it) {
    if (!S.H || !S.workData) return;
    ensureTex(it);
    const cam = getCam();
    const g = itemGeom(it, cam);
    const ws = S.workScale;
    // Región del entorno: rectángulo ampliado alrededor del equipo
    const m = Math.max(it.w, it.h) * 0.6;
    const ring = g.expand(m).map(p => cam.project(p[0], p[1], 0));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    ring.forEach(([x, y]) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); });
    const scene = Img.regionStats(S.workData, x0 * ws, y0 * ws, x1 * ws, y1 * ws) || it.photoStats;
    // Luz local en las 4 esquinas (parches justo fuera del equipo)
    const off = Math.min(it.w, it.h) * 0.12 + 6;
    const loc = [[-off, -off], [it.w + off, -off], [it.w + off, it.h + off], [-off, it.h + off]];
    const projW = Geo.dist2(g.frontImg[0], g.frontImg[1]);
    const projH = Geo.dist2(g.frontImg[1], g.frontImg[2]);
    const r = Math.max(3, Math.min(projW, projH) * 0.07 * ws);
    const Ls = loc.map(([u, v]) => { const p = g.L2P(u, v); const q = cam.project(p[0], p[1], 0); return Img.patchLum(S.workData, q[0] * ws, q[1] * ws, r); });
    const valid = Ls.filter(v => v != null && v > 2);
    const mean = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : 1;
    const k = it.adj.light / 100;
    it.lightF = Ls.map(v => (v == null || v <= 2 ? 1 : Img.clamp(Math.pow(v / mean, k * 0.8), 0.55, 1.6)));
    // Grano
    const cImg = cam.project(it.cx, it.cy, 0);
    it.noise = Img.estimateNoise(S.origCtx, cImg[0] + projW * 0.8, cImg[1], 140);
    // Desenfoque en píxeles de textura
    const sigma = it.adj.blur * it.tex.w / Math.max(8, projW);
    const adj = Img.adjustTexture(it.tex, it.adj, scene, it.photoStats, sigma);
    it.mips = Img.buildMips(adj);
    it.edge = Img.edgeColor(adj);
    // Laterales marcados en la foto: mismo ajuste de color que la cara frontal
    ensureSideTex(it);
    ['sideLR', 'sideTB'].forEach(k => {
      const sd = it[k];
      if (sd && sd.tex) sd.mips = Img.buildMips(Img.adjustTexture(sd.tex, it.adj, scene, it.photoStats, 0));
      else if (sd) sd.mips = null;
    });
    it.adjDirty = false;
  }

  let adjTimer = 0;
  function markAdjust(it) {
    it.adjDirty = true;
    clearTimeout(adjTimer);
    adjTimer = setTimeout(() => {
      S.items.forEach(x => { if (x.adjDirty) adjustItem(x); });
      requestRender(true);
    }, 140);
  }

  /* ------------------------------ Comprobaciones ------------------------------ */
  const SIDES = ['superior', 'derecha', 'inferior', 'izquierda'];
  function computeChecks() {
    const out = [];
    if (!S.bg) return out;
    if (!S.H) {
      const cota = S.calib.method === 'cota';
      out.push({ status: 'warn', title: 'Sin calibrar', lines: [cota && S.ref.pts
        ? 'Falta una cota conocida (paso 3.2) para saber los milímetros.'
        : cota ? 'Marca un rectángulo cualquiera de la superficie y una cota conocida (paso 3).'
          : 'Marca la superficie de referencia (paso 3) para conocer la escala y la perspectiva.'] });
      return out;
    }
    if (!Geo.isConvexQuad(S.ref.pts)) out.push({ status: 'bad', title: 'Referencia no válida', lines: ['Las 4 esquinas de la referencia se cruzan. Revisa el orden.'] });
    const cam = getCam();
    const zone = zonePoly();
    const geoms = S.items.map(it => itemGeom(it, cam));
    if (S.calib.method === 'cota') {
      const C = S.calib, l = [];
      if (C.fSrc === 'defecto' && C.aspectSrc === 'perspectiva') l.push('⚠ Perspectiva poco marcada: la proporción del rectángulo de referencia es aproximada. Indica su formato o traza una cota en otra dirección.');
      if (C.spread != null && C.spread > 0.06) l.push(`⚠ Las cotas difieren un ${fmt(C.spread * 100, 1)} %: revisa sus valores o que estén en la misma superficie.`);
      if (C.cotas.length === 1) l.push('Escala basada en una sola cota: una segunda cota permite comprobar la precisión.');
      if (l.length) out.push({ status: l.some(x => x.startsWith('⚠')) ? 'warn' : 'ok', title: 'Calibración', lines: l });
    }
    S.items.forEach((it, i) => {
      const g = geoms[i];
      const res = { status: 'ok', title: it.name, lines: [], id: it.id };
      if (!zone) {
        res.status = 'warn';
        res.lines.push(`Medidas reales: ${fmt(it.w)} × ${fmt(it.h)} mm. Marca la zona disponible (paso 3) para comprobar si cabe.`);
        out.push(res);
        return;
      }
      const margins = g.normals.map((n, e) => {
        // Muestrea el borde: los puntos dentro de la zona dan la holgura hacia ese lado;
        // los que están fuera y "miran" a la zona dan cuánto sobresale.
        const a = g.base[e], b = g.base[(e + 1) % 4];
        let best = Infinity, any = false;
        for (let k = 0; k <= 20; k++) {
          const p = [a[0] + (b[0] - a[0]) * k / 20, a[1] + (b[1] - a[1]) * k / 20];
          if (Geo.pointInPoly(p, zone)) {
            const t = Geo.rayPolyT(p, n, zone);
            if (isFinite(t)) { best = Math.min(best, t); any = true; }
          } else {
            const t = Geo.rayPolyT(p, [-n[0], -n[1]], zone);
            if (isFinite(t)) { best = Math.min(best, -t); any = true; }
          }
        }
        return any ? best : -Infinity;
      });
      const over = margins.map((m, e) => [m, e]).filter(([m]) => m < -0.5);
      if (over.length) {
        res.status = 'bad';
        res.lines.push('⛔ No cabe en la zona disponible: ' + over.map(([m, e]) => isFinite(m) ? `sobresale ${fmt(-m)} mm por ${SIDES[e] === 'derecha' || SIDES[e] === 'izquierda' ? 'la ' + SIDES[e] : 'el borde ' + SIDES[e]}` : `queda fuera por ${SIDES[e]}`).join(', ') + '.');
        const zw = it.w + margins[1] + margins[3], zh = it.h + margins[0] + margins[2];
        if (isFinite(zw) && isFinite(zh) && (zw < it.w || zh < it.h)) {
          const msgs = [];
          if (zw < it.w - 0.5) msgs.push(`el equipo mide ${fmt(it.w)} mm de ancho y el hueco ≈ ${fmt(zw)} mm`);
          if (zh < it.h - 0.5) msgs.push(`mide ${fmt(it.h)} mm de alto y el hueco ≈ ${fmt(zh)} mm`);
          if (msgs.length) res.lines.push('Es demasiado grande: ' + msgs.join('; ') + '.');
        }
      } else {
        const minM = Math.min(...margins);
        res.lines.push(`✅ Cabe. Márgenes: sup ${fmt(margins[0])} · der ${fmt(margins[1])} · inf ${fmt(margins[2])} · izq ${fmt(margins[3])} mm`);
        if (minM < 3) { res.status = 'warn'; res.lines.push('⚠ Muy justo: menos de 3 mm por algún lado.'); }
      }
      if (S.zone.depth > 0 && it.mount !== 'surface') {
        const need = it.d - Math.max(0, it.protrude);
        if (need > S.zone.depth) { res.status = 'bad'; res.lines.push(`⛔ Fondo: necesita ${fmt(need)} mm tras la superficie y hay ${fmt(S.zone.depth)} mm.`); }
        else res.lines.push(`Fondo: usa ${fmt(need)} de ${fmt(S.zone.depth)} mm disponibles.`);
      }
      S.items.forEach((o, j) => {
        if (j === i) return;
        if (Geo.convexOverlap(g.base, geoms[j].base)) {
          res.status = 'bad';
          res.lines.push(`⛔ Se solapa con «${o.name}».`);
        }
      });
      if (it.aspectWarn) { if (res.status === 'ok') res.status = 'warn'; res.lines.push('⚠ ' + it.aspectWarn); }
      out.push(res);
    });
    return out;
  }

  function renderChecks() {
    S.checks = computeChecks();
    const box = $('checks');
    if (!S.bg || !S.checks.length) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    box.innerHTML = '<h4>Comprobación de encaje</h4>' + S.checks.map(c =>
      `<div class="it ${c.status}"><b>${escapeHtml(c.title)}</b>${c.lines.map(l => `<div class="m">${escapeHtml(l)}</div>`).join('')}</div>`).join('');
    document.querySelectorAll('#itemList li').forEach(li => {
      const c = S.checks.find(x => x.id === +li.dataset.id);
      const d = li.querySelector('.dot');
      d.className = 'dot ' + (c ? c.status : '');
    });
  }
  const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ------------------------------ Render de la escena ------------------------------ */
  function lightVec() {
    const az = S.light.az * DEG, el = S.light.el * DEG;
    return [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)];
  }
  const rgb = (c, k = 1, a = 1) => `rgba(${Math.round(Img.clamp(c[0] * k, 0, 255))},${Math.round(Img.clamp(c[1] * k, 0, 255))},${Math.round(Img.clamp(c[2] * k, 0, 255))},${a})`;
  const hexToRgb = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

  function fillPoly(ctx, pts, style) {
    ctx.fillStyle = style;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath();
    ctx.fill();
  }

  /**
   * Compone la escena final en ctx a la escala dada (px destino / px original).
   * source: canvas de fondo (original o trabajo).
   */
  function renderScene(ctx, scale, source, occlScaleSrc, annotate) {
    const W = S.bg.w * scale, H = S.bg.h * scale;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, W, H);
    if (!S.H) return;
    const cam = getCam();
    const T = p => [p[0] * scale, p[1] * scale];
    const Lp = lightVec();
    const op = S.light.op / 100, soft = S.light.soft / 100;

    for (const it of S.items) {
      ensureTex(it);
      if (!it.mips || it.adjDirty && !it.mips) adjustItem(it);
      if (!it.mips) continue;
      const g = itemGeom(it, cam);
      const P = g.P;
      const baseT = g.baseImg.map(T), frontT = g.frontImg.map(T);
      const ppm = (Geo.dist2(baseT[0], baseT[1]) / it.w + Geo.dist2(baseT[1], baseT[2]) / it.h) / 2;
      const housing = it.housingAuto ? it.edge : hexToRgb(it.housing);
      const toImgT = pts => pts.map(p => T(cam.project(p[0], p[1], 0)));

      // --- Sombras proyectadas sobre la superficie
      if (P > 0.5 && op > 0) {
        const lz = Math.max(Lp[2], 0.2);
        const onWall = p => [p[0] - Lp[0] / lz * p[2], p[1] - Lp[1] / lz * p[2]];
        const hull = Geo.convexHull(g.back3.concat(g.front3).map(onWall));
        const zMax = Math.max(...g.front3.map(p => p[2]), ...g.back3.map(p => p[2]));
        const blur = (1.5 + soft * (2 + zMax * 0.35)) * ppm;
        Img.blurPoly(ctx, toImgT(hull), blur, `rgba(0,0,0,${0.62 * op})`);
        Img.blurPoly(ctx, toImgT(g.expand(1.2)), (1 + soft * 3) * ppm, `rgba(0,0,0,${0.55 * op})`);
      }
      // --- Junta / hueco alrededor (empotrado, rehundido)
      if (it.mount !== 'surface' && it.gap > 0) {
        Img.blurPoly(ctx, toImgT(g.expand(it.gap)), Math.min(0.5 * ppm, 2.5), 'rgba(10,10,12,0.93)');
      }
      // --- Paredes interiores del hueco (rehundido)
      if (P < -0.5) {
        ctx.save();
        ctx.beginPath(); baseT.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath(); ctx.clip();
        for (let e = 0; e < 4; e++) {
          const a = g.base[e], b = g.base[(e + 1) % 4];
          const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
          const Pc = cam.camPoint(mid[0], mid[1], P / 2);
          const Pn = cam.camPoint(mid[0] + g.normals[e][0], mid[1] + g.normals[e][1], P / 2);
          const n3 = Geo.vec.sub(Pn, Pc);
          if (Geo.vec.dot(Geo.vec.scl(n3, -1), Geo.vec.scl(Pc, -1)) <= 0) continue;
          const nIn = [-g.normals[e][0], -g.normals[e][1], 0];
          const sh = 0.18 + 0.4 * Math.max(0, nIn[0] * Lp[0] + nIn[1] * Lp[1]);
          const poly = [baseT[e], baseT[(e + 1) % 4], frontT[(e + 1) % 4], frontT[e]];
          fillPoly(ctx, poly, rgb(housing, sh * 0.9));
        }
        ctx.restore();
      }
      // --- Laterales visibles (sobresale): textura real si se marcó en la foto
      if (P > 0.3) {
        const V = Geo.vec;
        const cam8 = g.back3.concat(g.front3).map(p => cam.camPoint(p[0], p[1], p[2]));
        const cc = cam8.reduce((acc, p) => [acc[0] + p[0] / 8, acc[1] + p[1] / 8, acc[2] + p[2] / 8], [0, 0, 0]);
        const pc8 = g.back3.concat(g.front3);
        const pcc = pc8.reduce((acc, p) => [acc[0] + p[0] / 8, acc[1] + p[1] / 8, acc[2] + p[2] / 8], [0, 0, 0]);
        // [trasera-a, trasera-b, frontal-b, frontal-a] y cómo se mapea la textura lateral
        const faces = [
          { e: 0, idx: [0, 1], kind: 'TB', tex: [[0, 'b'], [0, 'f'], [1, 'f'], [1, 'b']] },
          { e: 1, idx: [1, 2], kind: 'LR', tex: [[1, 'b'], [1, 'f'], [2, 'f'], [2, 'b']] },
          { e: 2, idx: [3, 2], kind: 'TB', tex: [[3, 'b'], [3, 'f'], [2, 'f'], [2, 'b']] },
          { e: 3, idx: [0, 3], kind: 'LR', tex: [[0, 'b'], [0, 'f'], [3, 'f'], [3, 'b']] },
        ];
        for (const F of faces) {
          const [i0, i1] = F.idx;
          const A = cam8[i0], B = cam8[i1], C = cam8[4 + i1], D = cam8[4 + i0];
          const fc = [(A[0] + B[0] + C[0] + D[0]) / 4, (A[1] + B[1] + C[1] + D[1]) / 4, (A[2] + B[2] + C[2] + D[2]) / 4];
          let n = V.cross(V.sub(B, A), V.sub(D, A));
          if (V.dot(n, V.sub(fc, cc)) < 0) n = V.scl(n, -1);
          if (V.dot(n, V.scl(fc, -1)) <= 0) continue;
          // normal en coordenadas del plano para el sombreado
          const pA = pc8[i0], pB = pc8[i1], pD = pc8[4 + i0];
          let np = V.cross(V.sub(pB, pA), V.sub(pD, pA));
          const pfc = [(pA[0] + pB[0] + pD[0] + pc8[4 + i1][0]) / 4, (pA[1] + pB[1] + pD[1] + pc8[4 + i1][1]) / 4, (pA[2] + pB[2] + pD[2] + pc8[4 + i1][2]) / 4];
          if (V.dot(np, V.sub(pfc, pcc)) < 0) np = V.scl(np, -1);
          np = V.scl(np, 1 / (V.norm(np) || 1));
          const sh = 0.38 + 0.62 * Math.max(0, V.dot(np, Lp));
          const lf = (it.lightF[i0] + it.lightF[i1]) / 2;
          const poly = [baseT[i0], baseT[i1], frontT[i1], frontT[i0]];
          const side = F.kind === 'LR' ? it.sideLR : it.sideTB;
          if (side && side.mips) {
            const ptsT = F.tex.map(([ci, bf]) => (bf === 'b' ? baseT : frontT)[ci]);
            const len = Geo.dist2(ptsT[0], ptsT[1]);
            let lv = 0;
            while (lv < side.mips.length - 1 && side.mips[lv].w / Math.max(1, len) > 1.6) lv++;
            const st = side.mips[lv];
            const s0 = Img.clamp(1 - P / Math.max(it.d, 1e-6), 0, 0.98) * st.w;
            const Gs = Geo.homography([[s0, 0], [st.w, 0], [st.w, st.h], [s0, st.h]], ptsT);
            if (Gs) {
              const k = (0.55 + 0.45 * sh) * lf;
              Img.warpOnto(ctx, st, Gs, { lightF: [k, k, k, k], clip: poly });
              continue;
            }
          }
          const m0 = [(poly[0][0] + poly[1][0]) / 2, (poly[0][1] + poly[1][1]) / 2];
          const m1 = [(poly[2][0] + poly[3][0]) / 2, (poly[2][1] + poly[3][1]) / 2];
          const grad = ctx.createLinearGradient(m0[0], m0[1], m1[0], m1[1]);
          grad.addColorStop(0, rgb(housing, sh * lf * 0.72));
          grad.addColorStop(0.85, rgb(housing, sh * lf));
          grad.addColorStop(1, rgb(housing, sh * lf * 1.12));
          fillPoly(ctx, poly, grad);
        }
      }
      // --- Cara frontal (textura real del equipo)
      const projW = Geo.dist2(frontT[0], frontT[1]);
      let lvl = 0;
      while (lvl < it.mips.length - 1 && it.mips[lvl].w / Math.max(1, projW) > 1.6) lvl++;
      const tex = it.mips[lvl];
      const G = Geo.homography([[0, 0], [tex.w, 0], [tex.w, tex.h], [0, tex.h]], frontT);
      if (G) {
        const grain = (it.adj.grainAuto ? it.noise : it.adj.grain) * Math.min(1, scale);
        Img.warpOnto(ctx, tex, G, { lightF: it.lightF, grain, gloss: it.adj.gloss / 100, clip: P < -0.5 ? baseT : null });
      }
    }

    // --- Oclusión: lo que está delante en la foto original vuelve a pintarse encima
    if (S.occlHas) {
      const tmp = Img.makeCanvas(W, H);
      const tc = tmp.getContext('2d');
      tc.drawImage(source, 0, 0, W, H);
      tc.globalCompositeOperation = 'destination-in';
      tc.drawImage(occlScaleSrc, 0, 0, W, H);
      ctx.drawImage(tmp, 0, 0);
    }

    if (annotate) drawAnnotations(ctx, scale, cam);
  }

  function drawAnnotations(ctx, scale, cam) {
    const fs = Math.max(12, Math.round(Math.max(S.bg.w, S.bg.h) * scale / 90));
    ctx.save();
    ctx.font = `600 ${fs}px Segoe UI, Arial, sans-serif`;
    S.items.forEach(it => {
      const g = itemGeom(it, cam);
      const f = g.frontImg.map(p => [p[0] * scale, p[1] * scale]);
      const chk = S.checks.find(c => c.id === it.id);
      const col = chk && chk.status === 'bad' ? '#ef5350' : '#ffcc33';
      ctx.strokeStyle = col; ctx.lineWidth = Math.max(2, fs / 7);
      ctx.setLineDash([fs / 2, fs / 3]);
      ctx.beginPath(); f.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath(); ctx.stroke();
      ctx.setLineDash([]);
      const label = `${it.name} · ${fmt(it.w)} × ${fmt(it.h)} × ${fmt(it.d)} mm`;
      const top = f.reduce((a, p) => (p[1] < a[1] ? p : a), f[0]);
      const tw = ctx.measureText(label).width;
      const x = Img.clamp(top[0] - tw / 2, 4, S.bg.w * scale - tw - 12), y = Math.max(fs * 1.6, top[1] - fs * 0.9);
      ctx.fillStyle = 'rgba(0,0,0,0.72)';
      ctx.fillRect(x - 6, y - fs * 1.05, tw + 12, fs * 1.45);
      ctx.fillStyle = col;
      ctx.fillText(label, x, y);
    });
    ctx.restore();
  }

  /* ------------------------------ Dibujo de la vista ------------------------------ */
  let rafId = 0, compDirty = true;
  function requestRender(comp) {
    if (comp) compDirty = true;
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      if (compDirty && S.bg) {
        compDirty = false;
        renderScene(S.comp.getContext('2d', { willReadFrequently: true }), S.workScale, S.work, S.occl, false);
        renderChecks();
      }
      drawView();
    });
  }

  function drawView() {
    const dpr = window.devicePixelRatio || 1;
    vctx.setTransform(1, 0, 0, 1, 0, 0);
    vctx.clearRect(0, 0, view.width, view.height);
    $('zoomVal').textContent = Math.round(S.view.zoom * 100) + '%';
    if (!S.bg) return;
    vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { x, y, zoom } = S.view;
    const W = S.bg.w * zoom, H = S.bg.h * zoom;
    vctx.imageSmoothingEnabled = true;
    vctx.imageSmoothingQuality = 'high';
    vctx.drawImage(S.comp, x, y, W, H);
    if (S.compare) {
      const sx = x + W * S.split;
      vctx.save();
      vctx.beginPath(); vctx.rect(x, y, W * S.split, H); vctx.clip();
      vctx.drawImage(S.work, x, y, W, H);
      vctx.restore();
      vctx.fillStyle = '#fff'; vctx.fillRect(sx - 1, y, 2, H);
      vctx.beginPath(); vctx.arc(sx, y + H / 2, 14, 0, Math.PI * 2); vctx.fill();
      vctx.fillStyle = '#111'; vctx.font = '600 12px Segoe UI, sans-serif'; vctx.textAlign = 'center'; vctx.textBaseline = 'middle';
      vctx.fillText('⇔', sx, y + H / 2 + 1);
      label(vctx, 'ANTES', x + 12, y + 12, 'left');
      label(vctx, 'DESPUÉS', x + W - 12, y + 12, 'right');
    }
    if (S.mode === 'occ-paint' || S.mode === 'occ-erase') {
      vctx.globalAlpha = 0.45;
      vctx.drawImage(occlTint(), x, y, W, H);
      vctx.globalAlpha = 1;
    }
    if (S.helpers) drawHelpers();
    if (S.marking) drawMarking();
    if ((S.mode === 'occ-paint' || S.mode === 'occ-erase') && S.cursor) {
      vctx.strokeStyle = S.mode === 'occ-paint' ? '#ff4fd8' : '#fff';
      vctx.lineWidth = 1.5;
      vctx.beginPath(); vctx.arc(S.cursor[0], S.cursor[1], S.occR, 0, Math.PI * 2); vctx.stroke();
    }
  }

  function label(ctx, text, x, y, align) {
    ctx.save();
    ctx.font = '700 11px Segoe UI, sans-serif';
    const w = ctx.measureText(text).width + 12;
    const bx = align === 'right' ? x - w : x;
    ctx.fillStyle = 'rgba(0,0,0,.7)'; ctx.fillRect(bx, y, w, 20);
    ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(text, bx + 6, y + 10);
    ctx.restore();
  }

  function polyPath(ctx, pts) {
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath();
  }

  function drawHandles(pts, color) {
    pts.forEach((p, i) => {
      vctx.fillStyle = '#0b0d10'; vctx.strokeStyle = color; vctx.lineWidth = 2;
      vctx.beginPath(); vctx.arc(p[0], p[1], 6, 0, Math.PI * 2); vctx.fill(); vctx.stroke();
      vctx.fillStyle = color; vctx.font = '700 10px Segoe UI, sans-serif'; vctx.textAlign = 'center'; vctx.textBaseline = 'middle';
      vctx.fillText(String(i + 1), p[0], p[1] - 14);
    });
  }

  function edgeLabel(a, b, text, color) {
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    vctx.save();
    vctx.font = '600 11px Segoe UI, sans-serif';
    const w = vctx.measureText(text).width + 10;
    vctx.fillStyle = 'rgba(0,0,0,.75)'; vctx.fillRect(mx - w / 2, my - 9, w, 18);
    vctx.fillStyle = color; vctx.textAlign = 'center'; vctx.textBaseline = 'middle';
    vctx.fillText(text, mx, my);
    vctx.restore();
  }

  /** Línea de cota con topes y etiqueta. */
  function drawDim(a, b, color, text) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
    const nx = -dy / L * 6, ny = dx / L * 6;
    vctx.strokeStyle = color; vctx.lineWidth = 2;
    vctx.beginPath();
    vctx.moveTo(a[0], a[1]); vctx.lineTo(b[0], b[1]);
    vctx.moveTo(a[0] - nx, a[1] - ny); vctx.lineTo(a[0] + nx, a[1] + ny);
    vctx.moveTo(b[0] - nx, b[1] - ny); vctx.lineTo(b[0] + nx, b[1] + ny);
    vctx.stroke();
    [a, b].forEach(p => { vctx.fillStyle = color; vctx.beginPath(); vctx.arc(p[0], p[1], 3.5, 0, Math.PI * 2); vctx.fill(); });
    edgeLabel(a, b, text, color);
  }

  function drawHelpers() {
    if (S.ref.pts) {
      const r = S.ref.pts.map(toScreen);
      vctx.strokeStyle = '#33d1ff'; vctx.lineWidth = 1.5; vctx.setLineDash([6, 4]);
      polyPath(vctx, r); vctx.stroke(); vctx.setLineDash([]);
      // rejilla de referencia ligera
      if (S.H) {
        vctx.strokeStyle = 'rgba(51,209,255,.22)'; vctx.lineWidth = 1;
        const n = 4;
        for (let i = 1; i < n; i++) {
          const a = toScreen(Geo.apply(S.H, S.ref.W * i / n, 0)), b = toScreen(Geo.apply(S.H, S.ref.W * i / n, S.ref.H));
          const c = toScreen(Geo.apply(S.H, 0, S.ref.H * i / n)), d = toScreen(Geo.apply(S.H, S.ref.W, S.ref.H * i / n));
          vctx.beginPath(); vctx.moveTo(a[0], a[1]); vctx.lineTo(b[0], b[1]); vctx.moveTo(c[0], c[1]); vctx.lineTo(d[0], d[1]); vctx.stroke();
        }
      }
      drawHandles(r, '#33d1ff');
      if (S.H) {
        const ap = S.calib.method === 'cota' ? '≈ ' : '';
        edgeLabel(r[0], r[1], `${ap}${fmt(S.ref.W, S.ref.W % 1 && !ap ? 1 : 0)} mm`, '#33d1ff');
        edgeLabel(r[1], r[2], `${ap}${fmt(S.ref.H, S.ref.H % 1 && !ap ? 1 : 0)} mm`, '#33d1ff');
      }
    }
    if ((S.calib.method === 'cota' || !S.zone.useRef) && S.zone.pts) {
      const z = S.zone.pts.map(toScreen);
      vctx.strokeStyle = '#4cd964'; vctx.lineWidth = 2; vctx.setLineDash([3, 3]);
      polyPath(vctx, z); vctx.stroke(); vctx.setLineDash([]);
      drawHandles(z, '#4cd964');
      const zs = quadSizeMm(S.zone.pts);
      if (zs) { edgeLabel(z[0], z[1], `zona ≈ ${fmt(zs[0])} mm`, '#4cd964'); edgeLabel(z[1], z[2], `≈ ${fmt(zs[1])} mm`, '#4cd964'); }
    }
    S.calib.method === 'cota' && S.calib.cotas.forEach((c, i) => {
      const a = toScreen(c.a), b = toScreen(c.b);
      drawDim(a, b, '#ff9f43', `${i + 1}: ${fmt(c.mm, c.mm % 1 ? 1 : 0)} mm`);
    });
    if (S.ruler) {
      const a = toScreen(S.ruler.a), b = toScreen(S.ruler.b), mm = segMm(S.ruler.a, S.ruler.b);
      drawDim(a, b, '#ffe066', mm != null ? `📏 ${fmt(mm, mm < 100 ? 1 : 0)} mm` : 'calibra primero');
    }
    if (!S.H) return;
    const cam = getCam();
    S.items.forEach((it, i) => {
      const g = itemGeom(it, cam);
      const f = g.frontImg.map(toScreen);
      const chk = S.checks.find(c => c.id === it.id);
      const col = !chk ? '#ccc' : chk.status === 'bad' ? '#ef5350' : chk.status === 'warn' ? '#f2b33d' : '#2fbf71';
      vctx.strokeStyle = col; vctx.lineWidth = i === S.sel ? 2.5 : 1.2;
      if (i !== S.sel) vctx.setLineDash([5, 4]);
      polyPath(vctx, f); vctx.stroke(); vctx.setLineDash([]);
      if (Math.abs(g.P) > 0.5 && i === S.sel) {
        vctx.strokeStyle = 'rgba(255,255,255,.35)'; vctx.lineWidth = 1; vctx.setLineDash([2, 3]);
        polyPath(vctx, g.baseImg.map(toScreen)); vctx.stroke(); vctx.setLineDash([]);
      }
      if (i === S.sel) {
        edgeLabel(f[0], f[1], `${it.name} · ${fmt(it.w)} × ${fmt(it.h)} mm`, col);
      }
    });
  }

  function drawMarking() {
    const pts = S.marking.pts.map(toScreen);
    const col = { ref: '#33d1ff', zone: '#4cd964', cota: '#ff9f43', ruler: '#ffe066' }[S.marking.kind];
    vctx.strokeStyle = col; vctx.lineWidth = 2;
    vctx.beginPath();
    pts.forEach((p, i) => (i ? vctx.lineTo(p[0], p[1]) : vctx.moveTo(p[0], p[1])));
    if (S.cursor && pts.length) vctx.lineTo(S.cursor[0], S.cursor[1]);
    vctx.stroke();
    drawHandles(pts, col);
  }

  function occlTint() {
    if (!S.occlTint || S.occlTintDirty) {
      S.occlTint = S.occlTint || Img.makeCanvas(S.occl.width, S.occl.height);
      const c = S.occlTint.getContext('2d');
      c.globalCompositeOperation = 'source-over';
      c.clearRect(0, 0, S.occl.width, S.occl.height);
      c.fillStyle = '#ff2fd0'; c.fillRect(0, 0, S.occl.width, S.occl.height);
      c.globalCompositeOperation = 'destination-in';
      c.drawImage(S.occl, 0, 0);
      S.occlTintDirty = false;
    }
    return S.occlTint;
  }

  /* ------------------------------ Interacción ------------------------------ */
  function setMode(m) {
    S.mode = m;
    const marking = ['ref', 'zone', 'cota', 'ruler'].includes(m);
    if (!marking) S.marking = null;
    document.querySelectorAll('#toolbar .tool[data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
    $('btnOccPaint').classList.toggle('primary', m === 'occ-paint');
    $('btnOccErase').classList.toggle('primary', m === 'occ-erase');
    $('btnRuler').classList.toggle('active', m === 'ruler');
    view.style.cursor = m === 'pan' ? 'grab' : marking ? 'crosshair' : (m.startsWith('occ') ? 'none' : 'default');
    const hints = {
      move: S.items.length ? 'Arrastra un equipo para moverlo · flechas: 1 mm (Mayús: 10 mm) · arrastra los puntos de la referencia para corregirla.' : 'Añade un equipo en el paso 4.',
      pan: 'Arrastra para desplazar la vista · rueda para zoom.',
      ref: S.calib.method === 'cota'
        ? 'Haz clic en las <b>4 esquinas de algo rectangular</b> de la superficie (una pantalla existente, un panel, una tapa…). No necesitas sus medidas. Esc para cancelar.'
        : 'Haz clic en las <b>4 esquinas</b> del rectángulo de referencia (en cualquier orden). Esc para cancelar.',
      zone: 'Haz clic en las <b>4 esquinas</b> de la zona donde quieres poner el equipo (el hueco libre). Esc para cancelar.',
      cota: 'Haz clic en los <b>2 extremos</b> de algo cuya medida conozcas, sobre la misma superficie (p. ej. la diagonal de una pantalla). Esc para cancelar.',
      ruler: 'Regla: haz clic en <b>2 puntos</b> de la superficie calibrada para medir la distancia en mm.',
      'occ-paint': 'Pinta lo que debe quedar <b>delante</b> del equipo nuevo.',
      'occ-erase': 'Borra zonas de la máscara de primer plano.',
    };
    setHint(hints[m] || '');
    requestRender(false);
  }
  function setHint(h) { $('hint').innerHTML = h; }

  function startMarking(kind) {
    if (!S.bg) { toast('Primero carga la foto base.'); return; }
    if (kind === 'cota' && !S.ref.pts) { toast('Primero marca el rectángulo de la superficie (paso 3.1).'); return; }
    const n = kind === 'cota' || kind === 'ruler' ? 2 : 4;
    setMode(kind);
    S.marking = { kind, pts: [], n };
  }

  function hitHandle(sp) {
    const cands = [];
    if (S.helpers && S.ref.pts) S.ref.pts.forEach((p, i) => cands.push({ kind: 'ref', i, p }));
    if (S.helpers && (S.calib.method === 'cota' || !S.zone.useRef) && S.zone.pts) S.zone.pts.forEach((p, i) => cands.push({ kind: 'zone', i, p }));
    if (S.helpers && S.calib.method === 'cota') S.calib.cotas.forEach((c, i) => { cands.push({ kind: 'cota', i, end: 'a', p: c.a }); cands.push({ kind: 'cota', i, end: 'b', p: c.b }); });
    if (S.ruler) { cands.push({ kind: 'ruler', end: 'a', p: S.ruler.a }); cands.push({ kind: 'ruler', end: 'b', p: S.ruler.b }); }
    let best = null, bd = 11;
    cands.forEach(c => { const d = Geo.dist2(toScreen(c.p), sp); if (d < bd) { bd = d; best = c; } });
    return best;
  }

  function hitItem(sp) {
    if (!S.H) return -1;
    const cam = getCam();
    for (let i = S.items.length - 1; i >= 0; i--) {
      const g = itemGeom(S.items[i], cam);
      if (Geo.pointInPoly(sp, g.frontImg.map(toScreen)) || Geo.pointInPoly(sp, g.baseImg.map(toScreen))) return i;
    }
    return -1;
  }

  function paintOccl(sp, last) {
    const ctx = S.occl.getContext('2d');
    const ws = S.workScale;
    const p = toImage(sp).map(v => v * ws);
    const r = S.occR / S.view.zoom * ws;
    ctx.globalCompositeOperation = S.mode === 'occ-paint' ? 'source-over' : 'destination-out';
    const stamp = (x, y) => {
      const gr = ctx.createRadialGradient(x, y, r * 0.55, x, y, r);
      gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    };
    if (last) {
      const q = toImage(last).map(v => v * ws);
      const d = Geo.dist2(p, q), steps = Math.max(1, Math.ceil(d / (r * 0.3)));
      for (let k = 1; k <= steps; k++) stamp(q[0] + (p[0] - q[0]) * k / steps, q[1] + (p[1] - q[1]) * k / steps);
    } else stamp(p[0], p[1]);
    ctx.globalCompositeOperation = 'source-over';
    S.occlHas = true; S.occlTintDirty = true;
    requestRender(true);
  }

  view.addEventListener('contextmenu', e => e.preventDefault());
  view.addEventListener('pointerdown', e => {
    if (!S.bg) return;
    view.setPointerCapture(e.pointerId);
    const sp = eventPos(e);
    if (e.button === 1 || e.button === 2 || S.mode === 'pan' || S.spaceDown) {
      S.drag = { type: 'pan', sp, vx: S.view.x, vy: S.view.y };
      view.style.cursor = 'grabbing';
      return;
    }
    if (S.compare) {
      const sx = S.view.x + S.bg.w * S.view.zoom * S.split;
      if (Math.abs(sp[0] - sx) < 16) { S.drag = { type: 'split' }; return; }
    }
    if (S.marking) {
      S.marking.pts.push(toImage(sp));
      if (S.marking.pts.length === S.marking.n) finishMarking();
      requestRender(false);
      return;
    }
    if (S.mode === 'occ-paint' || S.mode === 'occ-erase') {
      S.drag = { type: 'occ', last: sp };
      paintOccl(sp, null);
      return;
    }
    const h = hitHandle(sp);
    if (h) { S.drag = { type: 'handle', ...h }; return; }
    const i = hitItem(sp);
    if (i >= 0) {
      selectItem(i);
      const it = S.items[i];
      const pp = imgToPlane(toImage(sp));
      S.drag = { type: 'item', it, off: [pp[0] - it.cx, pp[1] - it.cy] };
      view.style.cursor = 'move';
    }
  });
  view.addEventListener('pointermove', e => {
    const sp = eventPos(e);
    S.cursor = sp;
    if (S.bg) {
      const ip = toImage(sp);
      let txt = `x ${Math.round(ip[0])} · y ${Math.round(ip[1])} px`;
      if (S.Hinv) { const pp = imgToPlane(ip); txt += `  |  plano: ${fmt(pp[0])} , ${fmt(pp[1])} mm`; }
      $('coords').textContent = txt;
    }
    const d = S.drag;
    if (!d) {
      if (S.marking || S.mode.startsWith('occ')) requestRender(false);
      else if (S.bg && S.mode === 'move') view.style.cursor = hitHandle(sp) ? 'pointer' : hitItem(sp) >= 0 ? 'move' : 'default';
      return;
    }
    if (d.type === 'pan') {
      S.view.x = d.vx + sp[0] - d.sp[0]; S.view.y = d.vy + sp[1] - d.sp[1];
      requestRender(false);
    } else if (d.type === 'split') {
      S.split = Img.clamp((sp[0] - S.view.x) / (S.bg.w * S.view.zoom), 0, 1);
      requestRender(false);
    } else if (d.type === 'occ') {
      paintOccl(sp, d.last); d.last = sp;
    } else if (d.type === 'handle') {
      const ip = toImage(sp);
      if (d.kind === 'ref') { S.ref.pts[d.i] = ip; computeH(); }
      else if (d.kind === 'zone') { S.zone.pts[d.i] = ip; renderCalibInfo(); }
      else if (d.kind === 'cota') { S.calib.cotas[d.i][d.end] = ip; computeH(); }
      else if (d.kind === 'ruler') S.ruler[d.end] = ip;
      S.items.forEach(markAdjust);
      requestRender(true);
    } else if (d.type === 'item') {
      const pp = imgToPlane(toImage(sp));
      const it = d.it;
      it.cx = pp[0] - d.off[0]; it.cy = pp[1] - d.off[1];
      applySnap(it);
      markAdjust(it);
      syncItemFields();
      requestRender(true);
    }
  });
  const endDrag = e => {
    if (S.drag && S.drag.type === 'handle' && S.drag.kind === 'ref') { S.ref.pts = Geo.sortQuad(S.ref.pts); computeH(); requestRender(true); }
    if (S.drag && S.drag.type === 'handle' && S.drag.kind === 'zone') { S.zone.pts = Geo.sortQuad(S.zone.pts); requestRender(true); }
    S.drag = null;
    setMode(S.mode);
  };
  view.addEventListener('pointerup', endDrag);
  view.addEventListener('pointercancel', endDrag);
  view.addEventListener('wheel', e => {
    if (!S.bg) return;
    e.preventDefault();
    const sp = eventPos(e);
    zoomAt(Math.exp(-e.deltaY * 0.0015), sp[0], sp[1]);
  }, { passive: false });

  function finishMarking() {
    const { kind, pts } = S.marking;
    S.marking = null;
    if (kind === 'ruler') { S.ruler = { a: pts[0], b: pts[1] }; setMode('move'); requestRender(false); return; }
    if (kind === 'cota') {
      const mm = num($('cotaMm'), 0);
      const sel = $('cotaPreset');
      const label = sel.value === 'diag' ? `Diagonal ${fmt(num($('cotaInch'), 0), 1)}"` : sel.value === 'custom' ? 'Cota' : sel.options[sel.selectedIndex].text.replace(/\s*\(.*$/, '');
      S.calib.cotas.push({ a: pts[0], b: pts[1], mm, label });
      if (!(mm > 0)) toast('Escribe la longitud real de la cota en la lista (mm).');
      setMode('move'); calibChanged(); updateUI();
      return;
    }
    const q = Geo.sortQuad(pts);
    if (!Geo.isConvexQuad(q)) { toast('Las 4 esquinas no forman un cuadrilátero válido. Vuelve a marcarlas.'); setMode('move'); return; }
    if (kind === 'ref') {
      S.ref.pts = q; computeH();
      // centra los equipos que todavía no tienen posición
      S.items.forEach(it => { if (!it.placed) placeItem(it); });
      toast(S.H ? 'Referencia calibrada. Ya puedes añadir equipos (paso 4).' : 'Rectángulo marcado. Ahora traza una cota conocida (paso 3.2).');
    } else {
      S.zone.pts = q;
      S.items.forEach(it => { if (!it.placed || S.items.length === 1) placeItem(it); });
      toast('Zona disponible marcada.');
    }
    S.items.forEach(markAdjust);
    setMode('move');
    updateUI();
    requestRender(true);
  }

  function applySnap(it) {
    if (!(it.snap > 0)) return;
    const l = Math.round((it.cx - it.w / 2) / it.snap) * it.snap;
    const t = Math.round((it.cy - it.h / 2) / it.snap) * it.snap;
    it.cx = l + it.w / 2; it.cy = t + it.h / 2;
  }

  function placeItem(it) {
    if (!S.H) return;
    const z = zonePoly() || [[0, 0], [S.ref.W, 0], [S.ref.W, S.ref.H], [0, S.ref.H]];
    const c = z.reduce((a, p) => [a[0] + p[0] / z.length, a[1] + p[1] / z.length], [0, 0]);
    it.cx = c[0]; it.cy = c[1];
    it.placed = true;
  }

  window.addEventListener('keydown', e => {
    if (e.target.matches('input, textarea, select')) return;
    if (!$('editor').classList.contains('hidden')) return;
    const k = e.key;
    if (k === ' ') { S.spaceDown = true; view.style.cursor = 'grab'; e.preventDefault(); return; }
    if (k === 'Escape') { S.marking = null; setMode('move'); return; }
    if (k === 'v' || k === 'V') setMode('move');
    else if (k === 'h' || k === 'H') setMode('pan');
    else if (k === 'f' || k === 'F') fitView();
    else if (k === 'c' || k === 'C') toggleCompare();
    else if (k === 'g' || k === 'G') toggleHelpers();
    else if (k === 'm' || k === 'M') $('btnRuler').click();
    else if (k.startsWith('Arrow') && S.sel >= 0) {
      const it = S.items[S.sel];
      const st = e.shiftKey ? 10 : 1;
      if (k === 'ArrowLeft') it.cx -= st; if (k === 'ArrowRight') it.cx += st;
      if (k === 'ArrowUp') it.cy -= st; if (k === 'ArrowDown') it.cy += st;
      markAdjust(it); syncItemFields(); requestRender(true);
      e.preventDefault();
    } else if ((e.ctrlKey || e.metaKey) && (k === 's' || k === 'S')) { e.preventDefault(); saveProject(); }
  });
  window.addEventListener('keyup', e => { if (e.key === ' ') { S.spaceDown = false; setMode(S.mode); } });

  function toggleCompare() { S.compare = !S.compare; $('btnCompare').classList.toggle('active', S.compare); requestRender(false); }
  function toggleHelpers() { S.helpers = !S.helpers; $('btnHelpers').classList.toggle('active', S.helpers); $('checks').style.display = S.helpers ? '' : 'none'; requestRender(false); }

  /* ------------------------------ Arrastrar y soltar ------------------------------ */
  const wrap = $('canvasWrap');
  wrap.addEventListener('dragover', e => { e.preventDefault(); $('empty').classList.add('drag'); });
  wrap.addEventListener('dragleave', () => $('empty').classList.remove('drag'));
  wrap.addEventListener('drop', async e => {
    e.preventDefault(); $('empty').classList.remove('drag');
    const files = [...e.dataTransfer.files].filter(f => f.type.startsWith('image/'));
    for (const f of files) {
      if (!S.bg) await loadBackground(f);
      else await addItemFromFile(f);
    }
  });

  /* ------------------------------ Panel lateral ------------------------------ */
  function bindSlider(id, get, set, fmtFn) {
    const el = $(id);
    const out = document.querySelector(`.val[data-for="${id}"]`) || $(id + 'Val');
    const show = () => { if (out) out.textContent = fmtFn ? fmtFn(+el.value) : el.value; };
    el.addEventListener('input', () => { set(+el.value); show(); });
    el._sync = () => { el.value = get(); show(); };
    el._sync();
  }

  $('projTitle').addEventListener('input', () => {});
  $('fileBg').addEventListener('change', async e => { const f = e.target.files[0]; if (f) await loadBackground(f); e.target.value = ''; });

  /* ---- Método de calibración ---- */
  function setCalibMethod(m) {
    S.calib.method = m;
    syncCalibUI();
    calibChanged();
    setMode('move');
  }
  function syncCalibUI() {
    const cota = S.calib.method === 'cota';
    $('calModeCota').classList.toggle('active', cota);
    $('calModeDims').classList.toggle('active', !cota);
    $('calCota').classList.toggle('hidden', !cota);
    $('calDims').classList.toggle('hidden', cota);
    $('zoneUseRefRow').classList.toggle('hidden', cota);
    $('btnZone').disabled = !cota && S.zone.useRef;
    if (!cota) refDimsChanged(true);
  }
  $('calModeCota').addEventListener('click', () => setCalibMethod('cota'));
  $('calModeDims').addEventListener('click', () => setCalibMethod('dims'));
  const COTA_MM = { a4l: 297, a4s: 210, card: 85.6, rack: 482.6, u: 44.45 };
  function applyCotaPreset() {
    const v = $('cotaPreset').value;
    $('cotaInchRow').classList.toggle('hidden', v !== 'diag');
    if (v === 'diag') $('cotaMm').value = (num($('cotaInch'), 0) * 25.4).toFixed(1);
    else if (v in COTA_MM) $('cotaMm').value = COTA_MM[v];
  }
  $('cotaPreset').addEventListener('change', applyCotaPreset);
  $('cotaInch').addEventListener('input', applyCotaPreset);
  $('cotaMm').addEventListener('input', () => { if ($('cotaPreset').value !== 'custom' && $('cotaPreset').value !== 'diag') $('cotaPreset').value = 'custom'; });
  $('btnRefCota').addEventListener('click', () => startMarking('ref'));
  $('refAspect').addEventListener('change', e => { S.calib.knownAspect = e.target.value; calibChanged(); });
  $('btnCota').addEventListener('click', () => startMarking('cota'));
  $('btnRuler').addEventListener('click', () => { if (S.mode === 'ruler') setMode('move'); else if (!S.H) toast('Calibra primero la superficie (paso 3).'); else startMarking('ruler'); });

  const REF_PRESETS = { rack: 482.6, rackin: 450 };
  function applyRefPreset() {
    const p = $('refPreset').value;
    $('refURow').classList.toggle('hidden', !(p in REF_PRESETS));
    $('refScreenRow').classList.toggle('hidden', p !== 'screen');
    if (p === 'screen') {
      const [rw, rh] = $('refFormat').value.split(':').map(Number);
      const d = num($('refInch'), 10.4) * 25.4, k = d / Math.hypot(rw, rh);
      $('refW').value = (rw * k).toFixed(1); $('refH').value = (rh * k).toFixed(1);
    } else if (p in REF_PRESETS) {
      $('refW').value = REF_PRESETS[p];
      $('refH').value = (num($('refU'), 1) * 44.45).toFixed(2);
    } else if (p === 'a4') { $('refW').value = 297; $('refH').value = 210; }
    refDimsChanged();
  }
  function refDimsChanged(silent) {
    if (S.calib.method !== 'dims') return;
    S.ref.W = Math.max(1, num($('refW'), 600));
    S.ref.H = Math.max(1, num($('refH'), 400));
    if (silent === true) return;
    computeH();
    S.items.forEach(markAdjust);
    requestRender(true);
  }
  $('refPreset').addEventListener('change', applyRefPreset);
  $('refU').addEventListener('input', applyRefPreset);
  $('refInch').addEventListener('input', applyRefPreset);
  $('refFormat').addEventListener('change', applyRefPreset);
  $('refW').addEventListener('input', () => { $('refPreset').value = 'custom'; $('refURow').classList.add('hidden'); refDimsChanged(); });
  $('refH').addEventListener('input', () => { $('refPreset').value = 'custom'; $('refURow').classList.add('hidden'); refDimsChanged(); });
  $('btnRef').addEventListener('click', () => startMarking('ref'));
  $('zoneUseRef').addEventListener('change', e => { S.zone.useRef = e.target.checked; syncCalibUI(); if (!S.zone.useRef && !S.zone.pts) startMarking('zone'); renderCalibInfo(); requestRender(true); });
  $('btnZone').addEventListener('click', () => startMarking('zone'));
  $('zoneDepth').addEventListener('input', e => { const v = parseFloat(e.target.value); S.zone.depth = isFinite(v) && v > 0 ? v : null; requestRender(true); });
  $('camAuto').addEventListener('change', e => { S.cam.auto = e.target.checked; $('camF').disabled = S.cam.auto; calibChanged(); });
  bindSlider('camF', () => S.cam.f, v => { S.cam.f = v; calibChanged(); }, v => v.toFixed(2));
  function updateCamLabel() {
    const cam = getCam();
    if (!cam) { $('camFVal').textContent = ''; return; }
    const D = Math.max(S.bg.w, S.bg.h);
    const rel = cam.f / D;
    const fov = 2 * Math.atan(S.bg.w / 2 / cam.f) / DEG;
    $('camFVal').textContent = `${rel.toFixed(2)} (≈${fov.toFixed(0)}° horiz.)${S.cam.auto ? (cam.fEst ? ' · estimada' : ' · por defecto') : ''}`;
    if (S.cam.auto) $('camF').value = rel.toFixed(2);
    else $('camFVal').textContent = `${S.cam.f.toFixed(2)} (≈${(2 * Math.atan(S.bg.w / 2 / (S.cam.f * D)) / DEG).toFixed(0)}° horiz.)`;
  }

  // Luz
  const azName = a => {
    const n = ['derecha', 'abajo-dcha', 'abajo', 'abajo-izq', 'izquierda', 'arriba-izq', 'arriba', 'arriba-dcha'];
    return n[((Math.round(a / 45) % 8) + 8) % 8];
  };
  bindSlider('lgAz', () => S.light.az, v => { S.light.az = v; requestRender(true); }, v => `${v}° (${azName(v)})`);
  bindSlider('lgEl', () => S.light.el, v => { S.light.el = v; requestRender(true); }, v => `${v}°`);
  bindSlider('lgOp', () => S.light.op, v => { S.light.op = v; requestRender(true); }, v => `${v}%`);
  bindSlider('lgSoft', () => S.light.soft, v => { S.light.soft = v; requestRender(true); }, v => `${v}%`);
  bindSlider('occR', () => S.occR, v => { S.occR = v; }, v => `${v} px`);
  $('btnOccPaint').addEventListener('click', () => setMode(S.mode === 'occ-paint' ? 'move' : 'occ-paint'));
  $('btnOccErase').addEventListener('click', () => setMode(S.mode === 'occ-erase' ? 'move' : 'occ-erase'));
  $('btnOccClear').addEventListener('click', () => {
    if (!S.occl) return;
    S.occl.getContext('2d').clearRect(0, 0, S.occl.width, S.occl.height);
    S.occlHas = false; S.occlTintDirty = true; requestRender(true);
  });

  // Toolbar
  document.querySelectorAll('#toolbar .tool[data-mode]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('btnFit').addEventListener('click', fitView);
  $('btnZoomIn').addEventListener('click', () => { const r = view.getBoundingClientRect(); zoomAt(1.25, r.width / 2, r.height / 2); });
  $('btnZoomOut').addEventListener('click', () => { const r = view.getBoundingClientRect(); zoomAt(0.8, r.width / 2, r.height / 2); });
  $('btnCompare').addEventListener('click', toggleCompare);
  $('btnHelpers').addEventListener('click', toggleHelpers);

  /* ---- Equipos: lista y propiedades ---- */
  async function addItemFromFile(file) {
    const img = await Img.loadImage(file);
    const c = Img.imageToCanvas(img, ITEM_MAX);
    const it = newItem(c, (file.name || 'Equipo').replace(/\.[^.]+$/, ''));
    // Si el borde de la foto es uniforme (fondo de catálogo) se recorta solo
    if (borderIsUniform(it)) {
      Img.autoRemoveBackground(it.src.data, it.mask, it.src.w, it.src.h, 32);
      Img.fillHoles(it.mask, it.src.w, it.src.h);
      const bb = Img.maskBBox(it.mask, it.src.w, it.src.h);
      if (bb && (bb[2] - bb[0]) * (bb[3] - bb[1]) > it.src.w * it.src.h * 0.03) {
        it.quad = Img.maskQuad(it.mask, it.src.w, it.src.h);
      } else it.mask.fill(255);
    }
    // proporción inicial a partir de la foto (el usuario debe confirmar las medidas reales)
    const qw = Geo.dist2(it.quad[0], it.quad[1]), qh = Geo.dist2(it.quad[1], it.quad[2]);
    it.w = 300; it.h = Math.round(300 * qh / Math.max(1, qw));
    it.dimsConfirmed = false;
    openEditor(it, true);
  }

  function borderIsUniform(it) {
    const { w, h, data } = it.src;
    const vals = [];
    const st = Math.max(1, Math.floor((w + h) / 400));
    for (let x = 0; x < w; x += st) { vals.push(x * 4, ((h - 1) * w + x) * 4); }
    for (let y = 0; y < h; y += st) { vals.push(y * w * 4, (y * w + w - 1) * 4); }
    let s = [0, 0, 0], s2 = [0, 0, 0];
    vals.forEach(i => { for (let c = 0; c < 3; c++) { s[c] += data[i + c]; s2[c] += data[i + c] ** 2; } });
    const n = vals.length;
    const sd = Math.sqrt([0, 1, 2].reduce((a, c) => a + (s2[c] / n - (s[c] / n) ** 2), 0) / 3);
    return sd < 18;
  }

  function makeThumb(it) {
    const s = 80 / Math.max(it.src.w, it.src.h);
    const c = Img.makeCanvas(it.src.w * s, it.src.h * s);
    const full = Img.makeCanvas(it.src.w, it.src.h);
    const fctx = full.getContext('2d');
    const id = fctx.createImageData(it.src.w, it.src.h);
    id.data.set(it.src.data);
    for (let i = 0; i < it.mask.length; i++) id.data[i * 4 + 3] = it.mask[i];
    fctx.putImageData(id, 0, 0);
    c.getContext('2d').drawImage(full, 0, 0, c.width, c.height);
    it.thumb = c.toDataURL('image/png');
  }

  function renderItemList() {
    const ul = $('itemList');
    ul.innerHTML = '';
    S.items.forEach((it, i) => {
      const li = document.createElement('li');
      li.dataset.id = it.id;
      li.className = i === S.sel ? 'sel' : '';
      li.innerHTML = `<span class="dot"></span><img alt="" src="${it.thumb}"><span class="nm">${escapeHtml(it.name)}</span><span class="small muted">${fmt(it.w)}×${fmt(it.h)}</span>`;
      li.addEventListener('click', () => selectItem(i));
      ul.appendChild(li);
    });
    renderChecks();
  }

  function selectItem(i) {
    S.sel = i;
    renderItemList();
    syncItemFields();
    requestRender(false);
  }

  const ADJ = ['adMatch', 'adLight', 'adExposure', 'adContrast', 'adSaturation', 'adTemperature', 'adBlur', 'adGrain', 'adGloss', 'adFeather'];
  const ADJKEY = { adMatch: 'match', adLight: 'light', adExposure: 'exposure', adContrast: 'contrast', adSaturation: 'saturation', adTemperature: 'temperature', adBlur: 'blur', adGrain: 'grain', adGloss: 'gloss', adFeather: 'feather' };
  const ADJFMT = { adMatch: v => v + '%', adLight: v => v + '%', adExposure: v => (v > 0 ? '+' : '') + v.toFixed(2), adBlur: v => v.toFixed(2), adGrain: v => v.toFixed(1), adGloss: v => v + '%', adFeather: v => v.toFixed(1) };
  ADJ.forEach(id => bindSlider(id, () => { const it = S.items[S.sel]; return it ? it.adj[ADJKEY[id]] : 0; }, v => {
    const it = S.items[S.sel]; if (!it) return;
    it.adj[ADJKEY[id]] = v;
    if (id === 'adGrain') { it.adj.grainAuto = false; $('adGrainAuto').checked = false; }
    if (id === 'adFeather') it.texKey = '';
    markAdjust(it);
  }, ADJFMT[id]));
  $('adGrainAuto').addEventListener('change', e => { const it = S.items[S.sel]; if (!it) return; it.adj.grainAuto = e.target.checked; requestRender(true); });

  function syncItemFields() {
    const it = S.items[S.sel];
    $('itemProps').classList.toggle('hidden', !it);
    $('realismItem').classList.toggle('hidden', !it);
    if (!it) return;
    const set = (id, v) => { const el = $(id); if (document.activeElement !== el) el.value = v; };
    set('itName', it.name);
    set('itW', +it.w.toFixed(2)); set('itH', +it.h.toFixed(2)); set('itD', +it.d.toFixed(2));
    set('itMount', it.mount);
    set('itProt', +it.protrude.toFixed(2)); set('itGap', +it.gap.toFixed(2));
    set('itX', +(it.cx - it.w / 2).toFixed(1)); set('itY', +(it.cy - it.h / 2).toFixed(1)); set('itRot', +it.rot.toFixed(1));
    set('itTiltX', it.tiltX || 0); set('itTiltY', it.tiltY || 0);
    set('itSnap', it.snap);
    set('itHousing', it.housing); $('itHousingAuto').checked = it.housingAuto;
    ADJ.forEach(id => $(id)._sync());
    $('adGrainAuto').checked = it.adj.grainAuto;
  }

  function onItemField(id, fn) {
    $(id).addEventListener('input', () => {
      const it = S.items[S.sel]; if (!it) return;
      fn(it, $(id));
      markAdjust(it);
      renderItemList();
      requestRender(true);
    });
  }
  onItemField('itName', (it, el) => { it.name = el.value; });
  onItemField('itW', (it, el) => { const l = it.cx - it.w / 2; it.w = Math.max(1, num(el, it.w)); it.cx = l + it.w / 2; });
  onItemField('itH', (it, el) => { const t = it.cy - it.h / 2; it.h = Math.max(1, num(el, it.h)); it.cy = t + it.h / 2; });
  onItemField('itD', (it, el) => { it.d = Math.max(0, num(el, it.d)); if (it.mount === 'surface') { it.protrude = it.d; $('itProt').value = it.d; } });
  onItemField('itMount', (it, el) => {
    it.mount = el.value;
    if (it.mount === 'surface') { it.protrude = it.d; it.gap = 0; }
    else if (it.mount === 'flush') { it.protrude = Math.min(4, it.d); it.gap = 1.5; }
    else { it.protrude = -Math.min(15, Math.max(3, it.d * 0.1)); it.gap = 0; }
    $('itProt').value = it.protrude; $('itGap').value = it.gap;
  });
  onItemField('itProt', (it, el) => { it.protrude = num(el, 0); });
  onItemField('itGap', (it, el) => { it.gap = Math.max(0, num(el, 0)); });
  onItemField('itX', (it, el) => { it.cx = num(el, 0) + it.w / 2; });
  onItemField('itY', (it, el) => { it.cy = num(el, 0) + it.h / 2; });
  onItemField('itRot', (it, el) => { it.rot = num(el, 0); });
  onItemField('itTiltX', (it, el) => { it.tiltX = Img.clamp(num(el, 0), -80, 80); if (it.protrude <= 0.3 && it.tiltX) toast('La inclinación solo se aplica si el equipo sobresale: cambia el montaje a «Sobre la superficie».'); });
  onItemField('itTiltY', (it, el) => { it.tiltY = Img.clamp(num(el, 0), -80, 80); if (it.protrude <= 0.3 && it.tiltY) toast('La orientación solo se aplica si el equipo sobresale: cambia el montaje a «Sobre la superficie».'); });
  onItemField('itSnap', (it, el) => { it.snap = Math.max(0, num(el, 0)); applySnap(it); });
  onItemField('itHousing', (it, el) => { it.housing = el.value; it.housingAuto = false; $('itHousingAuto').checked = false; });
  onItemField('itHousingAuto', (it, el) => { it.housingAuto = el.checked; });
  $('itPreset').addEventListener('change', () => {
    const v = $('itPreset').value;
    $('itURow').classList.toggle('hidden', v !== '19');
    if (v === '19') apply19();
  });
  $('itU').addEventListener('input', apply19);
  function apply19() {
    const it = S.items[S.sel]; if (!it) return;
    const l = it.cx - it.w / 2, t = it.cy - it.h / 2;
    it.w = 482.6; it.h = +(num($('itU'), 1) * 44.45 - 0.8).toFixed(2);
    it.cx = l + it.w / 2; it.cy = t + it.h / 2;
    if (!it.snap) it.snap = 44.45;
    syncItemFields(); markAdjust(it); renderItemList(); requestRender(true);
  }
  $('btnEditItem').addEventListener('click', () => { const it = S.items[S.sel]; if (it) openEditor(it, false); });
  $('btnDelItem').addEventListener('click', () => {
    if (S.sel < 0) return;
    const btn = $('btnDelItem');
    if (!btn.dataset.armed) {
      btn.dataset.armed = '1';
      btn.textContent = '¿Seguro? Pulsa otra vez';
      setTimeout(() => { delete btn.dataset.armed; btn.textContent = '🗑 Quitar'; }, 3000);
      return;
    }
    delete btn.dataset.armed; btn.textContent = '🗑 Quitar';
    S.items.splice(S.sel, 1);
    S.sel = Math.min(S.sel, S.items.length - 1);
    renderItemList(); syncItemFields(); requestRender(true);
  });
  $('btnDupItem').addEventListener('click', () => {
    const it = S.items[S.sel]; if (!it) return;
    const c = { ...it, id: S.nextId++, name: it.name + ' (2)', mask: it.mask.slice(), quad: it.quad.map(p => p.slice()), adj: { ...it.adj }, cx: it.cx + it.w + 10, mips: null, tex: null, texKey: '',
      sideLR: it.sideLR ? { quad: it.sideLR.quad.map(p => p.slice()) } : null, sideTB: it.sideTB ? { quad: it.sideTB.quad.map(p => p.slice()) } : null };
    S.items.push(c);
    S.sel = S.items.length - 1;
    adjustItem(c);
    renderItemList(); syncItemFields(); requestRender(true);
  });
  $('fileItem').addEventListener('change', async e => { const f = e.target.files[0]; if (f) await addItemFromFile(f); e.target.value = ''; });

  function updateUI() {
    syncCalibUI();
    renderCalibInfo();
    updateCamLabel();
    renderItemList();
    syncItemFields();
  }

  /* ------------------------------ Editor de equipo ------------------------------ */
  const E = { it: null, isNew: false, mode: 'corners', view: { zoom: 1, x: 0, y: 0 }, drag: null, prev: null, tol: 32, brush: 20, cursor: null };
  const edCanvas = $('edCanvas');
  const ectx = edCanvas.getContext('2d');

  function openEditor(it, isNew) {
    E.it = it; E.isNew = isNew;
    E.backup = { mask: it.mask.slice(), quad: it.quad.map(p => p.slice()), w: it.w, h: it.h, d: it.d, name: it.name,
      src: it.src, srcCanvas: it.srcCanvas, sideLR: it.sideLR, sideTB: it.sideTB };
    E.sidePts = null;
    $('editor').classList.remove('hidden');
    $('edName').textContent = it.name;
    $('edNameIn').value = it.name;
    $('edW').value = it.w; $('edH').value = it.h; $('edD').value = it.d;
    if (isNew) { $('edW').value = ''; $('edH').value = ''; $('edD').value = ''; }
    setEdMode('corners');
    requestAnimationFrame(() => { resizeEd(); edFit(); rebuildPreview(); drawEd(); updateAspect(); if (isNew) $('edW').focus(); });
  }

  function closeEditor(apply) {
    const it = E.it;
    if (!apply) {
      Object.assign(it, { mask: E.backup.mask, quad: E.backup.quad, w: E.backup.w, h: E.backup.h, d: E.backup.d, name: E.backup.name,
        src: E.backup.src, srcCanvas: E.backup.srcCanvas, sideLR: E.backup.sideLR, sideTB: E.backup.sideTB });
      $('editor').classList.add('hidden');
      E.it = null;
      return;
    }
    const W = parseFloat($('edW').value), H = parseFloat($('edH').value), D = parseFloat($('edD').value);
    if (!(W > 0) || !(H > 0)) { toast('Indica el ancho y el alto reales del equipo (en mm, de su ficha técnica).'); $('edW').focus(); return; }
    it.w = W; it.h = H; it.d = D >= 0 ? D : 0;
    if (it.mount === 'surface') it.protrude = it.d; else if (it.mount === 'flush') it.protrude = Math.min(4, it.d);
    it.name = $('edNameIn').value.trim() || it.name;
    it.maskVer = (it.maskVer || 0) + 1;
    ['sideLR', 'sideTB'].forEach(k => { if (it[k]) it[k] = { quad: it[k].quad }; });
    if ((it.sideLR || it.sideTB) && !(it.d > 0)) toast('Para usar los laterales indica el fondo del equipo (mm).');
    it.aspectWarn = aspectMessage(it, W, H);
    it.texKey = '';
    makeThumb(it);
    if (E.isNew) {
      S.items.push(it);
      S.sel = S.items.length - 1;
      if (S.H) placeItem(it);
      if (!S.H) toast('Equipo añadido. Calibra la superficie (paso 3) para verlo en la foto.');
    }
    $('editor').classList.add('hidden');
    E.it = null;
    adjustItem(it);
    renderItemList(); syncItemFields(); setMode('move'); requestRender(true);
  }

  /** Avisa si la proporción de la foto no cuadra con las medidas indicadas. */
  function aspectMessage(it, W, H) {
    const q = it.quad, d = Geo.dist2;
    const top = d(q[0], q[1]), bot = d(q[3], q[2]), lef = d(q[0], q[3]), rig = d(q[1], q[2]);
    const frontal = Math.abs(top / bot - 1) < 0.08 && Math.abs(lef / rig - 1) < 0.08;
    if (!frontal) return '';
    const ap = (top + bot) / (lef + rig), ad = W / H;
    const diff = Math.abs(ap / ad - 1);
    if (diff < 0.1) return '';
    return `La foto sugiere una proporción ${ap.toFixed(2)}:1 y las medidas indican ${ad.toFixed(2)}:1 (${Math.round(diff * 100)} % de diferencia). Revisa las medidas o las esquinas de la cara frontal.`;
  }

  function updateAspect() {
    const it = E.it; if (!it) return;
    const W = parseFloat($('edW').value), H = parseFloat($('edH').value);
    const box = $('edAspect');
    const q = it.quad, d = Geo.dist2;
    const ap = (d(q[0], q[1]) + d(q[3], q[2])) / (d(q[0], q[3]) + d(q[1], q[2]));
    if (!(W > 0 && H > 0)) { box.innerHTML = `Proporción aparente en la foto: <b>${ap.toFixed(2)}:1</b>. Introduce las medidas reales.`; return; }
    const msg = aspectMessage(it, W, H);
    box.innerHTML = msg ? `⚠ ${escapeHtml(msg)} <button id="edUseAspect" class="ghost block">Calcular alto con la foto: ${fmt(W / ap, 1)} mm</button>` :
      `✅ Proporción coherente con la foto (${ap.toFixed(2)}:1 frente a ${(W / H).toFixed(2)}:1).`;
    const b = $('edUseAspect');
    if (b) b.addEventListener('click', () => { $('edH').value = (W / ap).toFixed(1); updateAspect(); });
  }
  ['edW', 'edH'].forEach(id => $(id).addEventListener('input', updateAspect));

  function resizeEd() {
    const r = edCanvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    edCanvas.width = Math.max(1, r.width * dpr); edCanvas.height = Math.max(1, r.height * dpr);
  }
  function edFit() {
    const r = edCanvas.getBoundingClientRect(), it = E.it;
    const z = Math.min(r.width / it.src.w, r.height / it.src.h) * 0.9;
    E.view = { zoom: z, x: (r.width - it.src.w * z) / 2, y: (r.height - it.src.h * z) / 2 };
  }
  const edS = p => [E.view.x + p[0] * E.view.zoom, E.view.y + p[1] * E.view.zoom];
  const edI = p => [(p[0] - E.view.x) / E.view.zoom, (p[1] - E.view.y) / E.view.zoom];

  function rebuildPreview() {
    const it = E.it;
    if (!E.prev || E.prev.width !== it.src.w || E.prev.height !== it.src.h) E.prev = Img.makeCanvas(it.src.w, it.src.h);
    const c = E.prev.getContext('2d');
    const id = c.createImageData(it.src.w, it.src.h);
    id.data.set(it.src.data);
    for (let i = 0; i < it.mask.length; i++) id.data[i * 4 + 3] = it.mask[i] < 128 ? Math.min(it.mask[i], 40) : it.mask[i];
    c.putImageData(id, 0, 0);
  }

  function drawEd() {
    const it = E.it; if (!it) return;
    const dpr = window.devicePixelRatio || 1;
    ectx.setTransform(1, 0, 0, 1, 0, 0);
    ectx.clearRect(0, 0, edCanvas.width, edCanvas.height);
    ectx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ectx.imageSmoothingQuality = 'high';
    ectx.drawImage(E.prev, E.view.x, E.view.y, it.src.w * E.view.zoom, it.src.h * E.view.zoom);
    const q = it.quad.map(edS);
    ectx.strokeStyle = '#ffcc33'; ectx.lineWidth = 2;
    ectx.beginPath(); q.forEach((p, i) => (i ? ectx.lineTo(p[0], p[1]) : ectx.moveTo(p[0], p[1]))); ectx.closePath(); ectx.stroke();
    const names = ['SI', 'SD', 'ID', 'II'];
    q.forEach((p, i) => {
      ectx.fillStyle = '#111'; ectx.strokeStyle = '#ffcc33'; ectx.lineWidth = 2;
      ectx.beginPath(); ectx.arc(p[0], p[1], 7, 0, Math.PI * 2); ectx.fill(); ectx.stroke();
      ectx.fillStyle = '#ffcc33'; ectx.font = '700 10px Segoe UI'; ectx.textAlign = 'center';
      ectx.fillText(names[i], p[0], p[1] - 12);
    });
    const sideCol = { sideLR: '#ff9f43', sideTB: '#d36bff' };
    ['sideLR', 'sideTB'].forEach(k => {
      const sd = it[k]; if (!sd) return;
      const sq = sd.quad.map(edS);
      ectx.strokeStyle = sideCol[k]; ectx.lineWidth = 2; ectx.setLineDash([5, 3]);
      ectx.beginPath(); sq.forEach((p, i) => (i ? ectx.lineTo(p[0], p[1]) : ectx.moveTo(p[0], p[1]))); ectx.closePath(); ectx.stroke();
      ectx.setLineDash([]);
      // índices 1 y 2 = arista que toca la cara frontal
      sq.forEach((p, i) => {
        ectx.fillStyle = sideCol[k]; ectx.beginPath(); ectx.arc(p[0], p[1], 5, 0, Math.PI * 2); ectx.fill();
        ectx.font = '700 10px Segoe UI'; ectx.textAlign = 'center'; ectx.fillText(i === 1 || i === 2 ? 'F' : 'T', p[0], p[1] - 9);
      });
    });
    if (E.sidePts && E.sidePts.length) {
      ectx.fillStyle = sideCol[E.mode] || '#fff';
      E.sidePts.map(edS).forEach(p => { ectx.beginPath(); ectx.arc(p[0], p[1], 5, 0, Math.PI * 2); ectx.fill(); });
    }
    if ((E.mode === 'erase' || E.mode === 'restore') && E.cursor) {
      ectx.strokeStyle = E.mode === 'erase' ? '#ff5252' : '#4cd964'; ectx.lineWidth = 1.5;
      ectx.beginPath(); ectx.arc(E.cursor[0], E.cursor[1], E.brush, 0, Math.PI * 2); ectx.stroke();
    }
  }

  function setEdMode(m) {
    E.mode = m;
    E.sidePts = m === 'sideLR' || m === 'sideTB' ? [] : null;
    if (E.sidePts) $('edSideInfo').textContent = 'Haz clic en las 4 esquinas del lateral, en cualquier orden.';
    else updateSideInfo();
    document.querySelectorAll('.edmode').forEach(b => b.classList.toggle('active', b.dataset.ed === m));
    edCanvas.style.cursor = m === 'corners' ? 'default' : m === 'wand' || E.sidePts ? 'crosshair' : 'none';
  }
  document.querySelectorAll('.edmode').forEach(b => b.addEventListener('click', () => setEdMode(b.dataset.ed)));

  function edBrush(sp, last) {
    const it = E.it, p = edI(sp), r = E.brush / E.view.zoom;
    const val = E.mode === 'erase' ? 0 : 255;
    const stamp = (cx, cy) => {
      const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(it.src.w - 1, Math.ceil(cx + r));
      const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(it.src.h - 1, Math.ceil(cy + r));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) it.mask[y * it.src.w + x] = val;
    };
    if (last) {
      const q = edI(last), d = Geo.dist2(p, q), n = Math.max(1, Math.ceil(d / (r * 0.4)));
      for (let k = 1; k <= n; k++) stamp(q[0] + (p[0] - q[0]) * k / n, q[1] + (p[1] - q[1]) * k / n);
    } else stamp(p[0], p[1]);
  }

  let edRaf = 0;
  const edRedraw = rebuild => { if (rebuild) E.needPrev = true; if (edRaf) return; edRaf = requestAnimationFrame(() => { edRaf = 0; if (E.needPrev) { rebuildPreview(); E.needPrev = false; } drawEd(); }); };

  edCanvas.addEventListener('contextmenu', e => e.preventDefault());
  edCanvas.addEventListener('pointerdown', e => {
    const r = edCanvas.getBoundingClientRect(), sp = [e.clientX - r.left, e.clientY - r.top];
    edCanvas.setPointerCapture(e.pointerId);
    if (e.button === 1 || e.button === 2) { E.drag = { type: 'pan', sp, x: E.view.x, y: E.view.y }; return; }
    // las esquinas siempre se pueden arrastrar
    const hi = E.it.quad.findIndex(p => Geo.dist2(edS(p), sp) < 12);
    if (hi >= 0 && !E.sidePts) { E.drag = { type: 'corner', i: hi }; return; }
    if (!E.sidePts) for (const k of ['sideLR', 'sideTB']) {
      const sd = E.it[k]; if (!sd) continue;
      const si = sd.quad.findIndex(p => Geo.dist2(edS(p), sp) < 10);
      if (si >= 0) { E.drag = { type: 'side', k, i: si }; return; }
    }
    if (E.sidePts) {
      E.sidePts.push(edI(sp));
      if (E.sidePts.length === 4) {
        E.it[E.mode] = { quad: orderSide(E.mode, E.sidePts) };
        setEdMode('corners');
      }
      edRedraw(false);
      return;
    }
    if (E.mode === 'wand') {
      const p = edI(sp);
      Img.wandRemove(E.it.src.data, E.it.mask, E.it.src.w, E.it.src.h, p[0], p[1], E.tol);
      edRedraw(true);
    } else if (E.mode === 'erase' || E.mode === 'restore') {
      E.drag = { type: 'brush', last: sp }; edBrush(sp, null); edRedraw(true);
    } else {
      E.drag = { type: 'pan', sp, x: E.view.x, y: E.view.y };
    }
  });
  edCanvas.addEventListener('pointermove', e => {
    const r = edCanvas.getBoundingClientRect(), sp = [e.clientX - r.left, e.clientY - r.top];
    E.cursor = sp;
    const d = E.drag;
    if (!d) { edRedraw(false); return; }
    if (d.type === 'pan') { E.view.x = d.x + sp[0] - d.sp[0]; E.view.y = d.y + sp[1] - d.sp[1]; edRedraw(false); }
    else if (d.type === 'corner') {
      const p = edI(sp);
      E.it.quad[d.i] = [Img.clamp(p[0], 0, E.it.src.w), Img.clamp(p[1], 0, E.it.src.h)];
      edRedraw(false); updateAspect();
    } else if (d.type === 'brush') { edBrush(sp, d.last); d.last = sp; edRedraw(true); }
    else if (d.type === 'side') { const p = edI(sp); E.it[d.k].quad[d.i] = [Img.clamp(p[0], 0, E.it.src.w), Img.clamp(p[1], 0, E.it.src.h)]; edRedraw(false); }
  });
  edCanvas.addEventListener('pointerup', () => {
    if (E.drag && E.drag.type === 'corner') { E.it.quad = Geo.sortQuad(E.it.quad); updateAspect(); edRedraw(false); }
    E.drag = null;
  });
  edCanvas.addEventListener('wheel', e => {
    e.preventDefault();
    const r = edCanvas.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
    const f = Math.exp(-e.deltaY * 0.0015), z = Img.clamp(E.view.zoom * f, 0.02, 30), k = z / E.view.zoom;
    E.view.x = sx - (sx - E.view.x) * k; E.view.y = sy - (sy - E.view.y) * k; E.view.zoom = z;
    edRedraw(false);
  }, { passive: false });

  bindSlider('edTol', () => E.tol, v => { E.tol = v; }, v => v);
  bindSlider('edBrush', () => E.brush, v => { E.brush = v; }, v => v + ' px');
  $('edAuto').addEventListener('click', () => {
    const it = E.it;
    it.mask.fill(255);
    Img.autoRemoveBackground(it.src.data, it.mask, it.src.w, it.src.h, E.tol);
    cornersFromMask();
    edRedraw(true);
  });
  $('edLargest').addEventListener('click', () => { Img.fillHoles(E.it.mask, E.it.src.w, E.it.src.h); cornersFromMask(); edRedraw(true); });
  $('edReset').addEventListener('click', () => { E.it.mask.fill(255); edRedraw(true); });
  function cornersFromMask() {
    const it = E.it, q = Img.maskQuad(it.mask, it.src.w, it.src.h);
    if (!q) { toast('El recorte ha eliminado todo. Baja la tolerancia.'); it.mask.fill(255); return; }
    it.quad = q;
    updateAspect();
  }

  /** Ordena las 4 esquinas de un lateral: la arista más cercana a la cara frontal es la delantera. */
  function orderSide(kind, pts) {
    const q = E.it.quad;
    const segD = (p, a, b) => {
      const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy || 1;
      const t = Img.clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L, 0, 1);
      return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
    };
    const dq = p => Math.min(...q.map((a, i) => segD(p, a, q[(i + 1) % 4])));
    const s = pts.slice().sort((a, b) => dq(a) - dq(b));
    const key = kind === 'sideLR' ? 1 : 0;   // LR: ordenar por y; TB: por x
    const front = s.slice(0, 2).sort((a, b) => a[key] - b[key]);
    const back = s.slice(2).sort((a, b) => a[key] - b[key]);
    return [back[0], front[0], front[1], back[1]];
  }

  function updateSideInfo() {
    const it = E.it; if (!it) return;
    const l = [];
    if (it.sideLR) l.push('◧ Lateral marcado');
    if (it.sideTB) l.push('⬒ Cara superior/inferior marcada');
    $('edSideInfo').textContent = l.length ? l.join(' · ') + '. Se usarán en los dos lados opuestos.' : '';
  }

  function rotateItemPhoto(dir) {
    const it = E.it;
    const r = Img.rotateRGBA(it.src, it.mask, dir);
    it.src = r.src; it.mask = r.mask;
    it.quad = Geo.sortQuad(it.quad.map(r.mapPt));
    ['sideLR', 'sideTB'].forEach(k => { if (it[k]) it[k] = { quad: it[k].quad.map(r.mapPt) }; });
    const c = Img.makeCanvas(it.src.w, it.src.h);
    const id = c.getContext('2d').createImageData(it.src.w, it.src.h);
    id.data.set(it.src.data); c.getContext('2d').putImageData(id, 0, 0);
    it.srcCanvas = c;
    edFit(); edRedraw(true); updateAspect();
  }
  $('edCornersAuto').addEventListener('click', () => { cornersFromMask(); edRedraw(false); });
  $('edRotL').addEventListener('click', () => rotateItemPhoto(-1));
  $('edRotR').addEventListener('click', () => rotateItemPhoto(1));
  $('edFlip').addEventListener('click', () => rotateItemPhoto(0));
  $('edSidesClear').addEventListener('click', () => { E.it.sideLR = null; E.it.sideTB = null; updateSideInfo(); edRedraw(false); });
  $('edCornersFull').addEventListener('click', () => { const it = E.it; it.quad = [[0, 0], [it.src.w, 0], [it.src.w, it.src.h], [0, it.src.h]]; updateAspect(); edRedraw(false); });
  $('edDone').addEventListener('click', () => closeEditor(true));
  $('edClose').addEventListener('click', () => closeEditor(false));

  /* ------------------------------ Exportación ------------------------------ */
  function renderFull(annotate) {
    const c = Img.makeCanvas(S.bg.w, S.bg.h);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    renderScene(ctx, 1, S.orig, S.occl, annotate);
    return c;
  }
  function requireScene() {
    if (!S.bg) { toast('Carga primero una foto.'); return false; }
    return true;
  }
  async function busy(fn) {
    document.body.style.cursor = 'progress';
    toast('Generando a resolución completa…', 60000);
    await new Promise(r => setTimeout(r, 30));
    try { await fn(); toast('Exportación lista.'); }
    catch (err) { console.error(err); toast('Error al exportar: ' + err.message, 6000); }
    finally { document.body.style.cursor = ''; }
  }

  $('btnExpJpg').addEventListener('click', () => requireScene() && busy(async () => {
    const c = renderFull($('expAnnot').checked);
    await download(await canvasBlob(c, 'image/jpeg', 0.93), safeName($('projTitle').value) + '.jpg');
  }));

  function comparisonCanvas(after) {
    const w = S.bg.w, h = S.bg.h, gap = Math.round(w * 0.015), head = Math.round(h * 0.07);
    const c = Img.makeCanvas(w * 2 + gap, h + head);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#111'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(S.orig, 0, head);
    ctx.drawImage(after, w + gap, head);
    ctx.fillStyle = '#fff';
    ctx.font = `700 ${Math.round(head * 0.45)}px Segoe UI, Arial`;
    ctx.textBaseline = 'middle';
    ctx.fillText('ANTES · situación actual', gap, head / 2);
    ctx.fillText('DESPUÉS · simulación de integración', w + gap * 2, head / 2);
    return c;
  }
  $('btnExpCmp').addEventListener('click', () => requireScene() && busy(async () => {
    const c = comparisonCanvas(renderFull($('expAnnot').checked));
    await download(await canvasBlob(c, 'image/jpeg', 0.9), safeName($('projTitle').value) + '_antes_despues.jpg');
  }));

  function toJpegData(canvas, maxSide) {
    const s = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
    const c = s < 1 ? Img.makeCanvas(canvas.width * s, canvas.height * s) : canvas;
    if (s < 1) { const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(canvas, 0, 0, c.width, c.height); }
    return { data: c.toDataURL('image/jpeg', 0.9), w: c.width, h: c.height };
  }

  $('btnExpPdf').addEventListener('click', () => requireScene() && busy(async () => {
    if (!window.jspdf) throw new Error('No se encontró jsPDF (vendor/jspdf.umd.min.js).');
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const PW = 297, PH = 210, M = 12;
    const title = $('projTitle').value || 'Integración de equipo';
    const notes = $('projNotes').value.trim();
    const date = new Date().toLocaleDateString('es-ES', { day: '2-digit', month: 'long', year: 'numeric' });
    const after = renderFull($('expAnnot').checked);
    const checks = computeChecks();

    const header = (sub) => {
      doc.setFillColor(20, 26, 34); doc.rect(0, 0, PW, 18, 'F');
      doc.setFillColor(47, 140, 255); doc.rect(0, 18, PW, 0.8, 'F');
      doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
      doc.text(title, M, 11.5);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
      doc.text(`${sub}  ·  ${date}`, PW - M, 11.5, { align: 'right' });
    };
    const footer = (n) => {
      doc.setTextColor(120); doc.setFontSize(7.5);
      doc.text('Simulación visual de integración: imagen orientativa generada a partir de la foto real, las medidas de ficha técnica y la calibración. No sustituye a una verificación dimensional.', M, PH - 6);
      doc.text(`Página ${n}`, PW - M, PH - 6, { align: 'right' });
    };
    const fitImg = (img, x, y, w, h) => {
      const k = Math.min(w / img.w, h / img.h);
      const iw = img.w * k, ih = img.h * k;
      doc.addImage(img.data, 'JPEG', x + (w - iw) / 2, y + (h - ih) / 2, iw, ih);
      return [x + (w - iw) / 2, y + (h - ih) / 2, iw, ih];
    };

    // Página 1: resultado
    header('Simulación de integración');
    const a1 = toJpegData(after, 3000);
    const r1 = fitImg(a1, M, 24, PW - 2 * M, PH - 24 - 16);
    doc.setDrawColor(60); doc.rect(r1[0], r1[1], r1[2], r1[3]);
    footer(1);

    // Página 2: antes / después + tabla
    doc.addPage(); header('Antes / Después');
    const colW = (PW - 2 * M - 6) / 2, imgH = 92;
    const b = toJpegData(S.orig, 1800), a2 = toJpegData(after, 1800);
    doc.setTextColor(40); doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
    doc.text('ANTES · situación actual', M, 26);
    doc.text('DESPUÉS · simulación', M + colW + 6, 26);
    const rb = fitImg(b, M, 28, colW, imgH); doc.rect(rb[0], rb[1], rb[2], rb[3]);
    const ra = fitImg(a2, M + colW + 6, 28, colW, imgH); doc.rect(ra[0], ra[1], ra[2], ra[3]);

    let y = 28 + imgH + 9;
    doc.setFontSize(10); doc.setFont('helvetica', 'bold'); doc.setTextColor(30);
    doc.text('Equipos integrados', M, y); y += 4;
    const cols = [M, M + 60, M + 115, M + 160];
    doc.setFillColor(235, 239, 245); doc.rect(M, y, PW - 2 * M, 6, 'F');
    doc.setFontSize(8.5); doc.text('Equipo', cols[0] + 2, y + 4.2); doc.text('Medidas (An × Al × Fo)', cols[1] + 2, y + 4.2); doc.text('Montaje', cols[2] + 2, y + 4.2); doc.text('Comprobación de encaje', cols[3] + 2, y + 4.2);
    y += 6;
    doc.setFont('helvetica', 'normal');
    const mountName = { flush: 'Empotrado / enrasado', surface: 'Sobre superficie', recess: 'Rehundido' };
    S.items.forEach(it => {
      const c = checks.find(x => x.id === it.id);
      const txt = c ? c.lines.map(l => l.replace(/[⛔✅⚠]\s?/g, '')).join(' ') : '';
      const lines = doc.splitTextToSize(txt, PW - M - cols[3] - 4);
      const rowH = Math.max(6, lines.length * 3.6 + 2.4);
      if (y + rowH > PH - 14) { footer(doc.getNumberOfPages()); doc.addPage(); header('Antes / Después (cont.)'); y = 26; }
      const st = c ? c.status : '';
      doc.setFillColor(...(st === 'bad' ? [239, 83, 80] : st === 'warn' ? [242, 179, 61] : [47, 191, 113]));
      doc.rect(M, y + 0.6, 1.4, rowH - 1.2, 'F');
      doc.setTextColor(30);
      doc.text(doc.splitTextToSize(it.name, 55), cols[0] + 3, y + 4);
      doc.text(`${fmt(it.w, 1)} × ${fmt(it.h, 1)} × ${fmt(it.d, 1)} mm`, cols[1] + 2, y + 4);
      doc.text(`${mountName[it.mount]} (${it.protrude >= 0 ? 'sobresale' : 'rehundido'} ${fmt(Math.abs(it.protrude), 1)} mm)`, cols[2] + 2, y + 4, { maxWidth: 44 });
      doc.text(lines, cols[3] + 2, y + 4);
      doc.setDrawColor(220); doc.line(M, y + rowH, PW - M, y + rowH);
      y += rowH;
    });
    if (notes) {
      y += 6;
      if (y > PH - 30) { footer(doc.getNumberOfPages()); doc.addPage(); header('Notas'); y = 28; }
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.text('Notas', M, y); y += 5;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
      doc.text(doc.splitTextToSize(notes, PW - 2 * M), M, y);
    }
    y += 4;
    doc.setFontSize(7.5); doc.setTextColor(110);
    const calib = `Calibración: referencia de ${fmt(S.ref.W, 1)} × ${fmt(S.ref.H, 1)} mm${S.zone.depth ? ` · fondo disponible ${fmt(S.zone.depth)} mm` : ''} · foto ${S.bg.w}×${S.bg.h} px.`;
    doc.text(calib, M, Math.min(PH - 11, Math.max(y, PH - 11)));
    footer(doc.getNumberOfPages());
    await download(doc.output('blob'), safeName(title) + '.pdf');
  }));

  /* ------------------------------ Proyecto ------------------------------ */
  function maskToPNG(mask, w, h) {
    const c = Img.makeCanvas(w, h), ctx = c.getContext('2d');
    const id = ctx.createImageData(w, h);
    for (let i = 0; i < mask.length; i++) { id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = mask[i]; id.data[i * 4 + 3] = 255; }
    ctx.putImageData(id, 0, 0);
    return c.toDataURL('image/png');
  }
  async function saveProject() {
    if (!S.bg) { toast('No hay nada que guardar todavía.'); return; }
    const proj = {
      app: 'integrador-visual', version: 1,
      title: $('projTitle').value, notes: $('projNotes').value,
      bg: { name: S.bg.name, data: S.orig.toDataURL('image/jpeg', 0.95) },
      ref: { pts: S.ref.pts, W: S.ref.W, H: S.ref.H, preset: $('refPreset').value, U: num($('refU'), 10) },
      calib: { method: S.calib.method, knownAspect: S.calib.knownAspect, cotas: S.calib.cotas.map(c => ({ a: c.a, b: c.b, mm: c.mm, label: c.label })) },
      ruler: S.ruler,
      zone: { useRef: S.zone.useRef, pts: S.zone.pts, depth: S.zone.depth },
      cam: S.cam, light: S.light,
      occl: S.occlHas ? S.occl.toDataURL('image/png') : null,
      items: S.items.map(it => ({
        name: it.name, src: it.srcCanvas.toDataURL('image/jpeg', 0.95), mask: maskToPNG(it.mask, it.src.w, it.src.h),
        quad: it.quad, w: it.w, h: it.h, d: it.d, mount: it.mount, protrude: it.protrude, gap: it.gap,
        cx: it.cx, cy: it.cy, rot: it.rot, snap: it.snap, tiltX: it.tiltX || 0, tiltY: it.tiltY || 0,
        sideLR: it.sideLR ? { quad: it.sideLR.quad } : null, sideTB: it.sideTB ? { quad: it.sideTB.quad } : null, housing: it.housing, housingAuto: it.housingAuto, adj: it.adj,
      })),
    };
    try { await download(new Blob([JSON.stringify(proj)], { type: 'application/json' }), safeName(proj.title) + '.ivproj.json'); toast('Proyecto guardado.'); }
    catch (err) { toast('No se pudo guardar: ' + err.message, 6000); }
  }
  async function openProject(file) {
    const proj = JSON.parse(await file.text());
    if (proj.app !== 'integrador-visual') throw new Error('No es un proyecto de Integrador Visual');
    $('projTitle').value = proj.title || ''; $('projNotes').value = proj.notes || '';
    const bgBlob = await (await fetch(proj.bg.data)).blob();
    S.items = []; S.sel = -1;
    Object.assign(S.ref, { pts: proj.ref.pts, W: proj.ref.W, H: proj.ref.H });
    $('refW').value = proj.ref.W; $('refH').value = proj.ref.H; $('refPreset').value = proj.ref.preset || 'custom'; $('refU').value = proj.ref.U || 10;
    $('refURow').classList.toggle('hidden', !(($('refPreset').value) in REF_PRESETS));
    Object.assign(S.zone, proj.zone);
    S.calib.method = proj.calib ? proj.calib.method : 'dims';
    S.calib.cotas = proj.calib ? proj.calib.cotas : [];
    S.calib.knownAspect = proj.calib && proj.calib.knownAspect || ''; $('refAspect').value = S.calib.knownAspect;
    S.ruler = proj.ruler || null;
    $('zoneUseRef').checked = S.zone.useRef; $('zoneDepth').value = S.zone.depth || '';
    Object.assign(S.cam, proj.cam); $('camAuto').checked = S.cam.auto; $('camF').disabled = S.cam.auto; $('camF')._sync();
    Object.assign(S.light, proj.light); ['lgAz', 'lgEl', 'lgOp', 'lgSoft'].forEach(id => $(id)._sync());
    await loadBackground(new File([bgBlob], proj.bg.name || 'foto.jpg'), true);
    if (proj.occl) {
      const im = await Img.loadImage(proj.occl);
      S.occl.getContext('2d').drawImage(im, 0, 0, S.occl.width, S.occl.height);
      S.occlHas = true; S.occlTintDirty = true;
    }
    for (const p of proj.items) {
      const im = await Img.loadImage(p.src);
      const c = Img.imageToCanvas(im, ITEM_MAX);
      const it = newItem(c, p.name);
      const mi = await Img.loadImage(p.mask);
      const mc = Img.makeCanvas(it.src.w, it.src.h);
      mc.getContext('2d').drawImage(mi, 0, 0, it.src.w, it.src.h);
      const md = mc.getContext('2d').getImageData(0, 0, it.src.w, it.src.h).data;
      for (let i = 0; i < it.mask.length; i++) it.mask[i] = md[i * 4];
      Object.assign(it, { quad: p.quad, w: p.w, h: p.h, d: p.d, mount: p.mount, protrude: p.protrude, gap: p.gap, cx: p.cx, cy: p.cy, rot: p.rot, snap: p.snap, tiltX: p.tiltX || 0, tiltY: p.tiltY || 0, sideLR: p.sideLR || null, sideTB: p.sideTB || null, housing: p.housing, housingAuto: p.housingAuto, adj: { ...defaultAdj(), ...p.adj }, placed: true });
      it.aspectWarn = aspectMessage(it, it.w, it.h);
      makeThumb(it);
      S.items.push(it);
    }
    S.sel = S.items.length ? 0 : -1;
    S.items.forEach(adjustItem);
    updateUI(); setMode('move'); requestRender(true);
    toast('Proyecto abierto.');
  }
  $('btnSaveProj').addEventListener('click', saveProject);
  $('fileProj').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try { await openProject(f); } catch (err) { console.error(err); toast('No se pudo abrir: ' + err.message, 6000); }
  });

  /* ------------------------------ Ejemplo ------------------------------ */
  // Solo si la página incluye window.IV_SAMPLE (versión web publicada).
  async function loadSample() {
    const smp = window.IV_SAMPLE;
    if (!smp) return;
    $('projTitle').value = 'Ejemplo: pantalla en armario';
    const bgBlob = await (await fetch(smp.bg)).blob();
    S.items = []; S.sel = -1;
    await loadBackground(new File([bgBlob], 'armario_ejemplo.jpg'));
    S.calib.method = 'dims'; syncCalibUI();
    S.ref.pts = smp.ref.map(p => p.slice()); S.ref.W = 600; S.ref.H = 400;
    $('refW').value = 600; $('refH').value = 400;
    S.zone.depth = 90; $('zoneDepth').value = 90;
    computeH();
    const img = await Img.loadImage(smp.item);
    const it = newItem(Img.imageToCanvas(img, ITEM_MAX), 'Pantalla (ejemplo)');
    Img.autoRemoveBackground(it.src.data, it.mask, it.src.w, it.src.h, 32);
    Img.fillHoles(it.mask, it.src.w, it.src.h);
    const bb = Img.maskBBox(it.mask, it.src.w, it.src.h);
    if (bb) it.quad = [[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]]];
    Object.assign(it, { w: 300, h: 200, d: 70, maskVer: 1 });
    makeThumb(it);
    S.items.push(it); S.sel = 0;
    placeItem(it);
    adjustItem(it);
    updateUI(); setMode('move'); requestRender(true);
    toast('Ejemplo cargado: arrastra la pantalla, cambia el montaje o el ancho y mira la comprobación.', 6000);
  }
  if (window.IV_SAMPLE) {
    $('btnSample').classList.remove('hidden');
    $('btnSample').addEventListener('click', () => loadSample().catch(err => toast('No se pudo cargar el ejemplo: ' + err.message)));
  }

  /* ------------------------------ Inicio ------------------------------ */
  window.addEventListener('resize', () => { resizeView(); if (!$('editor').classList.contains('hidden')) { resizeEd(); drawEd(); } });
  resizeView();
  updateUI();
  setMode('move');
  setHint('Carga una foto para empezar.');

  // API mínima para pruebas automatizadas y depuración
  window.IV = { S, E, loadBackground, addItemFromFile, computeH, requestRender, renderFull, computeChecks, closeEditor, adjustItem, setMode, fitView, finishMarking, placeItem };
})();
