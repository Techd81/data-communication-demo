/* ============================================================
 * UI 交互层 —— 控制台 / 日志 / 仪表 / 导航（Hand-Drawn Sketch 风格）
 * 动效：弹性 spring 缓动 300–500ms · 抬起/旋转/按压反馈
 * ============================================================ */
(function () {
  'use strict';

  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];

  /* ================= 初始化 Viz ================= */
  Viz.init($('#viz-canvas'));

  /* ================= 滚动渐显（纯透明度） ================= */
  (function reveals() {
    const els = $$('.reveal');
    if (!('IntersectionObserver' in window)) {
      els.forEach(el => el.classList.add('in'));
      return;
    }
    const io = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add('in');
          io.unobserve(e.target);
        }
      }
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    els.forEach(el => io.observe(el));
  })();

  /* ================= 顶部导航 ================= */
  (function nav() {
    const topbar = $('#topbar');
    const toggle = $('#nav-toggle');
    const navEl = $('#topnav');
    const links = $$('.nav-link');

    window.addEventListener('scroll', () => {
      topbar.classList.toggle('scrolled', window.scrollY > 30);
    }, { passive: true });

    toggle.addEventListener('click', () => {
      toggle.classList.toggle('open');
      navEl.classList.toggle('open');
    });

    // scrollspy
    const map = new Map();
    $$('main section[id]').forEach(s => map.set('#' + s.id, s));
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver(entries => {
        for (const e of entries) {
          if (e.isIntersecting) {
            const id = '#' + e.target.id;
            links.forEach(l => l.classList.toggle('active', l.getAttribute('href') === id));
          }
        }
      }, { rootMargin: '-40% 0px -55% 0px' });
      map.forEach(s => io.observe(s));
    }

    links.forEach(l => l.addEventListener('click', () => {
      toggle.classList.remove('open');
      navEl.classList.remove('open');
    }));
  })();

  /* ================= 控制台 ================= */
  const outI = $('#imp-out'), outS = $('#sec-out'), outB = $('#bw-out'),
        outL = $('#loss-out'), outR = $('#red-out'), outSp = $('#speed-out');

  $('#imp-level').addEventListener('input', e => outI.textContent = e.target.value);
  $('#sec-level').addEventListener('input', e => outS.textContent = (+e.target.value).toFixed(2));
  $('#bw-level').addEventListener('input', e => {
    outB.textContent = (+e.target.value).toFixed(1) + ' Mbps';
    updateMeters();
  });
  $('#loss-level').addEventListener('input', e => {
    outL.textContent = (+e.target.value).toFixed(0) + '%';
    updateMeters();
  });
  $('#red-level').addEventListener('input', e => outR.textContent = e.target.value + ' 符号');
  $('#speed-level').addEventListener('input', e => {
    const v = +e.target.value;
    outSp.textContent = (v / 10).toFixed(1) + '×';
    Engine.setSpeed(v / 10);
  });

  /* 网络仪表 */
  const meterBW = $('#meter-bw'), meterLoss = $('#meter-loss'), meterRTT = $('#meter-rtt');
  const meterBWv = $('#meter-bw-val'), meterLossv = $('#meter-loss-val'), meterRTTv = $('#meter-rtt-val');
  function updateMeters() {
    const B = +$('#bw-level').value;
    const L = +$('#loss-level').value;
    meterBW.style.width = Math.min(100, B / 20 * 100) + '%';
    meterLoss.style.width = Math.min(100, L / 30 * 100) + '%';
    meterBWv.textContent = B.toFixed(1);
    meterLossv.textContent = L + '%';
  }
  (function rttDrift() {
    let rtt = 50;
    setInterval(() => {
      rtt = Math.max(24, Math.min(120, rtt + (Math.random() - 0.5) * 14));
      meterRTT.style.width = Math.min(100, rtt / 120 * 100) + '%';
      meterRTTv.textContent = Math.round(rtt) + 'ms';
    }, 900);
  })();
  updateMeters();

  /* 路径开关 */
  const pathBtns = $$('#path-toggles .path-toggle');
  const CYCLE = ['ok', 'congest', 'fail'];
  pathBtns.forEach((btn, i) => {
    btn.addEventListener('click', () => {
      const cur = btn.classList.contains('fail') ? 'fail' : btn.classList.contains('congest') ? 'congest' : 'ok';
      const next = CYCLE[(CYCLE.indexOf(cur) + 1) % CYCLE.length];
      btn.classList.remove('ok', 'congest', 'fail');
      btn.classList.add(next);
      Viz.setPathState(i, next);
    });
  });

  /* 按钮 */
  $('#log-clear').addEventListener('click', clearLog);
  const btnStart = $('#btn-start'), btnStep = $('#btn-step'),
        btnReset = $('#btn-reset'), btnLoop = $('#btn-loop');

  btnStart.addEventListener('click', () => {
    if (Engine.running && Engine.paused) { Engine.step(); return; }
    if (Engine.running) return;
    Engine.manualStep = false;
    clearLog();
    Engine.run();
  });

  btnStep.addEventListener('click', () => Engine.step());

  btnReset.addEventListener('click', () => {
    Engine.stop();
    Engine.loop = false;
    Viz.reset();
    Viz.setActiveZone(null);
    clearLog();
    clearStage();
    Engine.manualStep = false;
    btnLoop.classList.remove('on');
    $('#loop-label').textContent = '循环';
    setStatus('idle');
  });

  btnLoop.addEventListener('click', () => {
    Engine.loop = !Engine.loop;
    btnLoop.classList.toggle('on', Engine.loop);
    $('#loop-label').textContent = Engine.loop ? '循环中' : '循环';
  });

  /* ================= 引擎钩子 ================= */
  const logBody = $('#log-body');
  const stageChip = $('#stage-chip'), stageName = $('#stage-name');
  const modeValue = $('#mode-value');
  const blockStrip = $('#block-strip');
  const resultBar = $('#result-bar');
  const statusText = $('#topbar-status-text');
  const statusSq = $('#status-sq');
  const progressEl = $('#stage-progress');

  function clearLog() {
    logBody.innerHTML = '<div class="log-empty">等待传输开始…</div>';
  }
  function clearStage() {
    stageChip.textContent = 'S0';
    stageName.textContent = '待命 · 配置参数后开始传输';
    modeValue.textContent = '--';
    modeValue.className = 'mode-value';
    blockStrip.innerHTML = '';
    resultBar.innerHTML = '';
    progressEl.innerHTML = '';
  }
  function setStatus(s) {
    const map = {
      idle: '演示就绪', running: '传输中…', paused: '已暂停 · 点击继续', done: '传输完成',
    };
    statusText.textContent = map[s] || map.idle;
    statusSq.classList.remove('run', 'done');
    if (s === 'running' || s === 'paused') statusSq.classList.add('run');
    if (s === 'done') statusSq.classList.add('done');
  }

  function renderLog(entry) {
    if (logBody.querySelector('.log-empty')) logBody.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'log-line ' + entry.type;
    const spanT = document.createElement('span');
    spanT.className = 'lt';
    spanT.textContent = '[' + entry.time + ']';
    div.appendChild(spanT);
    if (entry.label) {
      const spanL = document.createElement('span');
      spanL.className = 'ln';
      spanL.textContent = entry.label;
      div.appendChild(spanL);
    }
    for (const tok of entry.tokens) {
      const s = document.createElement('span');
      s.className = tok.t === 'kf' ? 'kf' : tok.t === 'kv' ? 'kv' : '';
      s.textContent = tok.v;
      div.appendChild(s);
    }
    logBody.appendChild(div);
    logBody.scrollTop = logBody.scrollHeight;
  }

  function renderProgress(idx, total) {
    if (!progressEl.children.length || progressEl.children.length !== total) {
      progressEl.innerHTML = '';
      for (let i = 0; i < total; i++) {
        const d = document.createElement('div');
        d.className = 'sp-dot';
        progressEl.appendChild(d);
      }
    }
    [...progressEl.children].forEach((d, i) => {
      d.classList.toggle('done', i < idx);
      d.classList.toggle('current', i === idx);
    });
  }

  function renderBlocks(list) {
    blockStrip.innerHTML = '';
    if (!list.length) return;
    const hint = document.createElement('span');
    hint.className = 'strip-hint';
    hint.textContent = '数据块';
    blockStrip.appendChild(hint);
    list.forEach((b, i) => {
      const chip = document.createElement('div');
      chip.className = 'block-chip' + (b.status ? ' ' + b.status : '');
      // 偶数芯片反向旋转，制造「手贴便签」的错落感
      if (i % 2 === 1) chip.style.setProperty('--rot', '1.8deg');
      chip.innerHTML = `<span class="b-sn">B${b.sn}</span><span class="b-id">${b.id || ''}</span>`;
      chip.title = `ID: ${b.id} · ${b.size}B`;
      blockStrip.appendChild(chip);
    });
  }

  function renderResult(res) {
    if (!res) { resultBar.innerHTML = ''; return; }
    const modeName = res.mode === 'rs' ? 'RS 纠删码' : 'Huffman 高效编码';
    resultBar.innerHTML = `
      <div class="result-panel">
        <div class="result-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="square"><path d="M20 6 9 17l-5-5"/></svg>
        </div>
        <div class="result-body">
          <div class="result-title">传输完成 · 数据成功还原
            <span class="result-meta">模式：${modeName} · ${res.blocks} 个数据块 · 密文 ${res.cipher}B</span>
          </div>
          <pre class="result-json">${escapeHtml(res.json)}</pre>
        </div>
      </div>`;
    resultBar.scrollIntoView({ behavior: 'auto', block: 'nearest' });
  }

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  Engine.setHooks({
    onLog: renderLog,
    onStage(chip, name) {
      stageChip.textContent = chip;
      stageName.textContent = name;
      Viz.setActiveZone(chip.slice(0, 2));
    },
    onProgress: renderProgress,
    onMode(label, cls) {
      modeValue.textContent = label;
      modeValue.className = 'mode-value ' + cls;
      Viz.setMode(cls);
    },
    onBlocks(list) {
      renderBlocks(list);
      if (!list.length) { Viz.beginRun(); return; }
      const rec = list.filter(b => b.status === 'recovered').map(b => b.sn);
      if (rec.length) Viz.markRecovered(rec);
    },
    onKey: d => Viz.setKeyInfo(d),
    onResult: renderResult,
    onStatus: setStatus,
  });
})();
