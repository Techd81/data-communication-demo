/* ============================================================
 * Canvas 可视化 —— 多路径数据传输动画（Hand-Drawn Sketch 渲染）
 * 三段式流水线布局：S1 数据预处理 → S2 编码与传输 → S3 接收与恢复
 * 分区横幅 · 公式便签 · 分块托盘 · 到达托盘 · 底部传输进度线
 * 纸面点阵背景 · 墨色手绘曲线 · 粉彩便签节点/数据块
 * 确定性抖动（sin/cos 噪声，帧间稳定不闪烁）· 硬边纸片阴影
 * 动画服务于功能演示，prefers-reduced-motion 下离散步进
 * ============================================================ */
(function (global) {
  'use strict';

  let canvas, ctx, W = 0, H = 0, dpr = 1;
  let raf = 0;
  let last = 0;

  const PATH_COUNT = 3;
  const INK = '#2e3b4e';
  const INK_SOFT = '#5a6678';
  const COLOR = { ok: INK, congest: '#5b8dd9', fail: '#e0564f', block: INK, retrans: '#5b8dd9' };
  const NOTE = ['#fdeeb3', '#ffd7e2', '#cde6ff', '#d3efd7', '#e7dcfa', '#ffdfc4'];
  // 分区横幅配色（S1 蓝 / S2 黄 / S3 绿）与活跃阶段高亮
  const ZONE = {
    S1: { fill: '#cde6ff', active: '#e9f4ff' },
    S2: { fill: '#fdeeb3', active: '#fff7da' },
    S3: { fill: '#d3efd7', active: '#e9f8ee' },
  };
  const SENDER = { x: 0, y: 0, w: 100, h: 60 };
  const RECEIVER = { x: 0, y: 0, w: 100, h: 60 };
  const L = {};   // 布局缓存（layout() 随 resize 刷新）

  const reducedMotion = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let paths = [];       // { state, delay, p0, p1, c1, c2 }
  let blocks = [];      // { sn,color,size,start,path,t,status,rate,departed,prob,pathName,dieAt,arc }
  let arrows = [];      // 路径方向箭头 { path, t, speed }
  let reqs = [];        // 重传请求标记 { from, to, t, speed, done }
  let s1Chips = [];     // S1 分块托盘 { sn, size, status: prep|sent|lost, t }
  let s3Tray = [];      // S3 到达托盘 { sn, status: arrived|lost|recovered, t }
  let blockCount = 0;   // 本轮数据块总数（进度分母）
  let maxBlockSize = 1;
  let keyInfo = null;   // S1 密钥哈希短显
  let cipherLen = null; // S1 密文长度
  let mode = null;      // S2 编码模式 'huffman' | 'rs' | null
  let activeZone = null;// 'S1' | 'S2' | 'S3' | null
  let badgeFlash = [0, 0, 0]; // 概率徽章闪烁计时（重路由提示）
  let txCallbacks = null;
  let txResolve = null;
  let txRunning = false;
  let departDone = false;
  let retransQueue = [];
  let retransResolve = null;
  let opt = { speed: 1, lossRate: 0, probs: [] };

  /* ---------- 手绘工具 ---------- */
  // 确定性抖动：同一点每帧偏移一致，线条稳定且带「人手」手感
  function jx(i, seed) { return Math.sin(i * 0.91 + seed * 2.13) * 1.5; }
  function jy(i, seed) { return Math.cos(i * 0.73 + seed * 3.71) * 1.5; }
  function noteColor(sn) { return NOTE[sn % NOTE.length]; }
  function blockAngle(sn) { return ((sn % 5) - 2) * 2.4 * Math.PI / 180; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function easeOutBack(x) {
    const c1 = 1.70158, c3 = c1 + 1, v = x - 1;
    return 1 + c3 * v * v * v + c1 * v * v;
  }

  // 手绘抖动描边矩形（四条微曲边；style 可指定描边色）
  function sketchRect(x, y, w, h, seed, lw, style) {
    ctx.lineWidth = lw || 2;
    ctx.strokeStyle = style || INK;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x + 4 + jx(1, seed), y + jy(1, seed));
    ctx.quadraticCurveTo(x + w / 2, y - 1.6 + jy(2, seed), x + w - 4 + jx(3, seed), y + jy(3, seed));
    ctx.quadraticCurveTo(x + w + 1.6 + jx(4, seed), y + h / 2, x + w - 4 + jx(5, seed), y + h - 4 + jy(5, seed));
    ctx.quadraticCurveTo(x + w / 2, y + h + 1.6 + jy(6, seed), x + 4 + jx(7, seed), y + h - 4 + jy(7, seed));
    ctx.quadraticCurveTo(x - 1.6 + jx(8, seed), y + h / 2, x + 4 + jx(9, seed), y + jy(9, seed));
    ctx.closePath();
    ctx.stroke();
  }

  // 手绘抖动直线段（dash 由调用方 save/setLineDash 控制）
  function sketchLine(x1, y1, x2, y2, seed, lw, style) {
    const segs = 10;
    ctx.lineWidth = lw || 2.5;
    ctx.strokeStyle = style || INK;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const px = x1 + (x2 - x1) * t + jx(i, seed) * 0.8;
      const py = y1 + (y2 - y1) * t + jy(i, seed) * 0.8;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  // 手绘抖动贝塞尔路径（采样 + 确定性噪声）
  function sketchBezier(p, seed, lw, style) {
    const N = 42;
    ctx.lineWidth = lw || 2.6;
    ctx.strokeStyle = style || INK;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const pt = bez(p, t);
      const px = pt.x + jx(i, seed);
      const py = pt.y + jy(i, seed);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  function rand(a, b) { return a + Math.random() * (b - a); }
  function pickWeighted(weights) {
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r <= 0) return i;
    }
    return weights.length - 1;
  }

  /* ---------- 布局（三段式流水线） ---------- */
  function layout() {
    const x1 = W * 0.23, x2 = W * 0.77;   // S1/S2/S3 边界
    const s2w = x2 - x1;
    L.x1 = x1; L.x2 = x2;
    L.bannerY = 8;
    L.bannerH = clamp(22, H * 0.07, 28);
    L.ctrlY = [H * 0.2, H * 0.5, H * 0.8];
    const compact = W < 640;   // 窄屏：隐藏便签与托盘
    const short = H < 370;     // 矮画布：单行便签、隐藏托盘（避让图例/进度线）
    L.compact = compact;
    L.hideNotes = compact;
    L.hideTrays = compact || short;
    L.short = short;
    L.noteH = short ? 16 : 22;
    L.noteGap = short ? 4 : 6;
    L.bottomLimit = H - 50;    // 侧栏内容底部（进度标签之上）
    L.tray1H = 30;
    L.tray3H = 36;

    // 节点：发送端靠 S1/S2 边界、接收端靠 S2/S3 边界
    const nodeH = clamp(52, H * 0.155, 60);
    SENDER.w = 100; SENDER.h = nodeH;
    SENDER.x = x1 - 8 - SENDER.w;
    SENDER.y = H / 2 - nodeH / 2;
    RECEIVER.w = 100; RECEIVER.h = nodeH;
    RECEIVER.x = x2 + 8;
    RECEIVER.y = H / 2 - nodeH / 2;

    // 三条路径：均位于 S2 区内，横向上下分布
    const bend = Math.min(22, H * 0.055);
    paths.forEach((p, i) => {
      p.p0 = { x: x1 + 2, y: L.ctrlY[i] };
      p.p1 = { x: x2 - 2, y: L.ctrlY[i] };
      p.c1 = { x: p.p0.x + s2w * 0.42, y: L.ctrlY[i] - bend };
      p.c2 = { x: p.p1.x - s2w * 0.42, y: L.ctrlY[i] + bend };
    });

    // S1/S3 侧栏：便签 + 托盘
    const nodeBottom = SENDER.y + nodeH;
    const notesH = L.hideNotes ? 0 : 3 * L.noteH + 2 * L.noteGap;
    L.tray1Top = L.bottomLimit - (L.hideTrays ? 0 : L.tray1H);
    L.tray3Top = L.bottomLimit - (L.hideTrays ? 0 : L.tray3H);
    L.notesTop1 = L.hideNotes ? 0 : Math.min(nodeBottom + 6, L.tray1Top - notesH - 6);
    L.notesTop3 = L.hideNotes ? 0 : Math.min(nodeBottom + 6, L.tray3Top - notesH - 6);
    L.notesW = Math.min(156, x1 - 16);
    L.notesX1 = SENDER.x + SENDER.w / 2 - L.notesW / 2;
    L.notesX3 = RECEIVER.x + RECEIVER.w / 2 - L.notesW / 2;
    L.tray1X = 8; L.tray1W = x1 - 16;
    L.tray3X = x2 + 8; L.tray3W = W - x2 - 16;

    // 底部传输进度线
    L.progressY = H - 36;
    L.progressLabelY = H - 46;
  }

  /* 三次贝塞尔 */
  function bez(p, t) {
    const u = 1 - t;
    return {
      x: u * u * u * p.p0.x + 3 * u * u * t * p.c1.x + 3 * u * t * t * p.c2.x + t * t * t * p.p1.x,
      y: u * u * u * p.p0.y + 3 * u * u * t * p.c1.y + 3 * u * t * t * p.c2.y + t * t * t * p.p1.y,
    };
  }
  /* 切向（用于箭头方向） */
  function bezTangent(p, t) {
    const u = 1 - t;
    return {
      x: 3 * u * u * (p.c1.x - p.p0.x) + 6 * u * t * (p.c2.x - p.c1.x) + 3 * t * t * (p.p1.x - p.c2.x),
      y: 3 * u * u * (p.c1.y - p.p0.y) + 6 * u * t * (p.c2.y - p.c1.y) + 3 * t * t * (p.p1.y - p.c2.y),
    };
  }
  /* 弧线（重路由过渡） */
  function arcPoint(p0, p1, t) {
    const ctrl = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 - 44 };
    const u = 1 - t;
    return {
      x: u * u * p0.x + 2 * u * t * ctrl.x + t * t * p1.x,
      y: u * u * p0.y + 2 * u * t * ctrl.y + t * t * p1.y,
    };
  }

  /* ---------- 初始化 ---------- */
  function init(cv) {
    canvas = cv;
    ctx = canvas.getContext('2d');
    for (let i = 0; i < PATH_COUNT; i++) {
      paths.push({ state: 'ok', delay: [42, 38, 51][i] });
    }
    resize();
    window.addEventListener('resize', resize);
    // 每路径 3 个方向箭头
    for (let i = 0; i < PATH_COUNT; i++) {
      for (let a = 0; a < 3; a++) {
        arrows.push({ path: i, t: a / 3, speed: rand(0.12, 0.18) });
      }
    }
    last = performance.now();
    raf = requestAnimationFrame(loop);
  }

  function resize() {
    const rect = canvas.parentElement.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = Math.max(120, rect.width);
    H = Math.max(120, rect.height);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    layout();
  }

  /* ---------- 状态 ---------- */
  function setPathState(idx, state) {
    if (idx < 0 || idx >= paths.length) return;
    paths[idx].state = state;
    const still = blocks.filter(b => b.status === 'traveling' && b.path === idx);
    if (still.length && txCallbacks) {
      txCallbacks.onPathFail(idx, paths[idx].label || ('PATH ' + (idx + 1)));
      still.forEach(b => reroute(b));
    }
  }

  function reroute(b) {
    const healthy = paths.map((p, i) => (p.state === 'ok' ? i : -1)).filter(i => i >= 0);
    if (!healthy.length) return;
    const target = healthy[Math.floor(Math.random() * healthy.length)];
    const fromIdx = b.path;
    b.fromPath = b.path;
    b.arc = { from: bez(paths[b.path], b.t), to: bez(paths[target], b.t), t: 0 };
    b.path = target;
    badgeFlash[target] = 1;   // 概率徽章闪烁提示 Δp
    if (txCallbacks) txCallbacks.onPathReroute({ sn: b.sn }, fromIdx + 1, target + 1);
  }

  /* ---------- 主传输 ---------- */
  function startTransmission(opts) {
    return new Promise(resolve => {
      txResolve = resolve;
      txRunning = true;
      departDone = false;
      txCallbacks = opts;
      opt.speed = opts.speed || 1;
      opt.lossRate = opts.lossRate || 0;
      opt.probs = opts.probs || paths.map(() => 1 / PATH_COUNT);

      blocks = [];
      reqs = [];
      // 本轮分块统计与托盘初始化（渲染层，不改动出发/完成判定时序）
      blockCount = opts.blocks.length;
      maxBlockSize = Math.max(1, ...opts.blocks.map(b => b.size || 0));
      s1Chips = opts.blocks.map(b => ({ sn: b.sn, size: b.size || 0, status: 'prep', t: 0 }));
      s3Tray = [];

      const count = opts.blocks.length;
      const healthByPath = paths.map(p => p.state === 'ok' ? 1 : p.state === 'congest' ? 0.55 : 0);
      let departIndex = 0;
      let anyLost = false;
      const depInterval = Math.max(80, 420 / opt.speed);

      const schedule = setInterval(() => {
        if (departIndex >= count) { clearInterval(schedule); departDone = true; return; }
        const b = opts.blocks[departIndex];
        const weights = paths.map((p, i) => (p.state === 'fail' ? 0 : opt.probs[i] * healthByPath[i]));
        const pi = pickWeighted(weights);
        let isLost = Math.random() < opt.lossRate;
        if (departIndex === count - 1 && !anyLost && opt.lossRate > 0.008) isLost = true;
        if (isLost) anyLost = true;
        blocks.push({
          sn: b.sn, color: b.color || COLOR.block, size: b.size, start: b.start || 0,
          path: pi, t: 0, status: isLost ? 'doomed' : 'traveling',
          rate: rand(0.9, 1.12) / 2.4 * opt.speed,
          dieAt: isLost ? rand(0.22, 0.78) : 1,
          departed: false, prob: opt.probs[pi], pathName: 'PATH ' + (pi + 1),
        });
        departIndex++;
      }, depInterval);
    });
  }

  /* ---------- 重传 ---------- */
  function retransmitBlocks(sns, opts) {
    return new Promise(resolve => {
      retransResolve = resolve;
      retransQueue = sns.slice();
      opt.speed = (opts && opts.speed) || 1;
    });
  }

  /* ---------- 托盘辅助（渲染层） ---------- */
  function markS1Chip(sn, status) {
    const c = s1Chips.find(x => x.sn === sn);
    if (c) c.status = status;
  }
  function trayPushArrived(sn) {
    const e = s3Tray.find(x => x.sn === sn);
    if (e) {
      // 重传/恢复：丢失槽位翻绿
      if (e.status === 'lost') { e.status = 'arrived'; e.t = 0; }
      return;
    }
    s3Tray.push({ sn, status: 'arrived', t: 0 });
  }
  function trayPushLost(sn) {
    if (s3Tray.some(x => x.sn === sn)) return;
    s3Tray.push({ sn, status: 'lost', t: 0 });
  }

  /* ---------- 更新 ---------- */
  function stepBlock(b, dt) {
    const travel = b.rate * dt;
    if (reducedMotion) {
      // 离散步进：约 90ms 一跳
      if (b._acc === undefined) b._acc = 0;
      b._acc += dt;
      if (b._acc >= 0.09) { b._acc = 0; b.t = Math.min(1, b.t + 0.11); }
    } else {
      b.t = Math.min(1, b.t + travel);
    }
  }

  function update(dt) {
    // 概率徽章闪烁衰减
    for (let i = 0; i < PATH_COUNT; i++) badgeFlash[i] = Math.max(0, badgeFlash[i] - dt * 2.2);
    // 托盘芯片入场计时
    for (const c of s1Chips) c.t += dt;
    for (const e of s3Tray) e.t += dt;

    // 方向箭头（功能性指示）
    for (const a of arrows) {
      if (!reducedMotion) a.t += a.speed * dt;
      if (a.t >= 1) a.t = 0;
    }

    // 数据块
    for (const b of blocks) {
      if (b.status === 'traveling' || b.status === 'doomed') {
        stepBlock(b, dt);
        if (b.status === 'doomed' && b.t >= b.dieAt) {
          b.status = 'lost';
          b.t = b.dieAt;
          markS1Chip(b.sn, 'lost');
          trayPushLost(b.sn);
          if (txCallbacks) txCallbacks.onLost({ sn: b.sn, pathName: b.pathName });
        } else if (b.status === 'traveling' && b.t >= 1) {
          b.status = 'arrived';
          b.t = 1;
          trayPushArrived(b.sn);
          if (txCallbacks) txCallbacks.onArrive({ sn: b.sn, pathName: b.pathName });
        } else if (!b.departed) {
          b.departed = true;
          markS1Chip(b.sn, 'sent');
          if (txCallbacks) txCallbacks.onDepart({ sn: b.sn, pathName: b.pathName, prob: b.prob });
        }
      }
      // 重路由弧线
      if (b.arc) {
        b.arc.t += dt * 3.2;
        if (b.arc.t >= 1) {
          b.x = b.arc.to.x; b.y = b.arc.to.y;
          delete b.arc;
        } else {
          const pt = arcPoint(b.arc.from, b.arc.to, 1 - Math.pow(1 - b.arc.t, 3));
          b.x = pt.x; b.y = pt.y;
        }
      } else if (b.path !== undefined && (b.status === 'traveling' || b.status === 'doomed')) {
        const pt = bez(paths[b.path], b.t);
        b.x = pt.x; b.y = pt.y;
      }
    }

    // 重传请求标记（接收端 → 发送端，红色手绘叉）
    for (let i = reqs.length - 1; i >= 0; i--) {
      const r = reqs[i];
      r.t += (reducedMotion ? 0.1 : 0.9) * dt;
      if (r.t >= 1) { reqs.splice(i, 1); continue; }
      const pt = arcPoint(r.from, r.to, r.t);
      r.x = pt.x; r.y = pt.y;
    }

    // 重传队列：先发请求标记，再发重传块
    if (retransQueue.length && txResolve === null) {
      const sn = retransQueue.shift();
      const healthy = paths.map((p, i) => (p.state === 'ok' ? i : -1)).filter(i => i >= 0);
      const pi = healthy.length ? healthy[Math.floor(Math.random() * healthy.length)] : 0;
      const existing = blocks.find(b => b.sn === sn);
      const size = existing ? existing.size : 64;
      const start = existing ? existing.start : 0;
      // 请求标记：从接收端回到发送端
      reqs.push({
        from: { x: RECEIVER.x, y: RECEIVER.y + RECEIVER.h / 2 },
        to: { x: SENDER.x + SENDER.w, y: SENDER.y + SENDER.h / 2 },
        t: 0, x: 0, y: 0,
      });
      blocks.push({
        sn, color: COLOR.retrans, size, start,
        path: pi, t: 0, status: 'retransmit', rate: 1.05 / 1.7 * opt.speed,
        departed: true, prob: 1, pathName: 'PATH ' + (pi + 1),
      });
    }

    // 重传块到达
    for (const b of blocks) {
      if (b.status === 'retransmit') {
        stepBlock(b, dt);
        const pt = bez(paths[b.path], b.t);
        b.x = pt.x; b.y = pt.y;
        if (b.t >= 1) {
          b.status = 'arrived';
          trayPushArrived(b.sn);
          if (retransQueue.length === 0) {
            setTimeout(() => { const r = retransResolve; retransResolve = null; if (r) r(); }, 260);
          }
        }
      }
    }
  }

  /* ---------- 绘制 ---------- */
  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // 纸面底色
    ctx.fillStyle = '#faf7ef';
    ctx.fillRect(0, 0, W, H);
    // 点阵纸纹
    ctx.fillStyle = 'rgba(46, 59, 78, 0.09)';
    const GAP = 26;
    for (let gx = 13; gx < W; gx += GAP) {
      for (let gy = 13; gy < H; gy += GAP) {
        ctx.beginPath();
        ctx.arc(gx, gy, 1.1, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 1) 分区虚线分隔线
    drawDividers();
    // 2) 分区横幅（活跃高亮 + S2 编码模式徽章）
    drawBanners();
    // 3) 三条路径（手绘抖动 + 状态色 + 拥塞锯齿纹 + 故障叉圈 + 标签 + 概率徽章）
    drawPaths();
    // 4) 方向箭头
    drawArrows();
    // 5) 节点（设备图形升级）
    drawNode(SENDER, 'S', '发送端', NOTE[2], -3, 'server');
    drawNode(RECEIVER, 'R', '接收端', NOTE[3], 2, 'terminal');
    // 6) S1/S3 公式便签
    drawNotes();
    // 7) S1 分块托盘 / S3 到达托盘
    drawS1Tray();
    drawS3Tray();
    // 8) 数据块（负载条 + 状态点；到达块落入托盘）
    drawBlocks();
    // 9) 重传请求标记
    drawReqs();
    // 10) 底部传输进度线
    drawProgress();
  }

  /* 分区虚线分隔线（顶部双短线刻痕） */
  function drawDividers() {
    const y0 = L.bannerY + L.bannerH + 10;
    const y1 = L.bottomLimit;
    [L.x1, L.x2].forEach((x, di) => {
      ctx.save();
      ctx.setLineDash([6, 5]);
      sketchLine(x, y0, x, y1, 30 + di * 7, 2, 'rgba(46,59,78,0.5)');
      ctx.restore();
      sketchLine(x - 7, y0 - 5, x + 7, y0 - 5, 33 + di * 3, 2, INK_SOFT);
      sketchLine(x - 5, y0 - 10, x + 5, y0 - 10, 36 + di * 3, 2, INK_SOFT);
    });
  }

  /* 分区横幅便签条 */
  function drawBanners() {
    const zones = [
      { id: 'S1', text: 'S1 · 数据预处理', x: 8, w: L.x1 - 16, rot: -1.5, seed: 40 },
      { id: 'S2', text: 'S2 · 编码与传输', x: L.x1 + 8, w: L.x2 - L.x1 - 16, rot: 1, seed: 43 },
      { id: 'S3', text: 'S3 · 接收与恢复', x: L.x2 + 8, w: W - L.x2 - 16, rot: -0.8, seed: 46 },
    ];
    zones.forEach(z => {
      const isActive = activeZone === z.id;
      const fill = isActive ? ZONE[z.id].active : ZONE[z.id].fill;
      const y = L.bannerY, h = L.bannerH;
      ctx.save();
      ctx.translate(z.x + z.w / 2, y + h / 2);
      ctx.rotate(z.rot * Math.PI / 180);
      ctx.translate(-(z.x + z.w / 2), -(y + h / 2));
      // 纸片硬阴影
      ctx.fillStyle = 'rgba(46,59,78,0.12)';
      ctx.fillRect(z.x + 3, y + 3.5, z.w, h);
      // 便签底 + 手绘描边
      ctx.fillStyle = fill;
      ctx.fillRect(z.x, y, z.w, h);
      sketchRect(z.x, y, z.w, h, z.seed, isActive ? 2.6 : 2);
      // 手写体文案
      ctx.fillStyle = INK;
      ctx.font = '700 ' + Math.max(11, Math.min(14, h * 0.52)) + 'px "Ma Shan Zheng","Caveat","KaiTi",cursive';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(z.text, z.x + 12, y + h / 2 + 1);
      // 活跃阶段：红色波浪下划线
      if (isActive) {
        const tw = ctx.measureText(z.text).width;
        drawWave(z.x + 12, y + h - 2, tw, z.seed);
      }
      // S2 编码模式徽章
      if (z.id === 'S2') drawModeBadge(z);
      ctx.restore();
    });
  }

  /* 红色波浪下划线 */
  function drawWave(x, y, w, seed) {
    ctx.strokeStyle = '#e0564f';
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    const N = Math.max(4, Math.round(w / 14));
    for (let i = 0; i <= N; i++) {
      const px = x + (w * i) / N + jx(i, seed);
      const py = y + Math.sin(i * 1.35) * 2.6 + jy(i, seed + 2);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  /* S2 编码模式徽章（Huffman / RS 纠删码，空闲 --） */
  function drawModeBadge(zone) {
    const label = mode === 'huffman' ? 'Huffman' : mode === 'rs' ? 'RS 纠删码' : '--';
    ctx.font = '700 11px "Caveat","KaiTi",cursive';
    const tw = ctx.measureText(label).width;
    const bw = tw + 16, bh = 17;
    const bx = zone.x + zone.w - bw - 8;
    const by = zone.y + zone.h / 2 - bh / 2;
    ctx.save();
    ctx.translate(bx + bw / 2, by + bh / 2);
    ctx.rotate(1.2 * Math.PI / 180);
    ctx.translate(-(bx + bw / 2), -(by + bh / 2));
    ctx.fillStyle = mode === 'huffman' ? NOTE[0] : mode === 'rs' ? NOTE[1] : '#fffdf6';
    ctx.fillRect(bx, by, bw, bh);
    sketchRect(bx, by, bw, bh, 51, 1.8);
    ctx.fillStyle = INK_SOFT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 11px "Caveat","KaiTi",cursive';
    ctx.fillText(label, bx + bw / 2, by + bh / 2 + 1);
    ctx.restore();
  }

  /* 三条路径 */
  function drawPaths() {
    paths.forEach((p, i) => {
      const col = COLOR[p.state];
      const lw = p.state === 'congest' ? 3.2 : 2.6;
      const dash = p.state === 'fail' ? [7, 5] : null;

      ctx.save();
      if (dash) ctx.setLineDash(dash);
      sketchBezier(p, i * 3 + 1, lw, col);
      ctx.restore();

      // 拥塞：中点手绘锯齿「堵车」纹
      if (p.state === 'congest') drawZigzag(p, i * 5 + 70);

      // 中继节点（手绘小星）
      [0.33, 0.66].forEach((t, k) => {
        const pt = bez(p, t);
        drawStar(pt.x, pt.y, 3.6, p.state === 'fail' ? COLOR.fail : INK, i + k);
      });

      // 故障：手绘叉 + 虚线圈
      if (p.state === 'fail') {
        const m = bez(p, 0.5);
        ctx.save();
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.arc(m.x, m.y, 16, 0, Math.PI * 2);
        ctx.strokeStyle = COLOR.fail;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();
        sketchLine(m.x - 8, m.y - 8, m.x + 8, m.y + 8, i + 9, 2.6, COLOR.fail);
        sketchLine(m.x + 8, m.y - 8, m.x - 8, m.y + 8, i + 11, 2.6, COLOR.fail);
      }

      // 路径标签（手写体）
      ctx.fillStyle = INK;
      ctx.font = '700 13px "Caveat","KaiTi",cursive';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText('PATH ' + (i + 1), p.p0.x + 10, p.p0.y - 12);
      ctx.fillStyle = p.state === 'fail' ? COLOR.fail : p.state === 'congest' ? COLOR.congest : INK_SOFT;
      ctx.font = '600 11px "Caveat","KaiTi",cursive';
      ctx.fillText(
        p.state === 'fail' ? 'D_k > D_th · 故障' : p.state === 'congest' ? 'T_k < T_th · 拥塞' : 'D_k = ' + p.delay + 'ms',
        p.p0.x + 10, p.p0.y + 2
      );
      // 路径概率徽章（重路由时闪烁）
      drawProbBadge(i, p);
    });
  }

  /* 路径概率徽章 p=0.33 */
  function drawProbBadge(i, p) {
    const v = (opt.probs[i] !== undefined ? opt.probs[i] : 1 / PATH_COUNT);
    const txt = 'p=' + v.toFixed(2);
    ctx.font = '700 10.5px "Caveat","KaiTi",cursive';
    const tw = ctx.measureText(txt).width;
    const bw = tw + 12, bh = 15;
    const bx = p.p0.x + 58, by = p.p0.y - 22;
    const flash = badgeFlash[i] > 0;
    ctx.save();
    ctx.translate(bx + bw / 2, by + bh / 2);
    ctx.rotate(-2 * Math.PI / 180);
    ctx.translate(-(bx + bw / 2), -(by + bh / 2));
    ctx.fillStyle = '#fffdf6';
    ctx.fillRect(bx, by, bw, bh);
    sketchRect(bx, by, bw, bh, 60 + i * 4, flash ? 2.6 : 1.8, flash ? '#e0564f' : null);
    ctx.fillStyle = flash ? '#e0564f' : INK_SOFT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 10.5px "Caveat","KaiTi",cursive';
    ctx.fillText(txt, bx + bw / 2, by + bh / 2 + 1);
    ctx.restore();
  }

  /* 拥塞锯齿「堵车」纹 */
  function drawZigzag(p, seed) {
    const N = 14, amp = 3.6;
    ctx.strokeStyle = COLOR.congest;
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const t = 0.42 + 0.16 * i / N;
      const pt = bez(p, t);
      const tg = bezTangent(p, t);
      const ang = Math.atan2(tg.y, tg.x) + Math.PI / 2;
      const off = (i % 2 === 0 ? 1 : -1) * amp;
      const px = pt.x + Math.cos(ang) * off + jx(i, seed);
      const py = pt.y + Math.sin(ang) * off + jy(i, seed);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  /* 方向箭头（手绘三角） */
  function drawArrows() {
    arrows.forEach((a, ai) => {
      const p = paths[a.path];
      const pt = bez(p, a.t);
      const tg = bezTangent(p, a.t);
      const ang = Math.atan2(tg.y, tg.x);
      ctx.save();
      ctx.translate(pt.x, pt.y);
      ctx.rotate(ang);
      ctx.lineWidth = 2;
      ctx.strokeStyle = p.state === 'fail' ? 'rgba(224,86,79,.75)' : 'rgba(46,59,78,.6)';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      // 手绘箭头：两条微弧
      ctx.beginPath();
      ctx.moveTo(8 + jx(ai, 5), -1 + jy(ai, 5));
      ctx.quadraticCurveTo(3, -4.5, -3.5, -4 + jy(ai + 2, 5));
      ctx.moveTo(8 + jx(ai + 4, 5), 1 + jy(ai + 4, 5));
      ctx.quadraticCurveTo(3, 4.5, -3.5, 4 + jy(ai + 6, 5));
      ctx.stroke();
      ctx.restore();
    });
  }

  /* S1/S3 公式便签 */
  function drawNotes() {
    if (L.hideNotes) return;
    const noteW = L.notesW;
    // S1：密钥 / 密文 / 分块
    drawNote(L.notesX1, L.notesTop1, noteW, L.noteH, 'K = H(I, S, T)', keyInfo ? shortKey(keyInfo, L.short) : '--', 100, NOTE[2], L.short);
    drawNote(L.notesX1, L.notesTop1 + L.noteH + L.noteGap, noteW, L.noteH, 'C = E(K, D_json)', cipherLen !== null ? cipherLen + ' B' : '--', 104, NOTE[5], L.short);
    drawNote(L.notesX1, L.notesTop1 + 2 * (L.noteH + L.noteGap), noteW, L.noteH, 'Σs_i = |P|', blockCount ? blockCount + ' 块' : '--', 108, NOTE[0], L.short);
    // S3：校验 / 排序 / 解密
    drawNote(L.notesX3, L.notesTop3, noteW, L.noteH, 'H_received ≟ H_original', null, 112, NOTE[3], L.short);
    drawNote(L.notesX3, L.notesTop3 + L.noteH + L.noteGap, noteW, L.noteH, 'P = Sort({B_i | SN_i})', null, 116, NOTE[0], L.short);
    drawNote(L.notesX3, L.notesTop3 + 2 * (L.noteH + L.noteGap), noteW, L.noteH, 'D = D(K, C)', null, 120, NOTE[5], L.short);
  }

  function shortKey(hex, compact) {
    if (!hex) return '--';
    return compact ? hex.slice(0, 4) + '…' + hex.slice(-4) : hex.slice(0, 8) + '…' + hex.slice(-4);
  }

  /* 单张公式便签（矮画布单行 / 常规两行） */
  function drawNote(x, y, w, h, formula, value, seed, fill, compact) {
    ctx.save();
    ctx.translate(x + w / 2, y + h / 2);
    ctx.rotate(-1.6 * Math.PI / 180);
    ctx.translate(-(x + w / 2), -(y + h / 2));
    // 纸片硬阴影
    ctx.fillStyle = 'rgba(46,59,78,0.14)';
    ctx.fillRect(x + 2, y + 2.5, w, h);
    // 便签底 + 手绘描边
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, w, h);
    sketchRect(x, y, w, h, seed, 1.8);
    if (compact) {
      // 单行：公式居左，数值右对齐
      ctx.fillStyle = INK;
      ctx.font = '700 9.5px "Caveat","KaiTi",cursive';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(formula, x + 7, y + h / 2);
      if (value !== null && value !== '') {
        ctx.fillStyle = INK_SOFT;
        ctx.font = '600 8px "Caveat","KaiTi",cursive';
        ctx.textAlign = 'right';
        ctx.fillText(value, x + w - 7, y + h / 2);
      }
    } else {
      ctx.fillStyle = INK;
      ctx.font = '700 11px "Caveat","KaiTi",cursive';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      if (value !== null && value !== '') {
        ctx.fillText(formula, x + 8, y + h * 0.33);
        ctx.fillStyle = INK_SOFT;
        ctx.font = '600 9px "Caveat","KaiTi",cursive';
        ctx.fillText(value, x + 8, y + h * 0.72);
      } else {
        ctx.fillText(formula, x + 8, y + h / 2);
      }
    }
    ctx.restore();
  }

  /* S1 分块托盘（装配清单，弹入 + 出发点亮 + 丢失红叉） */
  function drawS1Tray() {
    if (L.hideTrays || !s1Chips.length) return;
    const cw = 20, ch = 13, gap = 3;
    const per = Math.max(1, Math.floor((L.tray1W + gap) / (cw + gap)));
    s1Chips.forEach((chip, idx) => {
      const row = Math.floor(idx / per), col = idx % per;
      const x = L.tray1X + col * (cw + gap);
      const y = L.tray1Top + row * (ch + gap);
      let sc = 1;
      if (!reducedMotion) {
        const appear = clamp((chip.t - idx * 0.12) / 0.4, 0, 1);
        sc = appear >= 1 ? 1 : 0.4 + 0.6 * easeOutBack(appear);
      }
      ctx.save();
      ctx.translate(x + cw / 2, y + ch / 2);
      ctx.scale(sc, sc);
      ctx.translate(-(x + cw / 2), -(y + ch / 2));
      const st = chip.status; // prep | sent | lost
      ctx.fillStyle = st === 'sent' ? NOTE[2] : st === 'lost' ? NOTE[1] : '#fffdf6';
      ctx.fillRect(x, y, cw, ch);
      sketchRect(x, y, cw, ch, 200 + chip.sn, st === 'lost' ? 1.8 : 1.5);
      ctx.fillStyle = st === 'lost' ? COLOR.fail : INK;
      ctx.font = '700 8.5px "Caveat","KaiTi",cursive';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('B' + chip.sn, x + cw / 2, y + ch / 2);
      if (st === 'lost') {
        sketchLine(x + 4, y + 4, x + cw - 4, y + ch - 4, 210 + chip.sn, 1.4, COLOR.fail);
        sketchLine(x + cw - 4, y + 4, x + 4, y + ch - 4, 212 + chip.sn, 1.4, COLOR.fail);
      }
      ctx.restore();
    });
  }

  /* S3 到达托盘（按到达顺序排布，绿勾 / 红叉槽位，恢复翻绿） */
  function drawS3Tray() {
    if (L.hideTrays || !s3Tray.length) return;
    const cw = 26, ch = 16, gap = 4;
    const per = Math.max(1, Math.floor((L.tray3W + gap) / (cw + gap)));
    s3Tray.forEach((e, idx) => {
      const row = Math.floor(idx / per), col = idx % per;
      const x = L.tray3X + col * (cw + gap);
      const y = L.tray3Top + row * (ch + gap);
      let sc = 1;
      if (!reducedMotion) {
        const appear = clamp(e.t / 0.35, 0, 1);
        sc = appear >= 1 ? 1 : 0.5 + 0.5 * easeOutBack(appear);
      }
      ctx.save();
      ctx.translate(x + cw / 2, y + ch / 2);
      ctx.scale(sc, sc);
      ctx.translate(-(x + cw / 2), -(y + ch / 2));
      const ok = e.status === 'arrived' || e.status === 'recovered';
      const lost = e.status === 'lost';
      ctx.fillStyle = ok ? NOTE[3] : lost ? NOTE[1] : '#fffdf6';
      ctx.fillRect(x, y, cw, ch);
      sketchRect(x, y, cw, ch, 300 + e.sn, ok ? 1.8 : 1.5);
      ctx.fillStyle = INK;
      ctx.font = '700 9.5px "Caveat","KaiTi",cursive';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('B' + e.sn, x + 5, y + ch / 2 + 0.5);
      if (ok) {
        // 绿色对勾
        ctx.strokeStyle = '#3f8f4e';
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(x + cw - 11, y + ch / 2 - 1);
        ctx.lineTo(x + cw - 7.5, y + ch / 2 + 2);
        ctx.lineTo(x + cw - 3.5, y + ch / 2 - 3);
        ctx.stroke();
      } else if (lost) {
        // 红叉槽位
        sketchLine(x + cw - 10, y + ch / 2 - 3, x + cw - 4, y + ch / 2 + 2, 310 + e.sn, 1.8, COLOR.fail);
        sketchLine(x + cw - 4, y + ch / 2 - 3, x + cw - 10, y + ch / 2 + 2, 312 + e.sn, 1.8, COLOR.fail);
      }
      ctx.restore();
    });
  }

  /* 数据块（旋转便签卡 + 负载条 + 状态点；到达块已落入托盘） */
  function drawBlocks() {
    blocks.forEach(b => {
      if (b.x === undefined || b.y === undefined) return;
      if (b.status === 'arrived') return;
      const w = Math.min(46, 30 + b.size * 0.06);
      const h = 22;

      if (b.status === 'lost') {
        // 丢失：虚线框 + 手绘叉 + 红色状态点
        ctx.save();
        ctx.translate(b.x, b.y);
        ctx.rotate(blockAngle(b.sn));
        ctx.globalAlpha = 0.8;
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = COLOR.fail;
        ctx.lineWidth = 2;
        ctx.strokeRect(-w / 2, -h / 2, w, h);
        ctx.setLineDash([]);
        ctx.strokeStyle = COLOR.fail;
        sketchLine(-w / 2 + 6, -h / 2 + 6, w / 2 - 6, h / 2 - 6, b.sn + 3, 2, COLOR.fail);
        sketchLine(w / 2 - 6, -h / 2 + 6, -w / 2 + 6, h / 2 - 6, b.sn + 5, 2, COLOR.fail);
        ctx.beginPath();
        ctx.arc(w / 2 - 6, -h / 2 + 6, 3, 0, Math.PI * 2);
        ctx.fillStyle = COLOR.fail;
        ctx.fill();
        ctx.restore();
        return;
      }

      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(blockAngle(b.sn));
      // 纸片硬阴影
      ctx.fillStyle = 'rgba(46, 59, 78, 0.16)';
      ctx.fillRect(-w / 2 + 2.5, -h / 2 + 3, w, h);
      // 便签纸卡
      const fill = b.status === 'retransmit' ? NOTE[1] : noteColor(b.sn);
      ctx.fillStyle = fill;
      ctx.fillRect(-w / 2, -h / 2, w, h);
      sketchRect(-w / 2, -h / 2, w, h, b.sn + 1, 2);
      // 手写标签
      ctx.fillStyle = INK;
      ctx.font = '700 11px "Caveat","KaiTi",cursive';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('B' + b.sn, 0, 0);
      // 微型负载条（宽度 ∝ 块大小）
      const bw = Math.max(4, Math.min(w - 14, (b.size / maxBlockSize) * (w - 14)));
      ctx.fillStyle = 'rgba(91,141,217,0.5)';
      ctx.fillRect(-w / 2 + 7, h / 2 - 6, bw, 3);
      ctx.strokeStyle = 'rgba(46,59,78,0.45)';
      ctx.lineWidth = 1;
      ctx.strokeRect(-w / 2 + 7, h / 2 - 6, bw, 3);
      // 状态圆点（飞行中蓝色）
      ctx.beginPath();
      ctx.arc(w / 2 - 6, -h / 2 + 6, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#5b8dd9';
      ctx.fill();
      ctx.restore();
    });
  }

  /* 重传请求标记（手绘小叉） */
  function drawReqs() {
    reqs.forEach((r, ri) => {
      ctx.save();
      ctx.translate(r.x, r.y);
      ctx.rotate(ri % 2 ? 0.5 : -0.4);
      ctx.strokeStyle = COLOR.fail;
      ctx.lineWidth = 2.4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-4 + jx(ri, 7), -4 + jy(ri, 7));
      ctx.lineTo(4 + jx(ri + 3, 7), 4 + jy(ri + 3, 7));
      ctx.moveTo(4 + jx(ri + 5, 7), -4 + jy(ri + 5, 7));
      ctx.lineTo(-4 + jx(ri + 8, 7), 4 + jy(ri + 8, 7));
      ctx.stroke();
      ctx.restore();
    });
  }

  /* 底部传输进度线（红色手绘填充条，空闲为空） */
  function drawProgress() {
    const frac = blockCount ? Math.min(1, s3Tray.length / blockCount) : 0;
    const y = L.progressY, x0 = 14, x1 = W - 14;
    // 左侧小字
    ctx.fillStyle = INK_SOFT;
    ctx.font = '600 10px "Caveat","KaiTi",cursive';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('传输进度', x0, L.progressLabelY);
    // 手绘虚线基准线
    ctx.save();
    ctx.setLineDash([5, 5]);
    sketchLine(x0, y, x1, y, 400, 2, 'rgba(46,59,78,0.4)');
    ctx.restore();
    // 红色手绘填充条
    if (frac > 0) {
      const fw = Math.max(6, (x1 - x0) * frac);
      ctx.fillStyle = 'rgba(224,86,79,0.7)';
      ctx.fillRect(x0, y - 5, fw, 6);
      sketchLine(x0, y - 5, x0 + fw, y - 5, 401, 1.5, 'rgba(224,86,79,0.9)');
      sketchLine(x0, y - 5, x0 + fw, y - 5, 402, 1.5, 'rgba(224,86,79,0.9)');
    }
  }

  // 手绘小星
  function drawStar(cx, cy, r, color, seed) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((seed % 2 ? 1 : -1) * 0.5);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    const inner = r * 0.42;
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2 - Math.PI / 2;
      const rad = i % 2 === 0 ? r : inner;
      const px = Math.cos(ang) * rad + jx(i, seed);
      const py = Math.sin(ang) * rad + jy(i, seed);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // 节点便签卡（含手绘设备图形）
  function drawNode(node, tag, label, fill, rot, device) {
    const { x, y, w, h } = node;
    ctx.save();
    ctx.translate(x + w / 2, y + h / 2);
    ctx.rotate(rot * Math.PI / 180);
    ctx.translate(-(x + w / 2), -(y + h / 2));
    // 纸片硬阴影
    ctx.fillStyle = 'rgba(46, 59, 78, 0.15)';
    ctx.fillRect(x + 3.5, y + 4, w, h);
    // 便签填充
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, w, h);
    // 手绘描边
    sketchRect(x, y, w, h, tag === 'S' ? 2 : 8, 2.4);
    // 手绘设备图形
    drawDevice(x + w - 26, y + 8, device, tag === 'S' ? 5 : 9);
    // 标签
    ctx.fillStyle = INK;
    ctx.font = '800 20px "Caveat","KaiTi",cursive';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(tag, x + w / 2, y + h / 2 - 9);
    ctx.font = '700 12px "Ma Shan Zheng","KaiTi",cursive';
    ctx.fillText(label, x + w / 2, y + h / 2 + 12);
    // 蜡笔识别块
    ctx.fillStyle = tag === 'S' ? '#5b8dd9' : '#5fa86b';
    ctx.fillRect(x + 5, y + 8, 6, h - 16);
    ctx.restore();
  }

  /* 手绘设备图形：server = 服务器机箱，terminal = 终端显示器 */
  function drawDevice(x, y, type, seed) {
    ctx.save();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.7;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (type === 'server') {
      // 双机箱 + 指示灯
      ctx.beginPath();
      ctx.moveTo(x + 1 + jx(seed, 1), y + jy(seed, 1));
      ctx.lineTo(x + 15 + jx(seed + 2, 1), y + jy(seed + 2, 1));
      ctx.lineTo(x + 15 + jx(seed + 3, 1), y + 5 + jy(seed + 3, 1));
      ctx.lineTo(x + 1 + jx(seed + 4, 1), y + 5 + jy(seed + 4, 1));
      ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x + 1 + jx(seed + 5, 1), y + 7 + jy(seed + 5, 1));
      ctx.lineTo(x + 15 + jx(seed + 6, 1), y + 7 + jy(seed + 6, 1));
      ctx.lineTo(x + 15 + jx(seed + 7, 1), y + 12 + jy(seed + 7, 1));
      ctx.lineTo(x + 1 + jx(seed + 8, 1), y + 12 + jy(seed + 8, 1));
      ctx.closePath();
      ctx.stroke();
      ctx.fillStyle = '#5b8dd9';
      ctx.fillRect(x + 3, y + 9, 2.5, 2.5);
    } else {
      // 显示器 + 底座 + 屏幕线
      ctx.beginPath();
      ctx.moveTo(x + 1 + jx(seed, 1), y + jy(seed, 1));
      ctx.lineTo(x + 15 + jx(seed + 2, 1), y + jy(seed + 2, 1));
      ctx.lineTo(x + 15 + jx(seed + 3, 1), y + 10 + jy(seed + 3, 1));
      ctx.lineTo(x + 1 + jx(seed + 4, 1), y + 10 + jy(seed + 4, 1));
      ctx.closePath();
      ctx.stroke();
      ctx.strokeStyle = 'rgba(46,59,78,0.45)';
      ctx.beginPath();
      ctx.moveTo(x + 3, y + 3);
      ctx.lineTo(x + 13, y + 3);
      ctx.moveTo(x + 3, y + 6);
      ctx.lineTo(x + 10, y + 6);
      ctx.stroke();
      ctx.strokeStyle = INK;
      ctx.beginPath();
      ctx.moveTo(x + 8 + jx(seed + 5, 1), y + 10 + jy(seed + 5, 1));
      ctx.lineTo(x + 8 + jx(seed + 6, 1), y + 13 + jy(seed + 6, 1));
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x + 5 + jx(seed + 7, 1), y + 13 + jy(seed + 7, 1));
      ctx.lineTo(x + 11 + jx(seed + 8, 1), y + 13 + jy(seed + 8, 1));
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ---------- 主循环 ---------- */
  function loop(now) {
    // 容器尺寸自适应（弹性布局下高度可能变化）
    if (canvas.clientWidth !== W || canvas.clientHeight !== H) resize();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    if (txRunning) {
      const all = blocks.length && blocks.every(b => b.status === 'arrived' || b.status === 'lost');
      if (all && departDone) {
        txRunning = false;
        const arrived = blocks.filter(b => b.status === 'arrived').map(b => ({ sn: b.sn, pathName: b.pathName, prob: b.prob }));
        const lost = blocks.filter(b => b.status === 'lost').map(b => ({ sn: b.sn, pathName: b.pathName, byteStart: b.start, size: b.size }));
        const r = txResolve; txResolve = null; txCallbacks = null;
        setTimeout(() => { if (r) r({ arrived, lost }); }, 300);
      }
    }

    update(dt);
    draw();
    raf = requestAnimationFrame(loop);
  }

  /* ---------- 对外 API ---------- */
  const Viz = {
    init,
    startTransmission,
    retransmitBlocks,
    setPathState,
    /* S1 密钥便签（onKey 钩子驱动） */
    setKeyInfo(d) { keyInfo = (d && d.hex) || null; },
    /* S1 密文便签（onCipher 钩子驱动） */
    setCipher(d) { cipherLen = (d && typeof d.len === 'number') ? d.len : null; },
    /* S2 编码模式徽章（onMode 钩子驱动） */
    setMode(cls) { mode = cls || null; },
    /* 活跃分区高亮（onStage 钩子驱动） */
    setActiveZone(z) { activeZone = z || null; },
    /* S3 托盘：RS 纠删恢复后丢失槽位翻绿 */
    markRecovered(sns) {
      (sns || []).forEach(sn => {
        const e = s3Tray.find(x => x.sn === sn);
        if (e && e.status === 'lost') { e.status = 'recovered'; e.t = 0; }
      });
    },
    /* 新一轮开始：复位运行级画布状态（循环重播时由 onBlocks([]) 驱动） */
    beginRun() {
      departDone = false;
      blocks = [];
      reqs = [];
      s1Chips = [];
      s3Tray = [];
      blockCount = 0;
      maxBlockSize = 1;
      keyInfo = null;
      cipherLen = null;
      mode = null;
      activeZone = null;
      badgeFlash = [0, 0, 0];
      opt.probs = [];
    },
    reset() {
      this.beginRun();
      if (txResolve) { const r = txResolve; txResolve = null; txRunning = false; r({ arrived: [], lost: [] }); }
      if (retransResolve) { const r = retransResolve; retransResolve = null; r(); }
    },
  };

  global.Viz = Viz;
})(window);
