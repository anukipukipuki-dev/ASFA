/* =========================================================================
 * Procesado de imagen: recorte de fondo, rectificación, ajuste fotométrico,
 * estadísticas del entorno y warp en perspectiva con antialiasing.
 * ========================================================================= */
'use strict';

const Img = (() => {
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  /** Carga un File/Blob/dataURL como HTMLImageElement. */
  function loadImage(src) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('No se pudo leer la imagen'));
      if (src instanceof Blob) {
        const url = URL.createObjectURL(src);
        img.onload = () => { URL.revokeObjectURL(url); res(img); };
        img.src = url;
      } else img.src = src;
    });
  }

  /** Dibuja una imagen en un canvas limitando el lado mayor. */
  function imageToCanvas(img, maxSide) {
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    const s = Math.min(1, maxSide / Math.max(w, h));
    const c = makeCanvas(w * s, h * s);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  }

  /* --------------------------- Recorte de fondo --------------------------- */
  function colorDist(d, i, r, g, b) {
    const dr = d[i] - r, dg = d[i + 1] - g, db = d[i + 2] - b;
    return Math.sqrt(dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11) * 1.7;
  }

  /**
   * Relleno por inundación desde semillas: marca como fondo (mask=0) los píxeles
   * conectados de color parecido a la referencia. Acepta degradados suaves.
   */
  function floodRemove(data, mask, w, h, seeds, ref, tol) {
    const visited = new Uint8Array(w * h);
    const queue = new Int32Array(w * h);
    let qh = 0, qt = 0;
    const [rr, rg, rb] = ref;
    for (const s of seeds) {
      if (visited[s]) continue;
      if (colorDist(data, s * 4, rr, rg, rb) < tol) { visited[s] = 1; queue[qt++] = s; }
    }
    const localTol = Math.max(6, tol * 0.4);
    while (qh < qt) {
      const p = queue[qh++];
      mask[p] = 0;
      const x = p % w, y = (p / w) | 0;
      const pi = p * 4;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const q of nb) {
        if (q < 0 || visited[q]) continue;
        const qi = q * 4;
        const dRef = colorDist(data, qi, rr, rg, rb);
        const dLoc = colorDist(data, qi, data[pi], data[pi + 1], data[pi + 2]);
        if (dRef < tol || (dLoc < localTol && dRef < tol * 2.2)) { visited[q] = 1; queue[qt++] = q; }
      }
    }
    return qt;
  }

  function autoRemoveBackground(data, mask, w, h, tol) {
    const rs = [], gs = [], bs = [], seeds = [];
    const push = (x, y) => { const p = y * w + x; seeds.push(p); rs.push(data[p * 4]); gs.push(data[p * 4 + 1]); bs.push(data[p * 4 + 2]); };
    for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
    for (let y = 1; y < h - 1; y++) { push(0, y); push(w - 1, y); }
    const med = a => { const s = a.slice().sort((p, q) => p - q); return s[s.length >> 1]; };
    const ref = [med(rs), med(gs), med(bs)];
    return floodRemove(data, mask, w, h, seeds, ref, tol);
  }

  function wandRemove(data, mask, w, h, x, y, tol) {
    x = clamp(Math.round(x), 0, w - 1); y = clamp(Math.round(y), 0, h - 1);
    const p = y * w + x;
    const ref = [data[p * 4], data[p * 4 + 1], data[p * 4 + 2]];
    return floodRemove(data, mask, w, h, [p], ref, tol);
  }

  /** Conserva solo el componente conexo más grande del primer plano. */
  function keepLargest(mask, w, h) {
    const label = new Int32Array(w * h);
    const queue = new Int32Array(w * h);
    let cur = 0, bestL = 0, bestN = 0;
    for (let i = 0; i < w * h; i++) {
      if (mask[i] < 128 || label[i]) continue;
      cur++;
      let qh = 0, qt = 0, n = 0;
      queue[qt++] = i; label[i] = cur;
      while (qh < qt) {
        const p = queue[qh++]; n++;
        const x = p % w, y = (p / w) | 0;
        const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
        for (const q of nb) if (q >= 0 && !label[q] && mask[q] >= 128) { label[q] = cur; queue[qt++] = q; }
      }
      if (n > bestN) { bestN = n; bestL = cur; }
    }
    for (let i = 0; i < w * h; i++) if (label[i] !== bestL) mask[i] = 0;
    // Rellena huecos interiores (zonas de fondo no conectadas con el borde)
    const outside = new Uint8Array(w * h);
    let qh = 0, qt = 0;
    const seed = p => { if (!outside[p] && mask[p] < 128) { outside[p] = 1; queue[qt++] = p; } };
    for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
    while (qh < qt) {
      const p = queue[qh++];
      const x = p % w, y = (p / w) | 0;
      if (x > 0) seed(p - 1); if (x < w - 1) seed(p + 1); if (y > 0) seed(p - w); if (y < h - 1) seed(p + w);
    }
    return { outside, bestN };
  }

  function fillHoles(mask, w, h) {
    const { outside } = keepLargest(mask, w, h);
    for (let i = 0; i < w * h; i++) if (!outside[i]) mask[i] = 255;
  }

  function maskBBox(mask, w, h) {
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x] >= 128) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (x1 < 0) return null;
    return [x0, y0, x1 + 1, y1 + 1];
  }

  /**
   * Cuadrilátero que mejor encaja con el recorte: el de mayor área inscrito en
   * la envolvente convexa. Si la foto es frontal (casi un rectángulo alineado),
   * devuelve la caja envolvente, que respeta mejor las esquinas redondeadas.
   */
  function maskQuad(mask, w, h) {
    const bb = maskBBox(mask, w, h);
    if (!bb) return null;
    const pts = [];
    const st = Math.max(1, Math.round(Math.max(w, h) / 600));
    for (let y = 0; y < h; y += st) {
      let x0 = -1, x1 = -1;
      for (let x = 0; x < w; x++) if (mask[y * w + x] >= 128) { if (x0 < 0) x0 = x; x1 = x; }
      if (x0 >= 0) { pts.push([x0, y], [x1 + 1, y + st]); }
    }
    for (let x = 0; x < w; x += st) {
      let y0 = -1, y1 = -1;
      for (let y = 0; y < h; y++) if (mask[y * w + x] >= 128) { if (y0 < 0) y0 = y; y1 = y; }
      if (y0 >= 0) { pts.push([x, y0], [x + st, y1 + 1]); }
    }
    const hull = Geo.convexHull(pts);
    const n = hull.length;
    const bbQuad = [[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]]];
    if (n < 4) return bbQuad;
    const area = idx => Math.abs(Geo.polyArea(idx.map(i => hull[i])));
    // arranque: puntos extremos en las 4 diagonales
    const ext = [p => -p[0] - p[1], p => p[0] - p[1], p => p[0] + p[1], p => -p[0] + p[1]];
    let idx = ext.map(f => { let b = 0; hull.forEach((p, i) => { if (f(p) > f(hull[b])) b = i; }); return b; });
    let best = area(idx);
    for (let it = 0; it < 8; it++) {
      let improved = false;
      for (let k = 0; k < 4; k++) {
        for (let j = 0; j < n; j++) {
          if (idx.includes(j)) continue;
          const cand = idx.slice(); cand[k] = j;
          const q = cand.map(i => hull[i]);
          if (!Geo.isConvexQuad(Geo.sortQuad(q))) continue;
          const a = area(cand);
          if (a > best + 1e-6) { best = a; idx = cand; improved = true; }
        }
      }
      if (!improved) break;
    }
    const quad = Geo.sortQuad(idx.map(i => hull[i]));
    const bbArea = (bb[2] - bb[0]) * (bb[3] - bb[1]);
    return best / bbArea > 0.965 ? bbQuad : quad;
  }

  /** Gira 90° (dir=1 horario, -1 antihorario) o refleja (dir=0) un RGBA + máscara. */
  function rotateRGBA(src, mask, dir) {
    const { w, h, data } = src;
    const nw = dir === 0 ? w : h, nh = dir === 0 ? h : w;
    const out = new Uint8ClampedArray(data.length), om = new Uint8Array(mask.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let nx, ny;
      if (dir === 1) { nx = h - 1 - y; ny = x; }
      else if (dir === -1) { nx = y; ny = w - 1 - x; }
      else { nx = w - 1 - x; ny = y; }
      const i = y * w + x, j = ny * nw + nx;
      om[j] = mask[i];
      out[j * 4] = data[i * 4]; out[j * 4 + 1] = data[i * 4 + 1]; out[j * 4 + 2] = data[i * 4 + 2]; out[j * 4 + 3] = data[i * 4 + 3];
    }
    const mapPt = ([x, y]) => dir === 1 ? [h - y, x] : dir === -1 ? [y, w - x] : [w - x, y];
    return { src: { w: nw, h: nh, data: out }, mask: om, mapPt };
  }

  /* ----------------------------- Desenfoque ------------------------------ */
  function boxBlurChannel(src, dst, w, h, r, stride, off) {
    // horizontal + vertical, radio entero r
    const tmp = new Float32Array(w * h);
    const k = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += src[(y * w + clamp(x, 0, w - 1)) * stride + off];
      for (let x = 0; x < w; x++) {
        tmp[y * w + x] = acc / k;
        acc += src[(y * w + clamp(x + r + 1, 0, w - 1)) * stride + off] - src[(y * w + clamp(x - r, 0, w - 1)) * stride + off];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[clamp(y, 0, h - 1) * w + x];
      for (let y = 0; y < h; y++) {
        dst[(y * w + x) * stride + off] = acc / k;
        acc += tmp[clamp(y + r + 1, 0, h - 1) * w + x] - tmp[clamp(y - r, 0, h - 1) * w + x];
      }
    }
  }

  /** Desenfoque aproximadamente gaussiano (sigma en px) sobre RGBA premultiplicado. */
  function blurRGBA(data, w, h, sigma) {
    if (sigma < 0.25) return data;
    // premultiplicar para no arrastrar color del fondo transparente
    const f = new Float32Array(data.length);
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3] / 255;
      f[i] = data[i] * a; f[i + 1] = data[i + 1] * a; f[i + 2] = data[i + 2] * a; f[i + 3] = data[i + 3];
    }
    if (sigma < 0.8) {
      // mezcla con un 3x3
      const g = new Float32Array(f.length);
      for (let c = 0; c < 4; c++) boxBlurChannel(f, g, w, h, 1, 4, c);
      const m = clamp((sigma - 0.25) / 0.55, 0, 1);
      for (let i = 0; i < f.length; i++) f[i] = f[i] * (1 - m) + g[i] * m;
    } else {
      const r = Math.max(1, Math.round(Math.sqrt((12 * sigma * sigma) / 3 + 1) / 2 - 0.5));
      const g = new Float32Array(f.length);
      for (let pass = 0; pass < 3; pass++) {
        for (let c = 0; c < 4; c++) boxBlurChannel(pass % 2 ? g : f, pass % 2 ? f : g, w, h, r, 4, c);
      }
      // 3 pasadas => resultado en g
      f.set(g);
    }
    const out = new Uint8ClampedArray(data.length);
    for (let i = 0; i < data.length; i += 4) {
      const a = f[i + 3];
      out[i + 3] = a;
      if (a > 0.5) { const k = 255 / a; out[i] = f[i] * k; out[i + 1] = f[i + 1] * k; out[i + 2] = f[i + 2] * k; }
    }
    return out;
  }

  function blurMask(mask, w, h, r) {
    if (r < 1) return mask;
    const f = new Float32Array(mask.length);
    for (let i = 0; i < mask.length; i++) f[i] = mask[i];
    const g = new Float32Array(mask.length);
    boxBlurChannel(f, g, w, h, Math.round(r), 1, 0);
    const out = new Uint8Array(mask.length);
    for (let i = 0; i < mask.length; i++) out[i] = g[i];
    return out;
  }

  /* ---------------------------- Rectificación ---------------------------- */
  /**
   * Endereza la cara frontal del equipo (cuadrilátero en la foto) a un
   * rectángulo de proporción realW/realH. Devuelve {w,h,data} RGBA.
   */
  function rectify(src, mask, quad, realW, realH, feather, maxSide = 2048) {
    const d = Geo.dist2;
    const wpx = Math.max(d(quad[0], quad[1]), d(quad[3], quad[2]));
    const hpx = Math.max(d(quad[1], quad[2]), d(quad[0], quad[3]));
    const aspect = realW / realH;
    let tw = Math.max(wpx, hpx * aspect);
    tw = clamp(tw, 32, maxSide);
    let th = tw / aspect;
    if (th > maxSide) { th = maxSide; tw = th * aspect; }
    tw = Math.max(8, Math.round(tw)); th = Math.max(8, Math.round(th));
    const H = Geo.homography([[0, 0], [tw, 0], [tw, th], [0, th]], quad);
    const out = new Uint8ClampedArray(tw * th * 4);
    if (!H) return { w: tw, h: th, data: out };
    const sw = src.w, sh = src.h, sd = src.data;
    const fm = feather > 0.5 ? blurMask(mask, sw, sh, feather) : mask;
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        const X = H[0] * (x + 0.5) + H[1] * (y + 0.5) + H[2];
        const Y = H[3] * (x + 0.5) + H[4] * (y + 0.5) + H[5];
        const W = H[6] * (x + 0.5) + H[7] * (y + 0.5) + H[8];
        const u = X / W - 0.5, v = Y / W - 0.5;
        const x0 = clamp(Math.floor(u), 0, sw - 1), y0 = clamp(Math.floor(v), 0, sh - 1);
        const x1 = Math.min(x0 + 1, sw - 1), y1 = Math.min(y0 + 1, sh - 1);
        const fx = clamp(u - x0, 0, 1), fy = clamp(v - y0, 0, 1);
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        const i00 = y0 * sw + x0, i10 = y0 * sw + x1, i01 = y1 * sw + x0, i11 = y1 * sw + x1;
        const a00 = fm[i00] * w00, a10 = fm[i10] * w10, a01 = fm[i01] * w01, a11 = fm[i11] * w11;
        const A = a00 + a10 + a01 + a11;
        const o = (y * tw + x) * 4;
        if (A < 0.5) continue;
        for (let c = 0; c < 3; c++) {
          out[o + c] = (sd[i00 * 4 + c] * a00 + sd[i10 * 4 + c] * a10 + sd[i01 * 4 + c] * a01 + sd[i11 * 4 + c] * a11) / A;
        }
        out[o + 3] = A;
      }
    }
    return { w: tw, h: th, data: out };
  }

  /* --------------------- Estadísticas de la escena ----------------------- */
  function percentile(hist, total, p) {
    let acc = 0;
    const target = total * p;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= target) return i; }
    return 255;
  }

  /** Estadísticas de una región (bbox) de un ImageData completo. */
  function regionStats(img, x0, y0, x1, y1) {
    x0 = clamp(Math.floor(x0), 0, img.width - 1); x1 = clamp(Math.ceil(x1), 1, img.width);
    y0 = clamp(Math.floor(y0), 0, img.height - 1); y1 = clamp(Math.ceil(y1), 1, img.height);
    const area = Math.max(1, (x1 - x0) * (y1 - y0));
    const step = Math.max(1, Math.floor(Math.sqrt(area / 40000)));
    const hist = new Float64Array(256);
    let n = 0, sr = 0, sg = 0, sb = 0, sl = 0;
    const d = img.data, W = img.width;
    for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) {
      const i = (y * W + x) * 4;
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const l = lum(r, g, b);
      hist[clamp(Math.round(l), 0, 255)]++;
      sr += r; sg += g; sb += b; sl += l; n++;
    }
    if (!n) return null;
    return {
      mean: [sr / n, sg / n, sb / n], meanL: sl / n,
      p01: percentile(hist, n, 0.01), p50: percentile(hist, n, 0.5), p99: percentile(hist, n, 0.99),
    };
  }

  function rgbaStats(data, useAlpha) {
    const hist = new Float64Array(256);
    let n = 0, sr = 0, sg = 0, sb = 0, sl = 0;
    const step = Math.max(4, Math.floor(data.length / 4 / 60000) * 4);
    for (let i = 0; i < data.length; i += step) {
      if (useAlpha && data[i + 3] < 128) continue;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const l = lum(r, g, b);
      hist[clamp(Math.round(l), 0, 255)]++;
      sr += r; sg += g; sb += b; sl += l; n++;
    }
    if (!n) return { mean: [128, 128, 128], meanL: 128, p01: 0, p50: 128, p99: 255 };
    return {
      mean: [sr / n, sg / n, sb / n], meanL: sl / n,
      p01: percentile(hist, n, 0.01), p50: percentile(hist, n, 0.5), p99: percentile(hist, n, 0.99),
    };
  }

  /** Mediana de luminancia en un parche cuadrado. */
  function patchLum(img, cx, cy, r) {
    const x0 = clamp(Math.round(cx - r), 0, img.width - 1), x1 = clamp(Math.round(cx + r), 1, img.width);
    const y0 = clamp(Math.round(cy - r), 0, img.height - 1), y1 = clamp(Math.round(cy + r), 1, img.height);
    const vals = [];
    const step = Math.max(1, Math.floor((x1 - x0) / 24));
    for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) {
      const i = (y * img.width + x) * 4;
      vals.push(lum(img.data[i], img.data[i + 1], img.data[i + 2]));
    }
    if (!vals.length) return null;
    vals.sort((a, b) => a - b);
    return vals[vals.length >> 1];
  }

  /** Estima el ruido (grano) de la foto en una región: sigma en niveles 0-255. */
  function estimateNoise(ctx, x0, y0, size) {
    const W = ctx.canvas.width, H = ctx.canvas.height;
    size = Math.min(size, W, H);
    x0 = clamp(Math.round(x0 - size / 2), 0, W - size); y0 = clamp(Math.round(y0 - size / 2), 0, H - size);
    if (size < 8) return 0;
    const d = ctx.getImageData(x0, y0, size, size).data;
    const res = [];
    for (let y = 1; y < size - 1; y += 2) for (let x = 1; x < size - 1; x += 2) {
      const i = (y * size + x) * 4;
      const c = lum(d[i], d[i + 1], d[i + 2]);
      const n = (lum(d[i - 4], d[i - 3], d[i - 2]) + lum(d[i + 4], d[i + 5], d[i + 6]) +
        lum(d[i - size * 4], d[i - size * 4 + 1], d[i - size * 4 + 2]) + lum(d[i + size * 4], d[i + size * 4 + 1], d[i + size * 4 + 2])) / 4;
      res.push(Math.abs(c - n));
    }
    res.sort((a, b) => a - b);
    // estimador robusto (MAD) del residuo laplaciano; se asume que la mayoría del parche es liso
    const mad = res[Math.floor(res.length * 0.5)] || 0;
    return clamp(mad * 1.4826 / 1.118, 0, 14);
  }

  /* ------------------------- Ajuste fotométrico -------------------------- */
  /**
   * Adapta el color de la textura a la escena.
   *  scene: stats de la zona de la foto alrededor del equipo
   *  photo: stats de la foto completa del equipo (incluye su fondo = blanco de referencia)
   */
  function adjustTexture(tex, p, scene, photo, blurSigmaTex) {
    const src = tex.data;
    const out = new Uint8ClampedArray(src.length);
    const s = p.match / 100;
    // Exposición: un blanco del catálogo debería verse como el blanco de la escena
    const photoWhite = Math.max(110, photo.p99);
    const sceneWhite = Math.max(40, scene.p99);
    let gain = Math.pow(sceneWhite / photoWhite, s);
    gain *= Math.pow(2, p.exposure);
    // Velo / nivel de negro de la escena
    const lift = clamp(scene.p01 * s * 0.6, 0, 60);
    // Dominante de color (gray-world relativo)
    const castS = (m, L) => [m[0] / L, m[1] / L, m[2] / L];
    const sc = castS(scene.mean, Math.max(1, scene.meanL)), ph = castS(photo.mean, Math.max(1, photo.meanL));
    const cg = [0, 1, 2].map(c => clamp(Math.pow(sc[c] / Math.max(0.05, ph[c]), s * 0.75), 0.7, 1.4));
    // Temperatura manual
    const t = p.temperature / 100;
    cg[0] *= 1 + t * 0.18; cg[2] *= 1 - t * 0.18; cg[1] *= 1 + t * 0.03;
    const contrast = 1 + p.contrast / 100;
    const sat = 1 + p.saturation / 100;
    for (let i = 0; i < src.length; i += 4) {
      const a = src[i + 3];
      if (!a) continue;
      let r = src[i] * gain * cg[0], g = src[i + 1] * gain * cg[1], b = src[i + 2] * gain * cg[2];
      // contraste alrededor del gris medio
      r = (r - 118) * contrast + 118; g = (g - 118) * contrast + 118; b = (b - 118) * contrast + 118;
      const L = lum(r, g, b);
      r = L + (r - L) * sat; g = L + (g - L) * sat; b = L + (b - L) * sat;
      // compresión suave de altas luces para no "quemar"
      r = r > 235 ? 235 + (r - 235) * 0.35 : r; g = g > 235 ? 235 + (g - 235) * 0.35 : g; b = b > 235 ? 235 + (b - 235) * 0.35 : b;
      const k = 1 - lift / 255;
      out[i] = lift + r * k; out[i + 1] = lift + g * k; out[i + 2] = lift + b * k; out[i + 3] = a;
    }
    const data = blurSigmaTex > 0.25 ? blurRGBA(out, tex.w, tex.h, blurSigmaTex) : out;
    return { w: tex.w, h: tex.h, data };
  }

  /** Color medio del borde de la textura (para pintar los laterales del equipo). */
  function edgeColor(tex) {
    const { w, h, data } = tex;
    const band = Math.max(2, Math.round(Math.min(w, h) * 0.03));
    let r = 0, g = 0, b = 0, n = 0;
    const add = (x, y) => { const i = (y * w + x) * 4; if (data[i + 3] > 200) { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; } };
    const st = Math.max(1, Math.floor(Math.max(w, h) / 300));
    for (let y = 0; y < h; y += st) for (let k = 0; k < band; k++) { add(k, y); add(w - 1 - k, y); }
    for (let x = 0; x < w; x += st) for (let k = 0; k < band; k++) { add(x, k); add(x, h - 1 - k); }
    if (!n) return [60, 60, 60];
    return [r / n, g / n, b / n];
  }

  /** Reduce una textura a la mitad (para mipmaps). */
  function halve(tex) {
    const w = Math.max(1, tex.w >> 1), h = Math.max(1, tex.h >> 1);
    const out = new Uint8ClampedArray(w * h * 4);
    const s = tex.data, W = tex.w;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const xs = Math.min(x * 2, tex.w - 2 < 0 ? 0 : tex.w - 2), ys = Math.min(y * 2, tex.h - 2 < 0 ? 0 : tex.h - 2);
      const idx = [(ys * W + xs) * 4, (ys * W + xs + 1) * 4, ((ys + 1) * W + xs) * 4, ((ys + 1) * W + xs + 1) * 4];
      let A = 0, R = 0, G = 0, B = 0;
      for (const i of idx) { const a = s[i + 3] || 0; A += a; R += (s[i] || 0) * a; G += (s[i + 1] || 0) * a; B += (s[i + 2] || 0) * a; }
      const o = (y * w + x) * 4;
      if (A > 0) { out[o] = R / A; out[o + 1] = G / A; out[o + 2] = B / A; }
      out[o + 3] = A / 4;
    }
    return { w, h, data: out };
  }

  function buildMips(tex) {
    const mips = [tex];
    while (mips[mips.length - 1].w > 48 && mips[mips.length - 1].h > 48 && mips.length < 7) mips.push(halve(mips[mips.length - 1]));
    return mips;
  }

  /* --------------------------- Warp perspectiva -------------------------- */
  function hash2(x, y) {
    let h = (x * 374761393 + y * 668265263) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }

  /**
   * Pinta la textura sobre `ctx` usando la homografía G (texel -> px destino).
   * opts: lightF[4] (SI,SD,ID,II), grain (sigma), gloss (0-1), clip (cuadrilátero px)
   */
  function warpOnto(ctx, tex, G, opts) {
    const cw = ctx.canvas.width, ch = ctx.canvas.height;
    const corners = [[0, 0], [tex.w, 0], [tex.w, tex.h], [0, tex.h]].map(p => Geo.apply(G, p[0], p[1]));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of corners) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    x0 = clamp(Math.floor(x0) - 1, 0, cw); y0 = clamp(Math.floor(y0) - 1, 0, ch);
    x1 = clamp(Math.ceil(x1) + 1, 0, cw); y1 = clamp(Math.ceil(y1) + 1, 0, ch);
    const bw = x1 - x0, bh = y1 - y0;
    if (bw <= 0 || bh <= 0 || bw * bh > 60e6) return;
    const Gi = Geo.inv(G);
    if (!Gi) return;
    const img = ctx.getImageData(x0, y0, bw, bh);
    const d = img.data, t = tex.data, tw = tex.w, th = tex.h;
    const L = opts.lightF || [1, 1, 1, 1];
    const grain = opts.grain || 0, gloss = opts.gloss || 0;
    let clipE = null;
    if (opts.clip) {
      const q = opts.clip, sgn = Math.sign(Geo.polyArea(q)) || 1;
      clipE = q.map((a, i) => { const b = q[(i + 1) % 4]; return [a, b, sgn]; });
    }
    for (let yy = 0; yy < bh; yy++) {
      const py = y0 + yy + 0.5;
      for (let xx = 0; xx < bw; xx++) {
        const px = x0 + xx + 0.5;
        const W = Gi[6] * px + Gi[7] * py + Gi[8];
        if (W <= 0) continue;
        const u = (Gi[0] * px + Gi[1] * py + Gi[2]) / W - 0.5;
        const v = (Gi[3] * px + Gi[4] * py + Gi[5]) / W - 0.5;
        if (u < -1 || v < -1 || u > tw || v > th) continue;
        if (clipE) {
          let out = false;
          for (const [a, b, s] of clipE) {
            if (((b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0])) * s < 0) { out = true; break; }
          }
          if (out) continue;
        }
        const ix = Math.floor(u), iy = Math.floor(v);
        const fx = u - ix, fy = v - iy;
        let A = 0, R = 0, Gc = 0, B = 0;
        for (let k = 0; k < 4; k++) {
          const sx = ix + (k & 1), sy = iy + (k >> 1);
          if (sx < 0 || sy < 0 || sx >= tw || sy >= th) continue;
          const wgt = ((k & 1) ? fx : 1 - fx) * ((k >> 1) ? fy : 1 - fy);
          const i = (sy * tw + sx) * 4;
          const a = t[i + 3] * wgt;
          A += a; R += t[i] * a; Gc += t[i + 1] * a; B += t[i + 2] * a;
        }
        if (A < 0.5) continue;
        let r = R / A, g = Gc / A, b = B / A;
        const lu = clamp(u / tw, 0, 1), lv = clamp(v / th, 0, 1);
        const lf = (L[0] * (1 - lu) + L[1] * lu) * (1 - lv) + (L[3] * (1 - lu) + L[2] * lu) * lv;
        r *= lf; g *= lf; b *= lf;
        if (gloss) {
          // reflejo diagonal suave típico de un cristal
          const band = Math.exp(-Math.pow((lu * 0.8 + lv * 0.6 - 0.55) / 0.22, 2));
          const add = gloss * 255 * (0.12 + 0.55 * band) * (1 - lv * 0.5);
          r += add * (1 - r / 300); g += add * (1 - g / 300); b += add * (1 - b / 300);
        }
        if (grain) {
          const n = (hash2(x0 + xx, y0 + yy) + hash2(y0 + yy + 7919, x0 + xx) - 1) * grain * 2.45;
          r += n; g += n; b += n;
        }
        const a = A / 255;
        const o = (yy * bw + xx) * 4;
        d[o] = d[o] * (1 - a) + r * a;
        d[o + 1] = d[o + 1] * (1 - a) + g * a;
        d[o + 2] = d[o + 2] * (1 - a) + b * a;
      }
    }
    ctx.putImageData(img, x0, y0);
  }

  /** Polígono difuminado (sombras) usando el truco de shadowBlur fuera de lienzo. */
  function blurPoly(ctx, pts, blurPx, color) {
    if (!pts || pts.length < 3) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (blurPx < 0.6) {
      ctx.fillStyle = color;
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.closePath(); ctx.fill();
    } else {
      const OFF = ctx.canvas.width + blurPx * 6 + 500;
      ctx.shadowColor = color; ctx.shadowBlur = blurPx; ctx.shadowOffsetX = OFF; ctx.shadowOffsetY = 0;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p[0] - OFF, p[1]) : ctx.moveTo(p[0] - OFF, p[1])));
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  return {
    clamp, lum, makeCanvas, loadImage, imageToCanvas,
    autoRemoveBackground, wandRemove, keepLargest, fillHoles, maskBBox, maskQuad, rotateRGBA,
    rectify, regionStats, rgbaStats, patchLum, estimateNoise, adjustTexture, edgeColor,
    buildMips, warpOnto, blurPoly, blurRGBA,
  };
})();
