/* =========================================================================
 * Geometría proyectiva: homografías, cámara, polígonos.
 * Todas las matrices 3x3 se guardan como arrays de 9 (fila mayor).
 * ========================================================================= */
'use strict';

const Geo = (() => {
  function solve(A, b) {
    const n = b.length;
    for (let i = 0; i < n; i++) {
      let p = i;
      for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
      [A[i], A[p]] = [A[p], A[i]];
      [b[i], b[p]] = [b[p], b[i]];
      const d = A[i][i];
      if (Math.abs(d) < 1e-12) return null;
      for (let r = i + 1; r < n; r++) {
        const f = A[r][i] / d;
        if (!f) continue;
        for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
        b[r] -= f * b[i];
      }
    }
    const x = new Array(n);
    for (let i = n - 1; i >= 0; i--) {
      let s = b[i];
      for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c];
      x[i] = s / A[i][i];
    }
    return x;
  }

  /** Homografía que lleva src[i] -> dst[i] (4 puntos [x,y]). */
  function homography(src, dst) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [u, v] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    const h = solve(A, b);
    if (!h || h.some(v => !isFinite(v))) return null;
    return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  }

  function mul(a, b) {
    const r = new Array(9);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    return r;
  }

  function inv(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-18) return null;
    return [
      A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
      B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
      C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
    ];
  }

  function apply(H, x, y) {
    const w = H[6] * x + H[7] * y + H[8];
    return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
  }

  const scaleM = s => [s, 0, 0, 0, s, 0, 0, 0, 1];

  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = a => Math.hypot(a[0], a[1], a[2]);
  const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];

  /**
   * Recupera una cámara pinhole a partir de la homografía plano(mm) -> imagen(px).
   * Si la referencia es un rectángulo real, la ortogonalidad de sus lados permite
   * estimar la focal. Devuelve funciones para proyectar puntos 3D (mm) con Z
   * positiva hacia la cámara (saliendo de la superficie).
   */
  function camera(H, imgW, imgH, fManual) {
    const cx = imgW / 2, cy = imgH / 2;
    const Hc = mul([1, 0, -cx, 0, 1, -cy, 0, 0, 1], H);
    const h = Hc;
    const D = Math.max(imgW, imgH);
    const ests = [];
    const d1 = h[6] * h[7];
    if (Math.abs(d1) > 1e-16) {
      const f2 = -(h[0] * h[1] + h[3] * h[4]) / d1;
      if (f2 > 0) ests.push(Math.sqrt(f2));
    }
    const d2 = h[6] * h[6] - h[7] * h[7];
    if (Math.abs(d2) > 1e-16) {
      const f2 = -(h[0] * h[0] + h[3] * h[3] - h[1] * h[1] - h[4] * h[4]) / d2;
      if (f2 > 0) ests.push(Math.sqrt(f2));
    }
    const good = ests.filter(f => f > 0.35 * D && f < 4 * D);
    const fEst = good.length ? good.reduce((a, b) => a + b, 0) / good.length : null;
    const f = fManual || fEst || 0.85 * D;

    const m1 = [h[0] / f, h[3] / f, h[6]];
    const m2 = [h[1] / f, h[4] / f, h[7]];
    const m3 = [h[2] / f, h[5] / f, h[8]];
    const lam = 2 / (norm(m1) + norm(m2));
    let r1 = scl(m1, lam), r2 = scl(m2, lam), t = scl(m3, lam);
    if (t[2] < 0) { r1 = scl(r1, -1); r2 = scl(r2, -1); t = scl(t, -1); }
    let r3 = cross(r1, r2);
    r3 = scl(r3, 1 / (norm(r3) || 1));
    // Normal que apunta hacia la cámara (situada en el origen).
    const n = dot(r3, t) > 0 ? scl(r3, -1) : r3;

    function camPoint(X, Y, Z) {
      return [
        X * r1[0] + Y * r2[0] + Z * n[0] + t[0],
        X * r1[1] + Y * r2[1] + Z * n[1] + t[1],
        X * r1[2] + Y * r2[2] + Z * n[2] + t[2],
      ];
    }
    function project(X, Y, Z) {
      const P = camPoint(X, Y, Z);
      const z = Math.max(P[2], 1e-6);
      return [f * P[0] / z + cx, f * P[1] / z + cy];
    }
    return { f, fEst, camPoint, project, ok: isFinite(lam) };
  }

  /* ----------------------------- Polígonos ----------------------------- */
  function pointInPoly(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  /** Distancia mínima t>0 a lo largo de dir desde p hasta el borde del polígono. */
  function rayPolyT(p, dir, poly) {
    let best = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const ex = b[0] - a[0], ey = b[1] - a[1];
      const den = dir[0] * ey - dir[1] * ex;
      if (Math.abs(den) < 1e-12) continue;
      const wx = a[0] - p[0], wy = a[1] - p[1];
      const t = (wx * ey - wy * ex) / den;
      const s = (wx * dir[1] - wy * dir[0]) / den;
      if (t > -1e-9 && s >= -1e-9 && s <= 1 + 1e-9) best = Math.min(best, Math.max(t, 0));
    }
    return best;
  }

  function polyArea(poly) {
    let a = 0;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
  }

  function isConvexQuad(q) {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
      const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (Math.abs(cr) < 1e-9) continue;
      const s = Math.sign(cr);
      if (sign && s !== sign) return false;
      sign = s;
    }
    return sign !== 0;
  }

  /** Ordena 4 puntos como SI, SD, ID, II (sentido horario en coordenadas imagen). */
  function sortQuad(pts) {
    const c = pts.reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4], [0, 0]);
    const s = pts.slice().sort((a, b) => Math.atan2(a[1] - c[1], a[0] - c[0]) - Math.atan2(b[1] - c[1], b[0] - c[0]));
    // atan2 creciente con y hacia abajo = sentido horario en pantalla
    let k = 0, best = Infinity;
    s.forEach((p, i) => { const v = p[0] + p[1]; if (v < best) { best = v; k = i; } });
    return [0, 1, 2, 3].map(i => s[(k + i) % 4]);
  }

  function convexHull(points) {
    const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (p.length < 3) return p;
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    for (const q of p) { while (lower.length >= 2 && cr(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
    const upper = [];
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cr(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
    upper.pop(); lower.pop();
    return lower.concat(upper);
  }

  /** Separating Axis Theorem para dos polígonos convexos. */
  function convexOverlap(A, B) {
    for (const poly of [A, B]) {
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        const ax = -(b[1] - a[1]), ay = b[0] - a[0];
        let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
        for (const p of A) { const v = p[0] * ax + p[1] * ay; minA = Math.min(minA, v); maxA = Math.max(maxA, v); }
        for (const p of B) { const v = p[0] * ax + p[1] * ay; minB = Math.min(minB, v); maxB = Math.max(maxB, v); }
        if (maxA <= minB + 1e-6 || maxB <= minA + 1e-6) return false;
      }
    }
    return true;
  }

  const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  return {
    homography, mul, inv, apply, scaleM, camera,
    pointInPoly, rayPolyT, polyArea, isConvexQuad, sortQuad, convexHull, convexOverlap, dist2,
    vec: { sub, dot, cross, norm, scl },
  };
})();
