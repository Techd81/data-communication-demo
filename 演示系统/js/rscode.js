/* ============================================================
 * RS 纠删码 (Reed-Solomon over GF(256))
 * 自适应编码·容错模式 —— 真实实现
 * - 系统化编码：数据符号在前，冗余校验符号在后
 * - 擦除恢复：已知丢失位置的符号可通过伴随式方程组恢复
 * ============================================================ */
(function (global) {
  'use strict';

  /* ---------- GF(256) 有限域 (本原多项式 0x11D) ---------- */
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function initGF() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x; LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11D;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }
  function gfDiv(a, b) {
    if (a === 0) return 0;
    return EXP[(LOG[a] + 255 - LOG[b]) % 255];
  }

  /* 生成多项式 g(x) = ∏_{j=0}^{nsym-1} (x - α^j) */
  function rsGenPoly(nsym) {
    let g = [1];
    for (let i = 0; i < nsym; i++) {
      const root = EXP[i];
      const ng = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) {
        ng[j] ^= gfMul(g[j], root);
        ng[j + 1] ^= g[j];
      }
      g = ng;
    }
    return g;
  }

  /* 多项式求值（升幂系数） */
  function polyEval(poly, x) {
    let acc = poly[poly.length - 1];
    for (let i = poly.length - 2; i >= 0; i--) acc = gfMul(acc, x) ^ poly[i];
    return acc;
  }

  /* 多项式取模：dividend mod divisor（升幂系数，divisor 首一） */
  function polyMod(dividend, divisor) {
    const d = dividend.slice();
    const dl = divisor.length - 1;
    while (d.length - 1 >= dl) {
      const deg = d.length - 1;
      const coef = d[deg];
      if (coef !== 0) {
        for (let i = 0; i <= dl; i++) {
          d[deg - dl + i] ^= gfMul(coef, divisor[i]);
        }
      }
      d.pop();
    }
    return d;
  }

  /**
   * 系统化 RS 编码：message (k 符号) → codeword (n = k + nsym 符号)
   * C(x) = m(x)·x^nsym + (m(x)·x^nsym mod g(x))，满足 C(α^j)=0
   * 码字顺序：校验符号在前，数据符号在后
   */
  function rsEncode(msg, nsym) {
    const k = msg.length;
    const n = k + nsym;
    const gen = rsGenPoly(nsym);
    const dividend = new Array(nsym).fill(0).concat(Array.from(msg));
    const rem = polyMod(dividend, gen);
    const out = new Uint8Array(n);
    out.set(rem, 0);
    out.set(msg, nsym);
    return out;
  }

  /**
   * 擦除恢复：给定已知丢失位置，恢复原始码字
   * @returns {{ok:boolean, corrected?:Uint8Array, reason?:string}}
   */
  function rsDecodeErasures(codeword, nsym, erasurePositions) {
    const n = codeword.length;
    const S = [];
    for (let j = 0; j < nsym; j++) S.push(polyEval(codeword, EXP[j]));
    if (S.every(s => s === 0)) return { ok: true, corrected: codeword };

    const er = erasurePositions.filter(p => p >= 0 && p < n);
    const t = er.length;
    if (t > nsym) return { ok: false, reason: '擦除符号数超过纠错容量' };

    // 伴随式方程组 A·e = S，A[j][l] = α^{j·pos_l}
    const aug = [];
    for (let j = 0; j < t; j++) {
      const row = [];
      for (let l = 0; l < t; l++) row.push(EXP[(j * er[l]) % 255]);
      row.push(S[j]);
      aug.push(row);
    }
    // Gauss-Jordan 消元（GF(256)）
    for (let col = 0; col < t; col++) {
      let piv = -1;
      for (let r = col; r < t; r++) if (aug[r][col] !== 0) { piv = r; break; }
      if (piv === -1) return { ok: false, reason: '伴随式矩阵奇异' };
      if (piv !== col) { const tmp = aug[col]; aug[col] = aug[piv]; aug[piv] = tmp; }
      const pv = aug[col][col];
      for (let c = col; c <= t; c++) aug[col][c] = gfDiv(aug[col][c], pv);
      for (let r = 0; r < t; r++) {
        if (r === col) continue;
        const factor = aug[r][col];
        if (factor !== 0) {
          for (let c = col; c <= t; c++) aug[r][c] ^= gfMul(factor, aug[col][c]);
        }
      }
    }
    const e = aug.map(row => row[t]);
    const corrected = codeword.slice();
    for (let l = 0; l < t; l++) corrected[er[l]] ^= e[l];

    // 校验：伴随式全部归零
    for (let j = 0; j < nsym; j++) {
      if (polyEval(corrected, EXP[j]) !== 0) {
        return { ok: false, reason: '恢复后校验失败' };
      }
    }
    return { ok: true, corrected };
  }

  /**
   * 流式 RS 编码：数据 → 分组成 k 符号 → 每组追加 nsym 个校验符号
   */
  function rsEncodeStream(data, n, nsym) {
    const k = n - nsym;
    const nGroups = Math.ceil(data.length / k);
    const out = new Uint8Array(nGroups * n);
    let pos = 0;
    for (let g = 0; g < nGroups; g++) {
      const msg = new Uint8Array(k);
      const take = Math.min(k, data.length - pos);
      msg.set(data.subarray(pos, pos + take), 0);
      pos += take;
      out.set(rsEncode(msg, nsym), g * n);
    }
    return { stream: out, n, k, nsym, nGroups, dataLen: data.length };
  }

  /**
   * 流式 RS 擦除恢复
   * @param {Uint8Array} stream 收到的（含丢失置零的）码流
   * @param {number[]} erasureIndices 丢失的字节下标集合
   */
  function rsDecodeStream(stream, n, nsym, nGroups, dataLen, erasureIndices) {
    const k = n - nsym;
    const erasureSet = new Set(erasureIndices);
    const dataOut = new Uint8Array(nGroups * k);
    let lost = 0;
    for (let g = 0; g < nGroups; g++) {
      const cw = stream.subarray(g * n, g * n + n).slice();
      const er = [];
      for (let idx = g * n; idx < g * n + n; idx++) {
        if (erasureSet.has(idx)) er.push(idx - g * n);
      }
      lost += er.length;
      const res = rsDecodeErasures(cw, nsym, er);
      if (!res.ok) {
        return { ok: false, group: g, reason: res.reason, lostCount: lost };
      }
      // 提取数据符号（每组位置 nsym..n-1）
      dataOut.set(res.corrected.subarray(nsym, n), g * k);
    }
    return { ok: true, recovered: dataOut.subarray(0, dataLen), lostCount: lost };
  }

  global.RSCode = {
    gfMul, gfDiv, rsEncode, rsDecodeErasures, rsEncodeStream, rsDecodeStream,
    CODEWORD_N: 255
  };
})(window);
