/* InkThink 草稿纸前端：书写、记录书写过程、「AI」按钮（把这一页交给 Claude）、把 Claude 的回应用手写风格写回页面。
 * 页面坐标：正文区 x 0–1000，页边 x 1000–1380，y 从 0 到页高（草稿纸 1414，书页按 PDF 比例）。 */
'use strict';
(function () {
  const W = 1000, M = 380, TW = W + M, SCRATCH_H = 1414;
  const INK = '#1b1b1b', RED = '#d23c2e', AI = '#2f5fae', ERASED = '#c3c3c3'; // 擦掉的笔迹用浅灰（红色留给「问 Claude」的红笔）
  const ADOPTED = '#1f3d7a'; // 采纳的蓝字：深蓝（纸上的样式、服务器画的图 pages.py 的 ADOPTED 都是这个颜色）
  const inkOf = (st) => (st.c === 'r' ? RED : INK); // 回答过的红笔问题不变淡（2026-11-02：回答收进弹窗，不再挡着，变淡没必要）
  const PEN_W = 2.1;
  const TOP_SAFE = 44; // 全屏时屏幕顶端这一条碰了会让 Safari 退出全屏：标签、右下角那一条都不放在这里
  const NOTE_W = M - 44, NOTE_FS = 21, NOTE_LH = 29;
  const noteX = () => S.W + 22; // 页边批注的位置：页面拉宽后页边跟着往右挪
  const FONT = '"Xiaolai", "Kaiti SC", STKaiti, KaiTi, "PingFang SC", sans-serif';
  const PALM_MS = 1000; // 笔落下、抬起后这么久里手指轻点不算（多半是手掌）
  // 按钮上的线条图标（24×24，描边用 currentColor）；按钮写 data-icon="名字"，说明写在 aria-label 里（长按看）
  const ICONS = {
    pen: '<path d="M4 20l1.2-4.6L15.6 5a2 2 0 0 1 2.8 0l.6.6a2 2 0 0 1 0 2.8L8.6 18.8z"/><path d="M14 6.6l3.4 3.4"/>',
    eraser: '<path d="M9 20h11"/><path d="M5.2 14.8l8.6-8.6a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L11.1 19a2 2 0 0 1-1.4.6H8.4a2 2 0 0 1-1.4-.6l-1.8-1.8a1.6 1.6 0 0 1 0-2.4z"/><path d="M9.4 10.6l4 4"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
    edit: '<path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="M13.5 8.5l3 3"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    trash: '<path d="M4 7h16"/><path d="M9 7V4.5h6V7"/><path d="M6.5 7l1 12.5h9l1-12.5"/><path d="M10 11v5M14 11v5"/>',
    save: '<path d="M12 4v11"/><path d="M7.5 10.5L12 15l4.5-4.5"/><path d="M5 19.5h14"/>',
    rotl: '<path d="M9 4H4v5"/><path d="M4.6 9A8 8 0 1 1 7 18"/>',
    rotr: '<path d="M15 4h5v5"/><path d="M19.4 9A8 8 0 1 0 17 18"/>',
    addv: '<path d="M6 2.5h8.5l4 4v15H6z"/><path d="M14.5 2.5v4h4"/><path d="M12.2 10v7.5M8.5 13.8H16"/>', // 带折角的竖页，加号在中间
    addh: '<path d="M2.5 5.5h15l4 4v9h-19z"/><path d="M17.5 5.5v4h4"/><path d="M12 10.5v6M9 13.5h6"/>',     // 带折角的横页
    single: '<path d="M6 2.5h8.5l4 4v15H6z"/><path d="M14.5 2.5v4h4"/>', // 单页：一张带折角的纸
    cont: '<path d="M3.5 2.5h8l2.5 2.5v6H3.5z"/><path d="M11.5 2.5V5H14"/><path d="M3.5 13h10.5v8.5H3.5z"/><path d="M19 3.5v15.5M16.5 16.5L19 19l2.5-2.5"/>', // 连续：上下两张纸，旁边一个向下的箭头
    folder: '<path d="M3.5 7A1.5 1.5 0 0 1 5 5.5h4.2l2 2.2H19a1.5 1.5 0 0 1 1.5 1.5v8.3A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"/>', // 文件夹：带一个小耳朵
  };
  const FLOW_GAP = 40, FLOW_MAX = 3, FLOW_KEEP = 4; // 连续阅读：页缝、上下各画几页、缓存留前后几页
  const GROUP_GAP_MS = 1800, GROUP_DIST = 60;
  const TAP_MS = 450, SLOP = 8; // 手指轻点：不到这么久、挪了不到这么多像素
  // 长回答的圈号（2026-11-13：长回答不上纸，纸上只留圈号，点开是浮出的卡片）：半径、数字字号（页面单位）、离字多远、到达时跳两下用多久
  const BADGE_R = 13, BADGE_FS = 17, BADGE_GAP = 16, HOP_MS = 900;
  // 卡片里的字按这个固定宽度排版（2026-11-14），外面按屏幕整体缩放：换屏幕大小、横竖屏，换行一样，卡片上的红字不错位。
  // 服务端按平板量下的排版画图给 Claude（pages.py 的 CARD_W 是同一个数）
  const CARD_W = 440;
  const CARD_PAN = 24; // 卡片开着时，纸上的手指挪过这么多像素才算挪纸、收起卡片（搭着的手掌晃一点不算）
  // 交上去以后一直没有下一步（插件没取、对话关了、连不上……）：过这么久，「AI」按钮上的进度收回，变回「AI」
  const ROUND_WAIT_MS = 10 * 60 * 1000;
  const NS = 'http://www.w3.org/2000/svg';

  const $ = (s) => document.querySelector(s);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const r1 = (v) => Math.round(v * 10) / 10;
  const f1 = (v) => (Math.round(v * 10) / 10).toString();
  const n1 = (v) => Math.round(v * 10) / 10; // 存进数据的坐标：保留一位小数的数
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  // 记在这台设备上的小设置（全屏与否、右下角那一条的位置、上次看到哪一页……）
  const store = {
    get(k, d) { try { const v = localStorage.getItem('inkthink.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('inkthink.' + k, JSON.stringify(v)); } catch (e) { /* 隐私模式 */ } },
  };

  // ------------------------------------------------------------ 访问码与接口

  const params = new URLSearchParams(location.search);
  let CODE = params.get('k') || store.get('k', '');
  const CID = Math.random().toString(36).slice(2, 10); // 这一个页面的编号：服务端据此分辨「同一台设备连着存」和「别处改过」
  let TOKEN = store.get('device', ''); // 配对后只属于这台设备的令牌；有了它就不再用访问码
  if (params.get('k')) store.set('k', CODE);

  async function api(path, opts) {
    const o = Object.assign({}, opts || {});
    o.headers = Object.assign(TOKEN ? { 'X-Device': TOKEN } : { 'X-Access': CODE }, { 'X-Client': CID }, o.headers || {});
    const r = await fetch(path, o);
    if (r.status === 401) { // 令牌被断开了，或访问码换了：回到输入访问码
      if (TOKEN) { TOKEN = ''; store.set('device', ''); }
      showLocked();
      throw new Error('访问码不对');
    }
    if (!r.ok) {
      let msg = r.statusText;
      try { msg = (await r.json()).error || msg; } catch (e) { /* 不是 JSON */ }
      const err = new Error(msg);
      err.status = r.status;
      throw err;
    }
    return r;
  }

  // ------------------------------------------------------------ 状态

  const S = {
    cfg: null,
    flow: false, flowCache: new Map(), flowGen: 0, // 连续阅读：开关、相邻页的缓存（页号 → {page, img, url, undo}）
    nb: null, idx: 0, pageH: SCRATCH_H, baseH: SCRATCH_H, baseH0: SCRATCH_H, page: null, bgImg: null, bgUrl: null, // baseH0：没转时的底图高度
    W: W, TW: TW, M: M, // 这一页正文区宽度、连页边的总宽度、页边宽度（书页默认不留页边）
    storedH: SCRATCH_H, // 这一页存下来的高度；显示时可能更高（纸填满屏幕），多出来的不写字就不存
    X0: 0, Y0: 0, // 纸的左边、上边（向左、向上扩过就是负数；原来的内容坐标不变）
    // 默认全屏（只有纸）；退出过全屏（要顶栏和左侧工具栏）就记在 bars 里
    collapsed: !store.get('bars', false),
    tool: 'pen',
    fingerDraw: store.get('finger', false),
    aiVisible: store.get('aiv', true),
    view: { s: 1, tx: 0, ty: 0 }, drawn: null, fitMode: 'width', fitS: 1,
    cur: null, erasing: null,
    undo: [],
    undos: new Map(), // 连续阅读：每页的撤销记录（本子#页 → 记录），离开再远回来也还在；换本子、加删页时清掉
    aiQueue: Promise.resolve(), renderGen: 0,
    dirty: false, saveTimer: null, saving: false,
    replay: null,
    // 与 Claude Code 对话的连接
    sessions: [], defaultTarget: null, // 连着的对话（最近打字的在前）；没绑过对话的本子发往 defaultTarget
    evSeq: 0, online: false,
    folders: [], // 抽屉里的文件夹（只是归类，记在电脑上）：[{id, name, items: [本子 id], folded?}]
    // 「AI」按钮上的进度：mine 是这个页面交出去的投递（编号 → 哪本）；rounds 是每本最近交的那一轮（本子 → {id, stage, t, end}）；
    // roundWait 是一直没有下一步时等多久（测试里调短）；checking 是点了「AI」、还没交出去（防连点交两次）
    mine: new Map(), rounds: new Map(), roundWait: ROUND_WAIT_MS, checking: false,
    // 顶上的卡片（问话卡片、字迹确认卡片，一个队）：cards 按先后排，队首那张显示；qShown 是填好的那张、qMin 是缩成了小条；
    // qPad 是手写回答那块纸上的笔迹（qInk 是正写着的一笔）；qBusy 是正在交；qGen 防先发的晚回来；confirmInputs 是确认卡片的更正框
    cards: [], qShown: null, qMin: false, qPad: [], qInk: null, qBusy: false, qGen: 0, qDone: new Set(), confirmInputs: [],
    // 书更新后：对比旧版
    compare: false, verHidden: {},
    // 长回答的卡片：开着的是哪一条（card）、刚收起的是哪一条（cardShut，再点同一个圈号是收起）；刚到的圈号（fresh：id → 到达时刻，跳两下）
    card: null, cardShut: null, fresh: new Map(),
    // 卡片上正在写的一笔红字（cardInk）、正在擦（cardErase）、手指正在滑卡片（cardDrag）
    cardInk: null, cardErase: null, cardDrag: null,
    // 连续阅读：正把 Claude 的回复落到屏幕上的相邻页（landing）；Claude 回在别的页、还没落下的页（本子#页）
    landing: false, pendingPages: new Set(),
  };

  const stage = $('#stage'), cvBg = $('#bg'), cvInk = $('#ink'), cvLive = $('#live');
  const svg = $('#ai'), aiRoot = $('#aiRoot'), texLayer = $('#tex');
  let DPR = 1, VW = 1, VH = 1, stageRect = { left: 0, top: 0, width: 1, height: 1 };
  const measure = document.createElement('canvas').getContext('2d');

  // ------------------------------------------------------------ 视图

  // 舞台在屏幕上的位置：按视口算（和触摸事件的坐标一致），退出全屏后页面被系统滚动过也不错位
  function measureStage() {
    const r = stage.getBoundingClientRect();
    stageRect = { left: r.left, top: r.top, width: stage.clientWidth, height: stage.clientHeight };
  }

  function resize() {
    measureStage();
    VW = Math.max(1, stageRect.width);
    VH = Math.max(1, stageRect.height);
    DPR = window.devicePixelRatio || 1;
    for (const c of [cvBg, cvInk, cvLive]) {
      c.width = Math.round(VW * DPR);
      c.height = Math.round(VH * DPR);
      c.style.width = VW + 'px';
      c.style.height = VH + 'px';
    }
    svg.setAttribute('width', VW);
    svg.setAttribute('height', VH);
    if (S.fitMode) fit(S.fitMode); else redrawAll();
    placeVer(); // 右上角的提示条：全屏时和左上角那一排同一行，退出全屏时在顶栏下面
    placeQ(); // 顶上的卡片跟着重新量（转动 iPad、全屏与否）
  }

  const paperW = () => S.TW - S.X0, paperH = () => S.pageH - S.Y0;

  function fit(mode) {
    closeCard(); // 纸面挪了、缩放了：卡片收起
    S.fitMode = mode;
    const pad = S.collapsed ? 0 : 10; // 全屏时纸铺满
    S.pageH = S.storedH;
    const sw = (VW - 2 * pad) / paperW();
    // 纸至少铺到屏幕底（多出来的不写字就不存）。连续阅读时下面接着下一页，只有最后一页这样做（只有一页的空白本子就是最后一页）
    if (mode === 'width' && S.page && (!S.flow || lastPage(S.idx))) S.pageH = Math.max(S.storedH, Math.floor(S.Y0 + (VH - 2 * pad) / sw));
    const sp = Math.min(sw, (VH - 2 * pad) / paperH());
    const s = mode === 'page' ? sp : sw;
    S.fitS = sw;
    const top = S.flow && mode === 'width' ? 0 : Math.max(0, (VH - 2 * pad - paperH() * s) / 2); // 连续阅读：从顶上排起，下一页接在下面
    S.view = { s, tx: (VW - paperW() * s) / 2 - S.X0 * s, ty: pad + top - S.Y0 * s };
    redrawAll();
  }

  // 缩放范围：适配宽度的 0.4–8 倍；纸面至少留 60 像素在屏幕里
  function clampView(v) {
    const s = clamp(v.s, S.fitS * 0.4, S.fitS * 8), w = paperW() * s, m = 60;
    const [y0, y1] = S.flow ? flowSpan() : [S.Y0, S.pageH], h = (y1 - y0) * s; // 连续阅读：连同上下已画出的页
    const lim = (t, size, view) => (size + 2 * m <= view ? clamp(t, m, view - size - m) : clamp(t, view - size - m, m));
    // 夹的是纸的左上角在屏幕上的位置
    return { s, tx: lim(v.tx + S.X0 * s, w, VW) - S.X0 * s, ty: lim(v.ty + y0 * s, h, VH) - y0 * s };
  }

  // 事件的屏幕坐标（横竖屏交给 iPad 自己转：界面内旋转跟不上系统的滚动、键盘和随手写，已去掉）
  function ptOf(e) {
    return [e.clientX, e.clientY];
  }

  function toWorld(cx, cy) {
    const v = S.view;
    return [(cx - stageRect.left - v.tx) / v.s, (cy - stageRect.top - v.ty) / v.s];
  }

  function setT(ctx) {
    const v = S.view;
    ctx.setTransform(DPR * v.s, 0, 0, DPR * v.s, DPR * v.tx, DPR * v.ty);
  }

  function redrawAll() {
    for (const c of [cvBg, cvInk, cvLive]) c.style.transform = '';
    drawBg();
    drawInk();
    drawLive();
    setAiTransform();
    drawNeighborBadges();
    S.drawn = Object.assign({}, S.view);
  }

  // 手势进行中只挪动画布（CSS 变换），松手后再重画
  function previewView() {
    const d = S.drawn || S.view, v = S.view, k = v.s / d.s;
    const t = `translate(${v.tx - d.tx * k}px, ${v.ty - d.ty * k}px) scale(${k})`;
    for (const c of [cvBg, cvInk, cvLive]) c.style.transform = t;
    setAiTransform();
  }

  function setAiTransform() {
    const v = S.view;
    aiRoot.setAttribute('transform', `matrix(${v.s} 0 0 ${v.s} ${v.tx} ${v.ty})`);
    texLayer.style.transform = `matrix(${v.s}, 0, 0, ${v.s}, ${v.tx}, ${v.ty})`; // 公式那层跟着一起缩放
    placeEdgeTabs();
  }

  // 纸的下边、右边各一个小标签：点一下加长 / 加宽；放在看得见的那段边的中间
  function placeEdgeTabs() {
    const d = $('#extDown'), r = $('#extRight'), u = $('#extUp'), l = $('#extLeft'), v = S.view;
    if (!S.page || S.replay) { d.hidden = r.hidden = u.hidden = l.hidden = true; return; }
    const left = v.tx + S.X0 * v.s, right = v.tx + S.TW * v.s, top = v.ty + S.Y0 * v.s, bottom = v.ty + S.pageH * v.s;
    const midX = (clamp(left, 0, VW) + clamp(right, 0, VW)) / 2, midY = (clamp(top, 0, VH) + clamp(bottom, 0, VH)) / 2;
    d.hidden = bottom < 0 || bottom > VH || right < 0 || left > VW;
    r.hidden = right < 0 || right > VW || bottom < 0 || top > VH;
    // 纸边外面放不下（比如适配宽度时纸贴着屏幕边）：放到纸边里面
    if (!d.hidden) {
      const y = bottom + 6 + d.offsetHeight > VH - 2 ? bottom - d.offsetHeight - 4 : bottom + 6;
      d.style.left = `${midX - d.offsetWidth / 2}px`;
      d.style.top = `${y}px`;
    }
    if (!r.hidden) {
      const x = right + 6 + r.offsetWidth > VW - 2 ? right - r.offsetWidth - 4 : right + 6;
      r.style.left = `${x}px`;
      r.style.top = `${midY - r.offsetHeight / 2}px`;
    }
    u.hidden = top < 0 || top > VH || right < 0 || left > VW;
    l.hidden = left < 0 || left > VW || bottom < 0 || top > VH;
    if (!u.hidden) {
      const safe = S.collapsed ? TOP_SAFE : 2; // 全屏时屏幕最顶端归 Safari，标签别放在那儿
      const y = top - 6 - u.offsetHeight < safe ? Math.max(top + 4, safe) : top - 6 - u.offsetHeight;
      u.style.left = `${midX - u.offsetWidth / 2}px`;
      u.style.top = `${y}px`;
    }
    if (!l.hidden) {
      const x = left - 6 - l.offsetWidth < 2 ? left + 4 : left - 6 - l.offsetWidth;
      l.style.left = `${x}px`;
      l.style.top = `${midY - l.offsetHeight / 2}px`;
    }
  }

  // ------------------------------------------------------------ 绘制

  function paintPaper(ctx, opts) {
    paintSheet(ctx, { X0: S.X0, Y0: S.Y0, W: S.W, M: S.M, TW: S.TW, pageH: S.pageH, baseH: S.baseH, baseH0: S.baseH0,
      rot: (S.page && S.page.rot) || 0 }, S.bgImg, opts);
  }

  // 一张纸：白底、页边、底图（转过的照转）、点阵；G 见 geomOf
  function paintSheet(ctx, G, img, opts) {
    const pw = G.TW - G.X0, ph = G.pageH - G.Y0;
    ctx.fillStyle = '#fff';
    ctx.fillRect(G.X0, G.Y0, pw, ph);
    ctx.fillStyle = '#faf8f3';
    if (G.M) ctx.fillRect(G.W, G.Y0, G.M, ph);
    if (img) {
      ctx.save();
      ctx.transform(...Turn.between(0, G.rot || 0, G.baseH0)); // 没转的底图画进转后的位置
      ctx.drawImage(img, 0, 0, W, G.baseH0 || G.pageH);
      ctx.restore();
    }
    if (opts && opts.grid) {
      // 点阵：书页、推送页的底图以外（向左、向上扩出来和加长出来的白纸）也有
      ctx.fillStyle = '#d8d3c8';
      const bh = img ? G.baseH : -Infinity;
      for (let y = Math.ceil(G.Y0 / 40) * 40 || 40; y < G.pageH; y += 40) {
        for (let x = Math.ceil(G.X0 / 40) * 40 || 40; x < G.W; x += 40) {
          if (y > 0 && y < bh && x > 0 && x < W) continue;
          ctx.fillRect(x - 0.9, y - 0.9, 1.8, 1.8);
        }
      }
    }
    if (!G.M) return;
    ctx.strokeStyle = '#e3dccd';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(G.W, G.Y0);
    ctx.lineTo(G.W, G.pageH);
    ctx.stroke();
  }

  // 页缝里的页码是画在画布上的，i18n.js 换不到，这里自己过一遍对照表
  const pageLabel = (i) => (window.InkLang ? window.InkLang.t(`第 ${i + 1} 页`) : `第 ${i + 1} 页`);

  function drawBg() {
    const ctx = cvBg.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#e8e5df';
    ctx.fillRect(0, 0, cvBg.width, cvBg.height);
    if (!S.page) return;
    setT(ctx);
    const strip = flowStrip();
    for (const n of strip) paintNeighbor(ctx, n);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.16)';
    ctx.shadowBlur = 10 * DPR;
    ctx.fillStyle = '#fff';
    ctx.fillRect(S.X0, S.Y0, paperW(), paperH());
    ctx.restore();
    paintPaper(ctx, { grid: true });
    if (S.flow) { // 页缝里的页码（写在每页的上面，靠左：中间是「＋ 向上」「＋ 加长」）
      ctx.fillStyle = '#9a9488';
      ctx.font = '20px -apple-system, "PingFang SC", sans-serif';
      const tops = [[S.idx, S.Y0]].concat(strip.map((n) => [n.i, n.D + n.G.Y0]));
      for (const [i, top] of tops) if (i > 0) ctx.fillText(pageLabel(i), 16, top - FLOW_GAP / 2 + 7);
    }
  }

  // 连续阅读：相邻的一页画在底图画布上（纸、底图、笔迹、Claude 的批注），整体下移 D。
  // 长回答的圈号不画在这里：和当前页的一样画在批注层上（drawNeighborBadges），点得到、到达时会跳
  function paintNeighbor(ctx, n) {
    const G = n.G, pg = n.ent.page;
    ctx.save();
    ctx.translate(0, n.D);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.16)';
    ctx.shadowBlur = 10 * DPR;
    ctx.fillStyle = '#fff';
    ctx.fillRect(G.X0, G.Y0, G.TW - G.X0, G.pageH - G.Y0);
    ctx.restore();
    paintSheet(ctx, G, n.ent.img, { grid: true });
    for (const st of inkStrokes(pg)) if (!st.erasedAt) drawStroke(ctx, st, inkOf(st));
    if (S.aiVisible) paintAiForModel(ctx, pg, false);
    ctx.restore();
  }

  // 连续阅读：已经取来的相邻页，由近到远；D 加到那一页的坐标上就是当前页的坐标。往上、往下各铺够一屏半就停
  function flowStrip() {
    const out = [];
    if (!S.flow || !S.page || !S.nb) return out;
    const reach = 1.5 * VH / S.view.s;
    let top = S.pageH + FLOW_GAP;
    for (let i = S.idx + 1; i < S.nb.pages && i <= S.idx + FLOW_MAX && top - S.pageH < reach; i++) {
      const ent = S.flowCache.get(i);
      if (!ent) break;
      const G = geomOf(ent.page, i), D = top - G.Y0;
      out.push({ i, D, G, ent });
      top = D + G.pageH + FLOW_GAP;
    }
    let bottom = S.Y0 - FLOW_GAP;
    for (let i = S.idx - 1; i >= 0 && i >= S.idx - FLOW_MAX && S.Y0 - bottom < reach; i--) {
      const ent = S.flowCache.get(i);
      if (!ent) break;
      const G = geomOf(ent.page, i), D = bottom - G.pageH;
      out.push({ i, D, G, ent });
      bottom = D + G.Y0 - FLOW_GAP;
    }
    return out;
  }

  // 连续阅读时能拖到的上下范围（当前页的坐标）：连同已经画出来的相邻页
  function flowSpan() {
    let y0 = S.Y0, y1 = S.pageH;
    for (const n of flowStrip()) { y0 = Math.min(y0, n.D + n.G.Y0); y1 = Math.max(y1, n.D + n.G.pageH); }
    return [y0, y1];
  }

  // 连续阅读：把前后几页的页面数据和底图取来（铺够一屏半、最多各 FLOW_MAX 页），远的放掉
  async function ensureNeighbors() {
    if (!S.flow || !S.nb || !S.page) return;
    const nb = S.nb, idx = S.idx, gen = S.flowGen, reach = 1.5 * VH / S.view.s, want = [];
    const height = (i) => { const e = S.flowCache.get(i); return e ? geomOf(e.page, i).pageH : (nb.sizes && nb.sizes[i] ? nb.sizes[i].h : SCRATCH_H); };
    for (let i = idx + 1, acc = 0; i < nb.pages && i <= idx + FLOW_MAX && acc < reach; i++) { want.push(i); acc += height(i) + FLOW_GAP; }
    for (let i = idx - 1, acc = 0; i >= 0 && i >= idx - FLOW_MAX && acc < reach; i--) { want.push(i); acc += height(i) + FLOW_GAP; }
    for (const [i, e] of S.flowCache) if (Math.abs(i - idx) > FLOW_KEEP) { if (e.url) URL.revokeObjectURL(e.url); S.flowCache.delete(i); }
    const missing = want.filter((i) => !S.flowCache.has(i));
    if (!missing.length) return;
    await Promise.all(missing.map(async (i) => {
      let page, bg = null;
      try {
        const job = pendingSaves.get(nb.id + '#' + i); // 刚离开、还没存上的那页：用排着队的那份
        [page, bg] = await Promise.all([
          job ? JSON.parse(job.body) : api(`/api/page?nb=${encodeURIComponent(nb.id)}&i=${i}`).then((r) => r.json()),
          fetchBg(nb, i).catch(() => null),
        ]);
      } catch (e) { return; }
      if (S.flowGen !== gen || S.nb !== nb || S.flowCache.has(i) || i === S.idx) { if (bg) URL.revokeObjectURL(bg.url); return; }
      S.flowCache.set(i, { page: normalizePage(page), img: bg && bg.img, url: bg && bg.url, undo: [] });
    }));
    if (S.flowGen === gen && S.nb === nb) { redrawAll(); landSoon(); } // 新画出来的相邻页上有 Claude 还没落下的回复：落下
  }

  // 清空相邻页的缓存：换本子、加删页、开关连续阅读时
  function flowReset() {
    for (const e of S.flowCache.values()) if (e.url) URL.revokeObjectURL(e.url);
    S.flowCache.clear();
    S.undos.clear(); // 页号可能变了：各页另存的撤销记录也作废（当前页的还在 S.undo 里）
    S.flowGen++;
  }

  // 连续阅读：把相邻的第 i 页换成当前页。用缓存的数据，马上能写；视图跟着平移 D，屏幕上一点不动
  function activate(i, ent, D) {
    if (S.replay || S.compare) return false;
    queueSave();
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(flushSave, 300);
    S.flowCache.set(S.idx, { page: S.page, img: S.bgImg, url: S.bgUrl, undo: S.undo });
    S.undos.set(pageKey(), S.undo);
    S.flowCache.delete(i);
    S.idx = i;
    S.page = ent.page;
    S.bgImg = ent.img;
    S.bgUrl = ent.url;
    S.undo = S.undos.get(pageKey()) || ent.undo || [];
    if (!S.landing) closeCard(); // 把 Claude 的回复落到相邻页时换过去又换回来，屏幕不动，开着的卡片留着
    S.baseH0 = S.nb.sizes && S.nb.sizes[i] ? S.nb.sizes[i].h : SCRATCH_H;
    layoutPage();
    S.view = Object.assign({}, S.view, { ty: S.view.ty + D * S.view.s });
    showPage();
    redrawAll();
    return true;
  }

  // 连续阅读：拖动、滚动停下时，屏幕中线落在哪一页（页缝算上一页），就把哪一页换成当前页
  function flowCheck() {
    if (!S.flow || !S.page || S.replay || S.compare) return false;
    const cy = (VH / 2 - S.view.ty) / S.view.s;
    if (cy >= S.Y0 && cy <= S.pageH + FLOW_GAP) return false;
    const n = flowStrip().find((m) => cy >= m.D + m.G.Y0 && cy <= m.D + m.G.pageH + FLOW_GAP);
    return n ? activate(n.i, n.ent, n.D) : false;
  }

  // 抽屉最上面两组开关各自选着哪个；全屏时左上角本子名旁边的翻页：这本不止一页就有（连续时也有）；
  // 「单页 / 连续」一对图标（左上角和顶栏上各一对）和抽屉里那组开关同一个状态，当前的那个加框；只有一页的本子没有这一对，
  // 加页加到两页就出来、删回一页就收起；加页图标（左上角和顶栏上各一个）每本都有（抽屉里的加页哪本都能用）
  function updateSegs() {
    const mark = (id, v) => document.querySelectorAll(id + ' button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
    for (const id of ['#segFlow', '#chipPair', '#barPair']) mark(id, S.flow ? 'flow' : 'single');
    mark('#segFit', S.fitMode || ''); // 自己缩放、挪动过以后两个都不选
    const nav = Boolean(S.nb) && S.nb.pages > 1;
    $('#chipPrev').hidden = $('#chipNext').hidden = !nav;
    if (nav) { $('#chipPrev').disabled = S.idx <= 0; $('#chipNext').disabled = S.idx >= S.nb.pages - 1; }
    $('#chipPair').hidden = $('#barPair').hidden = !nav;
    $('#chipAdd').hidden = $('#barAdd').hidden = !S.nb;
  }

  async function toggleFlow() {
    if (!S.nb || !S.page) return;
    S.flow = !S.flow;
    S.nb.flow = S.flow;
    updateSegs();
    flowReset();
    api('/api/notebook/setting', { method: 'POST', body: JSON.stringify({ nb: S.nb.id, key: 'flow', value: S.flow }),
      headers: { 'Content-Type': 'application/json' } }).catch(() => {});
    layoutPage();
    fit(S.fitMode || 'width');
    toast(S.flow ? '连续阅读：上下页接在一起，滚到哪页写哪页' : '单页：一页一页翻', 2200);
    await ensureNeighbors();
  }

  const penWidth = (st, p) => st.w * (0.45 + 0.9 * (p || 0.5));

  function drawStroke(ctx, st, color, from, to) {
    const p = st.pts, n = to === undefined ? p.length : to;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (p.length === 1 && n >= 1 && !from) {
      ctx.beginPath();
      ctx.arc(p[0][0], p[0][1], penWidth(st, p[0][2]) / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    for (let i = Math.max(1, from || 1); i < n; i++) {
      const a = p[i - 1], b = p[i];
      ctx.lineWidth = penWidth(st, (a[2] + b[2]) / 2);
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }
  }

  function drawInk() {
    const ctx = cvInk.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cvInk.width, cvInk.height);
    if (!S.page || S.replay) return;
    setT(ctx);
    for (const st of inkStrokes()) if (!st.erasedAt) drawStroke(ctx, st, inkOf(st));
  }

  function drawLive() {
    const ctx = cvLive.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cvLive.width, cvLive.height);
    setT(ctx);
    if (S.cur) drawStroke(ctx, S.cur, inkOf(S.cur));
    if (S.erasing && S.erasing.at) {
      ctx.strokeStyle = 'rgba(0,0,0,.35)';
      ctx.lineWidth = 1 / S.view.s;
      ctx.beginPath();
      ctx.arc(S.erasing.at[0], S.erasing.at[1], S.erasing.r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // ------------------------------------------------------------ 笔迹数据

  function strokeT1(st) { return st.t0 + (st.pts.length ? st.pts[st.pts.length - 1][3] : 0); }

  function strokeBox(st) {
    if (st._box) return st._box;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of st.pts) {
      if (p[0] < x0) x0 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[0] > x1) x1 = p[0];
      if (p[1] > y1) y1 = p[1];
    }
    const h = st.w;
    st._box = [x0 - h, y0 - h, x1 + h, y1 + h];
    return st._box;
  }

  function boxDist(a, b) {
    const dx = Math.max(0, a[0] - b[2], b[0] - a[2]);
    const dy = Math.max(0, a[1] - b[3], b[1] - a[3]);
    return Math.hypot(dx, dy);
  }

  const unionBox = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];

  /* 把笔迹按「时间相近、位置相近」分组：一组大致是一个字、一个式子或一个图形。
   * 每组记录开始/结束时间、笔数、擦掉了几笔、是否回头补写，这就是发给 AI 的「书写过程」。 */
  function computeGroups(strokes) {
    const ss = strokes.filter((s) => s.pts.length).slice().sort((a, b) => a.t0 - b.t0);
    const groups = [];
    let g = null;
    for (const s of ss) {
      const bb = strokeBox(s), t1 = strokeT1(s);
      if (g && (s.c || '') === g.c && s.t0 - g.t1 < GROUP_GAP_MS && boxDist(bb, g.bbox) < GROUP_DIST) {
        g.bbox = unionBox(g.bbox, bb);
        g.t1 = Math.max(g.t1, t1);
        g.strokes.push(s);
      } else {
        g = { t0: s.t0, t1, bbox: bb.slice(), strokes: [s], c: s.c || '' };
        groups.push(g);
      }
    }
    groups.forEach((gr, i) => {
      gr.id = 'g' + (i + 1);
      gr.n = gr.strokes.length;
      gr.erased = gr.strokes.filter((s) => s.erasedAt).length;
      gr.erasedAt = gr.erased ? Math.max.apply(null, gr.strokes.map((s) => s.erasedAt || 0)) : null;
      gr.revisit = groups.slice(0, i).some((o) => o.t1 < gr.t0 - 30000 && boxDist(o.bbox, gr.bbox) < 24);
    });
    return groups;
  }

  // 整页：页面上所有内容（书页/推送页连同印刷内容），页边写了东西就带上页边
  function wholePageSel() {
    let right = S.W, bottom = S.bgImg ? S.baseH : 0, left = 0, top = 0;
    for (const st of inkStrokes()) {
      if (st.erasedAt) continue;
      const bb = strokeBox(st);
      if (bb[2] > S.W) right = S.TW;
      bottom = Math.max(bottom, bb[3]);
      left = Math.min(left, bb[0] - 20);
      top = Math.min(top, bb[1] - 20);
    }
    const live = liveIds();
    for (const a of S.page.ai) {
      if (a.dismissed || gone(a, live)) continue;
      const b = isBadge(a) ? badgeBox(a, 4) : a.lay ? [a.lay.x, a.lay.y, a.lay.x + a.lay.w, a.lay.y + a.lay.h] : null; // 圈号也要在图里
      if (!b) continue;
      if (b[2] > S.W) right = S.TW;
      bottom = Math.max(bottom, b[3]);
      left = Math.min(left, b[0] - 20);
    }
    return { x0: Math.max(S.X0, left), y0: Math.max(S.Y0, top), x1: right, y1: clamp(bottom + 30, 200, S.pageH) };
  }

  function inSel(b, sel) {
    const ix = Math.max(0, Math.min(b[2], sel.x1) - Math.max(b[0], sel.x0));
    const iy = Math.max(0, Math.min(b[3], sel.y1) - Math.max(b[1], sel.y0));
    const area = Math.max(1, (b[2] - b[0]) * (b[3] - b[1]));
    const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
    return (ix * iy) / area >= 0.4 || (cx >= sel.x0 && cx <= sel.x1 && cy >= sel.y0 && cy <= sel.y1);
  }

  // ------------------------------------------------------------ 输入：笔、橡皮、手势

  const touches = new Map();
  let gesture = null, lastTap = 0;

  function pressureOf(e) {
    if (e.pointerType === 'mouse') return 0.5;
    return clamp(e.pressure || 0.5, 0.08, 1);
  }

  function isEraserButton(e) { return (e.buttons & 32) === 32 || e.button === 5; }

  // 笔刚落下或抬起（PALM_MS 以内）：这时碰到屏幕的手指多半是手掌、手环。还没用过笔就不算——打开页面后的头一秒手指照样能挪纸
  function penJustUsed() { return S.penAt !== undefined && performance.now() - S.penAt <= PALM_MS; }

  // 系统接管了一次触摸（比如全屏时碰到顶端、Safari 退出全屏），收不到抬笔、抬手：把半截的状态清掉，不然之后写不了字
  function resetInput() {
    if (S.cur) { if (S.cur.pts.length >= 3) commitStroke(); else { S.cur = null; drawLive(); } }
    if (S.erasing) endErase();
    if (S.cardInk) finishCardInk(); // 卡片上写到一半的红字：收好
    if (S.cardErase) finishCardErase();
    S.cardDrag = null;
    touches.clear();
    gesture = null;
    redrawAll();
  }

  stage.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    S.downAt = performance.now(); // 这一下落下的时刻：这一下收起的卡片，点的又是它的圈号，就是收起（tapBadge）
    const covered = !$('#drawer').hidden || !$('#menu').hidden; // 抽屉或「⋯」菜单开着：这一下只是收起它们，不写字、不擦（见下面）
    hideMenu();
    if (S.replay) { stopReplay(); return; }
    if (!S.page) return;
    if (S.collapsed && isFullscreen() && e.clientY < 12) return; // 全屏时屏幕最顶端归 Safari（退出全屏），不落笔
    measureStage();
    if (e.pointerType === 'touch') {
      if (e.isPrimary && touches.size) { touches.clear(); gesture = null; } // 新的第一根手指：之前没抬起的是系统吞掉的

      if (S.cur && S.cur._kind === 'touch') { S.cur = null; drawLive(); return; } // 手指书写时落下第二根手指：作废这一笔
      if (S.cur || S.erasing || S.cardInk || S.cardErase) return; // 笔正在写（纸上或卡片上）：忽略手掌
      // 笔刚落下或抬起（一秒内）时碰到屏幕的，多半是手掌、手腕上的手环：不当成挪纸的手指，直到它抬起都不管它
      if (!S.fingerDraw && penJustUsed()) return;
      if (!S.fingerDraw) {
        touchDown(e);
        return;
      }
    }
    // 上一笔的抬笔事件没到（iPad 上偶尔晚到，或被系统吞掉）：先把它收尾，再开始这一笔，而不是丢掉这一笔、也不接到上一笔上。
    // 只有一两个点的半截多半是误触，直接丢掉
    if (e.pointerType === 'pen') S.penAt = performance.now();
    // 笔落下时还按在屏幕上的手指，多半是先搭上来的手掌或手环：从这一刻起不再跟着它挪纸（用户：「佩戴手环时，书写时可能画面移动」）。
    // 画面停在此刻的位置，不退回去：笔是照着现在看到的地方落的
    if (e.pointerType === 'pen' && touches.size) { touches.clear(); gesture = null; if (!flowCheck()) redrawAll(); }
    if (S.cur) { if (S.cur.pts.length >= 3) commitStroke(); else S.cur = null; }
    if (S.erasing) endErase();
    if (S.cur || S.erasing) return;
    // 抽屉、菜单开着时用笔（电脑上是鼠标）点纸面：只收起（菜单上面已经收了），纸上不留点。
    // 手指照旧：挪纸的手指上面已经交给 touchDown；「手指也能书写」时在菜单里刚勾上就能直接写（收起由 document 上的 pointerdown 做）
    if (covered && e.pointerType !== 'touch') { toggleDrawer(false); return; }
    try { stage.setPointerCapture(e.pointerId); } catch (err) { /* 有些浏览器不支持 */ }
    if (S.flow && !S.replay && !S.compare) { // 连续阅读：笔落在相邻的页上，先把那一页换成当前页
      const wy = toWorld(...ptOf(e))[1];
      if (wy < S.Y0 || wy > S.pageH) {
        const n = flowStrip().find((m) => wy >= m.D + m.G.Y0 && wy <= m.D + m.G.pageH);
        // 落在页缝里不写。空白本子第一页的上面、最后一页的下面不是页缝：写在那儿，纸跟着长过去（见 growSides）
        if (!n && !(blankNb() && (wy > S.pageH ? lastPage(S.idx) : S.idx === 0))) return;
        if (n) activate(n.i, n.ent, n.D);
      }
    }
    const [x, y] = toWorld(...ptOf(e));
    const tool = isEraserButton(e) ? 'eraser' : S.tool;
    // 落笔：开着的卡片已经收起（document 上的 pointerdown），这一笔照常写上；落在圈号上的轻点在抬笔时打开卡片（penTapBadge）
    if (tool === 'pen' || tool === 'red') {
      S.cur = { id: uid(), t0: Date.now(), w: PEN_W, pts: [[r1(x), r1(y), Math.round(pressureOf(e) * 100) / 100, 0]],
        _pid: e.pointerId, _ts0: e.timeStamp, _kind: e.pointerType };
      if (tool === 'red') S.cur.c = 'r';
      drawLive();
    } else if (tool === 'eraser') {
      const live = liveIds();
      S.erasing = { pid: e.pointerId, ids: [], ai: [], r: 14 / S.view.s, at: [x, y], gone0: new Set(S.page.ai.filter((a) => gone(a, live)).map((a) => a.id)) };
      eraseAt(x, y);
    }
  });

  stage.addEventListener('pointermove', (e) => {
    if (touches.has(e.pointerId)) { touchMove(e); return; } // 手指
    if (S.cur && e.pointerId === S.cur._pid) {
      const evs = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
      const list = evs.length ? evs : [e];
      const ctx = cvLive.getContext('2d');
      setT(ctx);
      for (const ev of list) {
        const [x, y] = toWorld(...ptOf(ev));
        const p = S.cur.pts, last = p[p.length - 1];
        if (Math.hypot(x - last[0], y - last[1]) < 0.35) continue;
        const pr = Math.round(((pressureOf(ev) + last[2]) / 2) * 100) / 100;
        p.push([r1(x), r1(y), pr, Math.max(last[3], Math.round(ev.timeStamp - S.cur._ts0))]);
        if (x > S.TW - 170) heatTab('#extRight');
        if (y > S.pageH - 240) heatTab('#extDown');
        if (y < S.Y0 + 120) heatTab('#extUp');
        if (x < S.X0 + 100) heatTab('#extLeft');
        drawStroke(ctx, S.cur, inkOf(S.cur), p.length - 1, p.length);
      }
      return;
    }
    if (S.erasing && e.pointerId === S.erasing.pid) {
      const [x, y] = toWorld(...ptOf(e));
      S.erasing.at = [x, y];
      eraseAt(x, y);
      return;
    }
  });

  function pointerEnd(e) {
    if (touches.has(e.pointerId)) { touchUp(e); return; } // 手指
    if (e.pointerType === 'pen') S.penAt = performance.now();
    if (S.cur && e.pointerId === S.cur._pid) { commitStroke(); return; }
    if (S.erasing && e.pointerId === S.erasing.pid) endErase();
  }
  function commitStroke() {
    const st = S.cur;
    S.cur = null;
    if (!st) return;
    delete st._pid; delete st._ts0; delete st._kind;
    // 笔点 ✓ × 钮、笔点圈号（打开卡片）、在建议框里打勾横划、蓝字旁画星号：不留作笔迹
    if (penTapVote(st) || penTapBadge(st) || gestureOnVote(st) || gestureOnBlue(st)) { drawLive(); return; }
    S.page.strokes.push(st);
    S.undo.push({ t: 'add', id: st.id });
    const ctx = cvInk.getContext('2d');
    setT(ctx);
    drawStroke(ctx, st, inkOf(st));
    drawLive();
    markDirty();
    keepHeight(strokeBox(st)[3]);
    // 书页连续阅读时下一页接在下面，要更多纸点「＋ 加长」。空白本子的纸跟着字长：快写到底就往下长，写出左、右、上边就往那边长
    if (!S.flow || blankNb()) maybeExtend(strokeBox(st)[3]);
    if (blankNb()) growSides(strokeBox(st));
  }

  // 写到离页底不到 180 时，这一页往下加长（草稿本、书页、推送页都行；书页和图的下面是白纸）
  function maybeExtend(bottom) {
    if (!S.page || bottom < S.pageH - 180) return false;
    const h = Math.min(30000, Math.ceil((bottom + 700) / 100) * 100);
    if (h <= S.pageH) return false;
    S.pageH = h;
    S.page.h = h;
    S.storedH = h;
    // 视图一点不动：不重新适配、不重新夹取位置，否则整页会跳，下一笔就落偏了。下面只是多出白纸。
    if (S.fitMode === 'page') S.fitMode = null;
    redrawAll();
    markDirty();
    return true;
  }

  // 空白本子（草稿本、自己新建的本子）：纸没有固定的大小，跟着字长（用户：「可以改为无限画布」）。书页、推送页有自己的版面，不这样
  function blankNb() { return Boolean(S.nb) && (S.nb.kind === 'scratch' || S.nb.kind === 'pad'); }

  // 空白本子：这一笔写出了纸的左、右、上边（把纸挪开或缩小以后，纸外面那片灰底上也能落笔），那一边就往外长，长到把这一笔包进来还留一点余地。
  // 视图一点不动，否则下一笔就落偏了。贴着纸边写不算：平时纸边就是屏幕边，随手一笔就把页边挪走不合适
  function growSides(b) {
    const p = S.page;
    let grew = false;
    if (b[2] > S.TW + 2) while (b[2] > S.TW - 60 && (p.xw || 0) < 3000) { p.xw = Math.min(3000, (p.xw || 0) + 400); S.W = W + p.xw; S.TW = S.W + S.M; grew = true; }
    if (b[0] < S.X0 - 2) while (b[0] < S.X0 + 60 && (p.ox || 0) < 6000) { p.ox = Math.min(6000, (p.ox || 0) + 400); S.X0 = -p.ox; grew = true; }
    if (b[1] < S.Y0 - 2) while (b[1] < S.Y0 + 60 && (p.oy || 0) < 6000) { p.oy = Math.min(6000, (p.oy || 0) + 500); S.Y0 = -p.oy; grew = true; }
    if (!grew) return;
    S.fitMode = null;
    redrawAll();
    markDirty();
  }

  // 要不要页边：空白本子一直有；书页、推送页只在页边有东西（Claude 的批注、写过的字）或开过页边时才有
  function needsMargin(page = S.page, Wp = S.W) {
    if (!S.nb || S.nb.kind === 'scratch' || S.nb.kind === 'pad' || page.mg) return true;
    if (inkStrokes(page).some((st) => !st.erasedAt && strokeBox(st)[2] > Wp)) return true;
    return page.ai.some((a) => (a.lay && a.lay.x >= Wp - 1) || (isBadge(a) && !a.erasedAt && a.at[0] + BADGE_R > Wp));
  }

  // Claude 往页边写批注时，没有页边就开出来（之后这一页一直留着）
  function ensureMargin() {
    if (S.M) return;
    S.M = M;
    S.page.mg = true;
    S.TW = S.W + S.M;
    markDirty();
    if (S.fitMode && !S.landing) fit(S.fitMode); else redrawAll(); // 落到相邻页上时不重新适配：屏幕不能动
  }

  // 存下来的高度至少到 bottom（写在「填满屏幕」多出来的那段纸上的东西要存住）
  function keepHeight(bottom) {
    if (bottom <= (S.page.h || S.baseH)) return;
    S.page.h = Math.min(30000, Math.ceil(bottom + 80));
    S.storedH = Math.max(S.storedH, S.page.h);
    markDirty();
  }

  function heatTab(sel) {
    const t = $(sel);
    t.classList.add('hot');
    clearTimeout(t._cool);
    t._cool = setTimeout(() => t.classList.remove('hot'), 2500);
  }

  // 手动加长、加宽：视图不动，多出来的纸在下面 / 右边
  function extendPage(dir) {
    if (!S.page) return;
    if (dir === 'down') {
      S.pageH = Math.min(30000, S.pageH + 700);
      S.page.h = S.pageH;
      S.storedH = S.pageH;
    } else if (dir === 'right') {
      S.page.xw = Math.min(3000, (S.page.xw || 0) + 400);
      S.W = W + S.page.xw;
      S.TW = S.W + S.M;
    } else {
      // 向上、向左：纸往外长，原来的内容坐标不动；把视图跟着挪，让新加的那块露出来
      const add = dir === 'up' ? 500 : 400, key = dir === 'up' ? 'oy' : 'ox';
      if ((S.page[key] || 0) + add > 6000) { toast('这个方向已经扩得够多了'); return; }
      S.page[key] = (S.page[key] || 0) + add;
      S.X0 = -(S.page.ox || 0);
      S.Y0 = -(S.page.oy || 0);
      const v = S.view;
      S.view = clampView(dir === 'up' ? { s: v.s, tx: v.tx, ty: v.ty + add * v.s } : { s: v.s, tx: v.tx + add * v.s, ty: v.ty });
    }
    S.fitMode = null;
    redrawAll();
    markDirty();
    toast({ down: '这一页加长了', right: '这一页加宽了（页边挪到了右边）', up: '上面加了一块纸', left: '左边加了一块纸' }[dir], 1500);
  }

  function isFullscreen() { return Boolean(document.fullscreenElement || document.webkitFullscreenElement); }

  // 浏览器的全屏变了（比如用户用系统手势退出）：页面本来就只有纸，保持原样，要顶栏和工具栏就点右下角的「退出全屏」；
  // 被系统吞掉的触摸清掉，页面滚回原位
  function syncFullscreen() {
    resetInput();
    window.scrollTo(0, 0);
    setTimeout(() => { window.scrollTo(0, 0); resize(); }, 400); // Safari 退出全屏后地址栏还在动画，等它停了再量一次
  }

  function setCollapsed(on) {
    closeCard(); // 全屏、退出全屏：纸面挪了位置
    S.collapsed = on;
    store.set('bars', !on);
    document.body.classList.toggle('collapsed', on);
    if (on) { toggleDrawer(false); hideMenu(); }
    if (S.fitMode || on) S.fitMode = S.fitMode || 'width';
    resize();
    if (!on) setNbTitle(); // 顶栏上的本子名是全屏时排的（那时顶栏藏着、量不出宽度）：出来后重排，渐隐、滑到不一样的那段才对
    updateSegs();
    placeTools(); // 右下角那一条重新出来时，摆回拖到过的位置
    placeQ(); // 顶上的卡片让开左上角那一排（全屏）或顶栏（退出全屏）
  }

  // 全屏：能隐藏 Safari 界面就隐藏，同时收起上栏和工具栏，只留纸、左上角的本子名和右下角那一条
  function enterFullscreen() {
    const el = document.documentElement, req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (req && !isFullscreen() && !isStandalone()) {
      try { const p = req.call(el); if (p && p.catch) p.catch(() => {}); } catch (e) { /* 不支持就只收起工具栏 */ }
    }
    setCollapsed(true);
  }

  function exitFullscreen() {
    if (isFullscreen()) {
      try { const p = (document.exitFullscreen || document.webkitExitFullscreen).call(document); if (p && p.catch) p.catch(() => {}); } catch (e) { /* ignore */ }
    }
    setCollapsed(false);
  }

  function isStandalone() {
    return Boolean(navigator.standalone) || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
  }

  // 右下角那一条：按住左端的把手拖到顺手的地方（用户：「黑笔和红笔的切换必须在画面右下角不太方便」），位置记在这台设备上。
  // 没拖过就留在右下角；屏幕转了、变小了放不下时拉回屏幕里，记着的位置不变，转回来还在原处
  function placeTools(l, t) {
    const bar = $('#tools');
    if (l === undefined) {
      const pos = store.get('toolsPos', null);
      if (!pos) return;
      [l, t] = pos;
    }
    if (!bar.offsetWidth) return; // 这一条没显示（退出了全屏）：等它出来再摆
    const bw = document.documentElement.clientWidth, bh = document.documentElement.clientHeight;
    Object.assign(bar.style, { left: clamp(l, 4, Math.max(4, bw - bar.offsetWidth - 4)) + 'px',
      top: clamp(t, TOP_SAFE, Math.max(TOP_SAFE, bh - bar.offsetHeight - 4)) + 'px', right: 'auto', bottom: 'auto' });
  }

  function initToolsBar() {
    const bar = $('#tools'), grip = $('#toolsGrip');
    let drag = null;
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const [x, y] = ptOf(e), r = bar.getBoundingClientRect();
      drag = { x, y, l: r.left, t: r.top };
      try { grip.setPointerCapture(e.pointerId); } catch (err) { /* 有些浏览器不支持 */ }
    });
    grip.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const [x, y] = ptOf(e);
      placeTools(drag.l + x - drag.x, drag.t + y - drag.y);
    });
    const end = () => {
      if (drag) { const r = bar.getBoundingClientRect(); store.set('toolsPos', [Math.round(r.left), Math.round(r.top)]); placeVer(); placeQ(); } // 提示条、顶上的卡片让开挪过来的这一条
      drag = null;
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
    window.addEventListener('resize', () => placeTools());
    placeTools();
  }

  // 擦完一笔：指着的字全擦掉了的标注跟着收起（现算，见 gone）；红字问题擦掉了，回答它的圈号照样留在原处
  function endErase() {
    const er = S.erasing;
    S.erasing = null;
    const blue = er.ai || [];
    if (er.ids.length || blue.length) {
      const live = liveIds();
      const hid = er.ids.length ? S.page.ai.filter((a) => !(er.gone0 && er.gone0.has(a.id)) && gone(a, live)).length : 0;
      const rec = { t: 'erase', ids: er.ids };
      if (blue.length) rec.ai = blue; // 擦掉的蓝字：撤销时回到擦之前（原来划掉的仍是划掉）
      S.undo.push(rec);
      if (hid) {
        renderAI();
        toast(`Claude 的 ${hid} 条批注指着的字擦掉了，已收起（撤销可恢复）`, 3000);
      }
      markDirty();
    }
    drawLive();
  }

  stage.addEventListener('pointerup', pointerEnd);
  stage.addEventListener('pointercancel', pointerEnd);
  stage.addEventListener('lostpointercapture', pointerEnd); // 系统接管触摸时，有时只有这个事件
  for (const type of ['touchstart', 'touchmove', 'touchend']) {
    stage.addEventListener(type, (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
  }
  for (const type of ['gesturestart', 'gesturechange', 'gestureend', 'dblclick', 'contextmenu']) {
    document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  }

  function distToSeg(px, py, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    const t = l2 ? clamp(((px - a[0]) * dx + (py - a[1]) * dy) / l2, 0, 1) : 0;
    return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
  }

  // 橡皮：一笔只擦一种。先碰到哪一种就擦哪一种——先碰到我的字，这一笔只擦我的字，旁边 Claude 的标记不动；
  // 先碰到 Claude 的蓝字，这一笔只擦蓝字（整条擦掉），不碰我的字。还没碰到任何东西时不定
  function eraseAt(x, y) {
    const r = S.erasing.r, now = Date.now();
    if (!S.erasing.mode) {
      const db = blueNearest(x, y), di = inkNearest(x, y);
      if (Math.min(db, di) <= r) S.erasing.mode = db < di ? 'blue' : 'ink';
      // 荧光笔是铺在底下的一块黄底：够得着我的字、别的蓝字时先擦那些；只碰到荧光笔（空白处、印刷文字上的）才擦它
      else if (hlNearest(x, y) <= r) S.erasing.mode = 'blue';
    }
    if (S.erasing.mode === 'ink') {
      let hit = false;
      for (const st of inkStrokes()) {
        if (st.erasedAt) continue;
        const b = strokeBox(st);
        if (x < b[0] - r || x > b[2] + r || y < b[1] - r || y > b[3] + r) continue;
        if (strokeDist(st, x, y) <= r) { st.erasedAt = now; S.erasing.ids.push(st.id); hit = true; }
      }
      if (hit) drawInk();
    } else if (S.erasing.mode === 'blue' && eraseBlue(x, y, r)) renderAI();
    drawLive();
  }

  function strokeDist(st, x, y) { // 点到这一笔的距离
    const p = st.pts;
    if (p.length === 1) return Math.hypot(x - p[0][0], y - p[0][1]);
    let d = Infinity;
    for (let i = 1; i < p.length; i++) d = Math.min(d, distToSeg(x, y, p[i - 1], p[i]));
    return d;
  }
  function inkNearest(x, y) { // 离这一点最近的、看得见的我的字
    let d = Infinity;
    for (const st of inkStrokes()) {
      if (st.erasedAt) continue;
      const b = strokeBox(st);
      if (Math.max(b[0] - x, 0, x - b[2]) > d || Math.max(b[1] - y, 0, y - b[3]) > d) continue;
      d = Math.min(d, strokeDist(st, x, y));
    }
    return d;
  }

  // 橡皮擦到 Claude 的蓝字：整条擦掉（长回答的圈号、页边批注、批改符号、圈、箭头……），撤销可以恢复。
  // 只认它自己画出来的地方（文字、符号、线、圈号），不认它指着的我的字。
  // 擦掉 = 记下 erasedAt 并当作划掉（各处本来就不算划掉的：发给 Claude 的旧批注、表决、排版、服务端出图），纸上不画
  function blueLive() {
    if (!S.aiVisible) return [];
    const live = liveIds();
    return S.page.ai.filter((a) => !a.erasedAt && !gone(a, live));
  }
  function blueNearest(x, y) { // 荧光笔不算在这里（见 hlNearest）
    let d = Infinity;
    for (const a of blueLive()) if (a.type !== 'highlight') d = Math.min(d, blueDist(a, x, y));
    return d;
  }
  function hlNearest(x, y) {
    let d = Infinity;
    for (const a of blueLive()) if (a.type === 'highlight') d = Math.min(d, blueDist(a, x, y));
    return d;
  }
  function eraseBlue(x, y, r) {
    let hit = false;
    for (const a of blueLive()) {
      if (blueDist(a, x, y) > r / 2) continue; // 一条蓝字是一个整体：要擦到它身上才算，挨得近的另一条不跟着没
      S.erasing.ai.push({ id: a.id, dismissed: Boolean(a.dismissed) });
      a.erasedAt = Date.now();
      a.dismissed = true;
      hit = true;
    }
    return hit;
  }
  function ptBoxDist(b, x, y) { return Math.hypot(Math.max(b[0] - x, 0, x - b[2]), Math.max(b[1] - y, 0, y - b[3])); }
  function blueDist(a, x, y) { // 点到这条蓝字自己画出来的地方的距离（线类留 4 的余量）
    const lay = a.lay && [a.lay.x, a.lay.y, a.lay.x + a.lay.w, a.lay.y + a.lay.h];
    if (a.type === 'write') return isBadge(a) ? Math.max(0, Math.hypot(x - a.at[0], y - a.at[1]) - BADGE_R) : Infinity; // 圈号
    if (a.type === 'circle' && a.box) { // 只认圈线：圈里是我的字。沿着从圈心出发的方向量到圈线
      const b = a.box, cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2, rx = (b[2] - b[0]) / 2 + 14, ry = (b[3] - b[1]) / 2 + 11;
      const d = Math.hypot((x - cx) / rx, (y - cy) / ry), p = Math.hypot(x - cx, y - cy);
      return Math.max(0, (d ? p * Math.abs(1 - 1 / d) : Math.min(rx, ry)) - 4);
    }
    let best = lay ? ptBoxDist(lay, x, y) : Infinity;
    if (a.type === 'arrow' && a.paths && a.paths[0]) { // 箭杆（两端连线）
      const n = (String(a.paths[0].d).match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
      if (n.length >= 4) best = Math.min(best, Math.max(0, distToSeg(x, y, [n[0], n[1]], [n[n.length - 2], n[n.length - 1]]) - 4));
      return best;
    }
    if (a.type === 'underline' && a.box) return ptBoxDist([a.box[0] - 4, a.box[3] + 2, a.box[2] + 4, a.box[3] + 14], x, y);
    if (a.type === 'highlight' && a.box) { // 荧光笔：画出来的那块黄底（和 buildMark 里一样大），没有字、没有符号
      const b = a.box, ey = Math.max(0, 22 - (b[3] - b[1])) / 2;
      return ptBoxDist([b[0] - 3, b[1] - 2 - ey, b[2] + 3, b[3] + 2 + ey], x, y);
    }
    if (BLOCK_TYPES.has(a.type) && a.hit) return ptBoxDist(a.hit, x, y); // 示意图、公式、图：占的那一整块
    if (a.sym && a.type !== 'strike') best = Math.min(best, ptBoxDist(a.sym, x, y)); // 符号本身（删除线压在我的字上，不算）
    return best;
  }

  function undo() {
    const a = S.undo.pop();
    if (!a) { toast('没有可以撤销的'); return; }
    if (a.t === 'add') S.page.strokes = S.page.strokes.filter((s) => s.id !== a.id);
    else if (a.t === 'erase') {
      for (const st of S.page.strokes) if (a.ids.indexOf(st.id) >= 0) delete st.erasedAt;
      for (const x of a.ai || []) { // 擦掉的蓝字（连同圈号）回来；原来划掉的仍是划掉
        const it = S.page.ai.find((o) => o.id === x.id);
        if (!it) continue;
        delete it.erasedAt;
        if (x.dismissed) it.dismissed = true; else delete it.dismissed;
      }
    } else if (a.t === 'flag') { // 采纳：回到原样
      const it = S.page.ai.find((o) => o.id === a.id);
      if (it) {
        if (a.prev) it[a.key] = true; else delete it[a.key];
      }
    } else if (a.t === 'verdict') { // ✓ / × 点错了
      const it = S.page.ai.find((o) => o.id === a.id);
      if (it) { if (a.prev) it.verdict = a.prev; else delete it.verdict; }
    } else if (a.t === 'cmark' || a.t === 'cerase') { // 长回答卡片上的红字：撤掉刚写的一笔，或找回擦掉的
      const it = S.page.ai.find((o) => o.id === a.a);
      if (it && Array.isArray(it.marks)) {
        if (a.t === 'cmark') it.marks = it.marks.filter((m) => !m || m.id !== a.id);
        else for (const m of it.marks) if (m && a.ids.indexOf(m.id) >= 0) delete m.erasedAt;
        if (S.card && S.card.id === it.id) drawCardInk();
        else toast('撤销的是卡片上的红字', 1800); // 卡片收着：纸上看不出来，说一句
      }
    }
    drawInk();
    renderAI(); // 落空的标注跟着回来
    markDirty();
  }

  // -- 手指：单指平移，双指缩放，轻点圈号打开长回答的卡片，双击切换整页/适配宽度
  function touchDown(e) {
    const [px, py] = ptOf(e);
    touches.set(e.pointerId, { x: px, y: py });
    try { stage.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    gestureStart();
  }
  function touchMove(e) {
    const [px, py] = ptOf(e);
    touches.set(e.pointerId, { x: px, y: py });
    if (!gesture) return;
    const pts = Array.from(touches.values()), g = gesture, v0 = g.v0;
    // 卡片开着：挪纸（挪过 CARD_PAN）、两指缩放时收起。搭在纸上的手掌、手环晃一点不算（用户写字的手上戴手环）
    if (S.card && (pts.length > 1 || Math.hypot(pts[0].x - g.p0[0].x, pts[0].y - g.p0[0].y) > CARD_PAN)) closeCard();
    let v;
    if (pts.length === 1) {
      const dx = pts[0].x - g.p0[0].x, dy = pts[0].y - g.p0[0].y;
      if (Math.hypot(dx, dy) > SLOP) g.moved = true;
      v = { s: v0.s, tx: v0.tx + dx, ty: v0.ty + dy };
    } else {
      g.moved = true;
      const a = pts[0], b = pts[1], a0 = g.p0[0], b0 = g.p0[1];
      const d0 = Math.hypot(a0.x - b0.x, a0.y - b0.y) || 1, d = Math.hypot(a.x - b.x, a.y - b.y);
      const s = clamp(v0.s * d / d0, S.fitS * 0.4, S.fitS * 8), k = s / v0.s;
      const m0x = (a0.x + b0.x) / 2 - stageRect.left, m0y = (a0.y + b0.y) / 2 - stageRect.top;
      const mx = (a.x + b.x) / 2 - stageRect.left, my = (a.y + b.y) / 2 - stageRect.top;
      v = { s, tx: mx - (m0x - v0.tx) * k, ty: my - (m0y - v0.ty) * k };
    }
    S.view = clampView(v);
    S.fitMode = null;
    previewView();
  }
  function touchUp(e) {
    const g = gesture;
    touches.delete(e.pointerId);
    if (touches.size) { gestureStart(); return; }
    gesture = null;
    // 轻点：不到 0.45 秒；距离由 moved 管
    if (g && !g.moved && g.single && performance.now() - g.t < TAP_MS && !penJustUsed()) {
      const now = performance.now();
      if (!tapAiItem(...ptOf(e))) {
        closeCard(); // 手指点纸上别处：卡片收起（手指落下时不收：可能是搭上来的手掌，见 document 上的 pointerdown）
        if (now - lastTap < 320) { fit(S.fitMode === 'width' ? 'page' : 'width'); lastTap = 0; return; }
        lastTap = now;
      } else if (S.card) { redrawAll(); return; } // 点开了卡片（相邻页上的圈号：那一页已换成当前页）：不按屏幕中线再换页，换了卡片就收起了
    }
    if (!flowCheck()) redrawAll();
    landSoon(); // 连续阅读：挪到屏幕上的相邻页如果有 Claude 还没落下的回复，落下
  }
  function gestureStart() {
    const pts = Array.from(touches.values());
    gesture = { v0: Object.assign({}, S.view), p0: pts.map((p) => ({ x: p.x, y: p.y })), moved: gesture ? gesture.moved : false,
      single: (gesture ? gesture.single : true) && pts.length === 1, t: gesture ? gesture.t : performance.now() };
  }

  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    closeCard(); // 挪动、缩放纸面：卡片收起
    const v = S.view;
    if (e.ctrlKey) {
      const k = Math.exp(-e.deltaY * 0.01), s = clamp(v.s * k, S.fitS * 0.4, S.fitS * 8), kk = s / v.s;
      const [ex, ey] = ptOf(e), mx = ex - stageRect.left, my = ey - stageRect.top;
      S.view = clampView({ s, tx: mx - (mx - v.tx) * kk, ty: my - (my - v.ty) * kk });
    } else {
      S.view = clampView({ s: v.s, tx: v.tx - e.deltaX, ty: v.ty - e.deltaY });
    }
    S.fitMode = null;
    if (!flowCheck()) redrawAll();
    ensureNeighbors();
    landSoon();
  }, { passive: false });

  // ------------------------------------------------------------ 交给 Claude 的图

  // 只画一张：交的这一块（消息里列的就是它，Claude 给的 box 也按它的像素算）。以前另画的整页概览已去掉。
  // extra：再标上的编号（发送时列出的旧批注 a1、a2……）
  function renderForAI(sel, groups, extra) {
    const labelled = groups.filter((g) => g.inSel).concat(extra || []);
    // 长边最多 1200 像素（认字看字帖，这张看版面和上下文），最多放大 3 倍
    const cw = sel.x1 - sel.x0, ch = sel.y1 - sel.y0;
    const sc0 = Math.min(3, 1200 / Math.max(cw, ch));
    const k = document.createElement('canvas');
    k.width = Math.max(1, Math.round(cw * sc0));
    k.height = Math.max(1, Math.round(ch * sc0));
    const sc = k.width / cw;
    const kc = k.getContext('2d');
    kc.fillStyle = '#fff';
    kc.fillRect(0, 0, k.width, k.height);
    kc.setTransform(sc, 0, 0, sc, -sel.x0 * sc, -sel.y0 * sc);
    paintPaper(kc, {});
    for (const st of inkStrokes()) if (st.erasedAt) drawStroke(kc, st, ERASED); // 书写过程每次都附：擦掉的笔迹画成浅灰
    for (const st of inkStrokes()) if (!st.erasedAt) drawStroke(kc, st, inkOf(st));
    paintAiForModel(kc);
    paintLabels(kc, labelled, sc);

    // 认字用的「字帖」（每组笔迹统一字高排成一张）由电脑上的服务按存好的笔迹画
    return {
      crop: k.toDataURL('image/jpeg', 0.92),
      cropInfo: { x0: r1(sel.x0), y0: r1(sel.y0), x1: r1(sel.x1), y1: r1(sel.y1), scale: sc, w: k.width, h: k.height },
    };
  }

  function paintLabels(ctx, groups, scale) {
    const fs = 13 / scale;
    ctx.save();
    ctx.font = `600 ${fs}px -apple-system, "PingFang SC", sans-serif`;
    ctx.textBaseline = 'bottom';
    for (const g of groups) {
      const t = g.id, w = ctx.measureText(t).width + 4 / scale;
      const x = clamp(g.bbox[0], S.X0, S.TW - w), y = clamp(g.bbox[1] - 1 / scale, S.Y0 + fs + 2 / scale, S.pageH);
      ctx.fillStyle = 'rgba(255,255,255,.85)';
      ctx.fillRect(x, y - fs - 1 / scale, w, fs + 2 / scale);
      ctx.fillStyle = '#8a8a8a';
      ctx.fillText(t, x + 2 / scale, y);
    }
    ctx.restore();
  }

  // 把 Claude 的东西画进画布：发给 Claude 的图、连续阅读时的相邻页（badges 为 false：圈号另画在批注层上）。
  // 长回答只画圈号（蓝圈加数字），不画回答文字；和服务器画的图（pages.py _draw_page）一样
  function paintAiForModel(ctx, page = S.page, badges = true) {
    ctx.save();
    ctx.fillStyle = AI;
    ctx.strokeStyle = AI;
    ctx.lineCap = 'round';
    const live = liveIds(page);
    for (const it of page.ai) {
      if (it.dismissed || gone(it, live)) continue;
      ctx.globalAlpha = it.verdict === 'no' ? 0.35 : 1; // 不采纳的建议：画淡
      ctx.fillStyle = ctx.strokeStyle = it.adopted ? ADOPTED : AI; // 采纳的画成深蓝：和几页一起交时服务器画的图一样（服务器那边也不画 ★）
      if (it.type === 'write') { // 长回答：圈号。没看过的实心（蓝底白字），看过的空心（白底蓝圈蓝字）
        if (!badges || !isBadge(it)) continue;
        const [x, y] = it.at, col = ctx.fillStyle;
        ctx.beginPath();
        ctx.arc(x, y, BADGE_R, 0, Math.PI * 2);
        ctx.fillStyle = it.seen ? '#fff' : col;
        ctx.fill();
        ctx.lineWidth = 1.8;
        ctx.stroke();
        ctx.fillStyle = it.seen ? col : '#fff';
        ctx.font = `${BADGE_FS}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.fillText(String(it.n || ''), x, y + BADGE_FS * 0.36);
        ctx.textAlign = 'start';
        continue;
      }
      if (it.fig && it.img) { // Claude 放上来的图：载入好了才画得上
        const im = figImage(it.img);
        if (im.complete && im.naturalWidth) ctx.drawImage(im, it.fig.x, it.fig.y, it.fig.w, it.fig.h);
      }
      for (const p of it.paths || []) {
        try {
          if (p.cls === 'hl') { // 荧光笔：黄色半透明底
            ctx.save();
            ctx.fillStyle = 'rgba(255,229,106,.45)';
            ctx.fill(new Path2D(p.d));
            ctx.restore();
          } else {
            ctx.lineWidth = p.w || 2.2;
            ctx.setLineDash((p.cls === 'sbox' || p.cls === 'dash') && it.verdict !== 'yes' ? [7, 5] : []); // 还没同意的建议：虚线
            ctx.stroke(new Path2D(p.d));
            ctx.setLineDash([]);
          }
        } catch (e) { /* 旧浏览器 */ }
      }
      if (it.lay) {
        ctx.font = `${it.lay.fs}px ${FONT}`;
        it.lay.lines.forEach((line, i) => ctx.fillText(line, it.lay.x, it.lay.y + it.lay.fs + i * it.lay.lh));
      }
      for (const lb of it.labels || []) { // 示意图里的字
        ctx.font = `${lb.fs}px ${FONT}`;
        ctx.fillText(lb.text, lb.x, lb.y + lb.fs);
      }
    }
    ctx.restore();
  }

  function padSel(sel, pad) {
    return {
      x0: clamp(sel.x0 - pad, S.X0, S.TW), y0: clamp(sel.y0 - pad, S.Y0, S.pageH),
      x1: clamp(sel.x1 + pad, S.X0, S.TW), y1: clamp(sel.y1 + pad, S.Y0, S.pageH),
    };
  }

  // ------------------------------------------------------------ 点「AI」交上去，与回来的东西

  function payloadFor(groups, sel, imgs) {
    // 回答过的红笔问题，不再当新问题（faded 是以前发送时记下的「回答过」）
    const ans = answeredIds(), done = (g) => g.c === 'r' && g.strokes.every((s) => s.faded || ans.has(s.id));
    return {
      nb: S.nb.id, page: S.idx, include_process: true, now: Date.now(),
      sel: { x0: sel.x0, y0: sel.y0, x1: sel.x1, y1: sel.y1 },
      crop: imgs.cropInfo,
      page_size: { w: S.W, margin: M, h: S.pageH, x0: S.X0, y0: S.Y0 },
      rot: S.page.rot || 0, // Claude 看到的图是这一页转到多少度时画的
      groups: groups.map((g) => ({
        id: g.id, t0: g.t0, t1: g.t1, n: g.n, erased: g.erased, erasedAt: g.erasedAt,
        bbox: g.bbox.map(Math.round), inSel: g.inSel, revisit: g.revisit, red: g.c === 'r', answered: done(g) || undefined,
        ids: g.strokes.map((s) => s.id), on: groupOn(g),
      })),
      // 之前写过的批注：短的是原话；长回答（圈号）带上圈号、问题和全文，消息里写成「圈号 n（问：q）：前 200 个字…」（prompt.fmt_prev）；
      // 卡片下面接着回过的各段（回应卡片上的红字）也带上
      prev_notes: S.page.ai.filter((a) => a.text && !a.dismissed && a.type !== 'arrow' && !gone(a, liveIds()))
        .map((a) => (a.type === 'write' ? Object.assign({ n: a.n, q: a.q, text: a.text }, moreOf(a).length ? { more: moreOf(a).map((m) => ({ q: m.q, text: m.text })) } : {}) : a.text)),
      images: { crop: imgs.crop },
    };
  }

  // ask：发送时（不是快照）带上修改建议的决定
  function prepare(sel, groups, ask) {
    sel = padSel(sel, 16);
    if (sel.x1 - sel.x0 < 24 || sel.y1 - sel.y0 < 24) sel = padSel(sel, 24);
    for (const g of groups) g.inSel = inSel(g.bbox, sel);
    const vs = ask ? verdictsOf(groups) : [];
    const imgs = renderForAI(sel, groups, vs);
    return { sel, vs, imgs };
  }

  // 这组笔迹写在什么上面（给 Claude 判断角色）：书页的印刷内容上，还是纸上
  function groupOn(g) {
    if (S.bgImg && centerIn(g.bbox, [0, 0, W, S.baseH])) return 'doc';
    return 'paper';
  }

  // 要我点 ✓/× 的：修改建议，以及概念图上建议加的概念、连线、分组
  const VOTE_TYPES = new Set(['suggest', 'label', 'node', 'link', 'group']);

  // 这一页已经点了 ✓/×、还没发出去的修改建议，编号 s1、s2……（图里标在框的左上角）；near：之后在框旁边新写的组
  function verdictsOf(groups) {
    const gid = new Map();
    for (const g of groups) for (const s of g.strokes) gid.set(s.id, g.id);
    const meets = (p, q) => p[0] < q[2] && p[2] > q[0] && p[1] < q[3] && p[3] > q[1];
    return S.page.ai.filter((a) => VOTE_TYPES.has(a.type) && a.verdict && !a.sent && !a.dismissed && a.box).map((a, k) => {
      const z = [a.box[0] - 40, a.box[1] - 40, a.box[2] + 40, a.box[3] + 40], on = new Set(a.on || []);
      const ids = inkStrokes().filter((s) => !s.erasedAt && s.t0 > (a.t || 0) && !on.has(s.id) && meets(strokeBox(s), z)).map((s) => gid.get(s.id));
      return { a, id: 's' + (k + 1), bbox: a.box, near: Array.from(new Set(ids.filter(Boolean))).join('、') };
    });
  }

  // 用笔回应建议：起笔落在建议框里的一笔，打勾＝采纳，横划或叉（两笔交叉）＝不采纳。这一笔不留作笔迹，可以撤销
  function voteTarget(pt) { // 好几个框都包住这一点时（分组框里有概念、连线），取最小的那个
    const live = liveIds();
    let best = null, bestArea = Infinity;
    for (const a of S.page.ai) {
      if (!VOTE_TYPES.has(a.type) || a.sent || a.dismissed || !a.box || gone(a, live)) continue;
      const b = a.vbox || a.box, area = (b[2] - b[0]) * (b[3] - b[1]);
      if (pt[0] >= b[0] - 12 && pt[0] <= b[2] + 12 && pt[1] >= b[1] - 12 && pt[1] <= b[3] + 12 && area < bestArea) { best = a; bestArea = area; }
    }
    return best;
  }

  function gestureOnVote(st) {
    const a = st.pts.length ? voteTarget(st.pts[0]) : null;
    if (!a) return false;
    const g = Gesture.classify(st.pts);
    if (g === 'tick' || g === 'strike') { decide(a, g === 'tick' ? 'yes' : 'no'); return true; }
    if (g === 'diag') { // 叉：两笔斜线交叉；第一笔先当笔迹留着，第二笔来了再一起拿掉
      const d = S.lastDiag;
      if (d && d.item === a.id && performance.now() - d.t < 2500 && Gesture.crosses(d.pts, st.pts)) {
        S.page.strokes = S.page.strokes.filter((s) => s.id !== d.id);
        const k = S.undo.findIndex((u) => u.t === 'add' && u.id === d.id); // 第一笔留作笔迹时记的撤销也拿掉：打叉只算一步，撤销一次就回到没定
        if (k >= 0) S.undo.splice(k, 1);
        S.lastDiag = null;
        drawInk();
        decide(a, 'no');
        return true;
      }
      S.lastDiag = { item: a.id, id: st.id, pts: st.pts, t: performance.now() };
    }
    return false;
  }

  // 蓝字（不是建议）：在旁边画星号＝采纳（深蓝实线，再画一次取消），长回答在圈号旁画星号也是采纳。
  // 不要的蓝字用橡皮擦（撤销能找回）；以前横划过的（dismissed）照旧画成淡的
  function blueTarget(pt, pad) {
    const live = liveIds();
    let best = null, bestArea = Infinity;
    for (const a of S.page.ai) {
      if (a.erasedAt || VOTE_TYPES.has(a.type) || gone(a, live)) continue;
      const h = a.type === 'write' ? (isBadge(a) ? badgeBox(a) : null) : a.hit;
      if (!h) continue;
      const area = (h[2] - h[0]) * (h[3] - h[1]);
      if (pt[0] >= h[0] - pad && pt[0] <= h[2] + pad && pt[1] >= h[1] - pad && pt[1] <= h[3] + pad && area < bestArea) { best = a; bestArea = area; }
    }
    return best;
  }

  function gestureOnBlue(st) {
    if (st.pts.length < 2 || Gesture.classify(st.pts) !== 'star') return false;
    const b = Gesture.box(st.pts), a = blueTarget([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2], 40);
    if (!a) return false;
    flag(a, 'adopted', !a.adopted, a.adopted ? '取消采纳' : '采纳：深蓝实线（撤销可以收回）');
    return true;
  }

  function flag(a, key, on, msg) {
    S.undo.push({ t: 'flag', id: a.id, key, prev: Boolean(a[key]) });
    if (on) a[key] = true; else delete a[key];
    renderAI();
    markDirty();
    toast(msg, 1800);
  }

  // 有回应指着的笔迹：红笔问题算回答过了
  function answeredIds() {
    const s = new Set();
    for (const a of S.page.ai) if (!a.dismissed) for (const x of [].concat(a.on || [], a.on2 || [])) s.add(x);
    return s;
  }

  function decide(a, v) {
    const prev = a.verdict;
    if (v) a.verdict = v; else delete a.verdict;
    S.undo.push({ t: 'verdict', id: a.id, prev });
    renderAI();
    markDirty();
    // 决定跟着下一次点「AI」带给 Claude（那一页没写新字也会带上）
    toast(!v ? '取消了，还没定' : `${v === 'yes' ? '采纳' : '不采纳'}（下次点「AI」时带给 Claude，撤销可以收回）`, 2600);
  }

  function setVerdict(it, v) { // ✓ × 钮：点一下定，同一个再点一下取消
    decide(it, it.verdict === v ? undefined : v);
  }

  // ✓ × 两个圆钮（2026-11-04 用户要回来的：框里画勾难画）：框右边放得下就放在右边、和框齐平，否则放在框上方右端
  function verdictButtons(a) {
    const b = a.vbox || a.box, r = 15, gap = 8;
    if (b[2] + gap + 4 * r + gap <= S.TW - 6) {
      const y = (b[1] + b[3]) / 2, x1 = b[2] + gap + r;
      return [{ v: 'yes', x: x1, y, r }, { v: 'no', x: x1 + 2 * r + gap, y, r }];
    }
    const x2 = b[2] - r, x1 = x2 - 2 * r - gap, y = b[1] - r - 10 >= S.Y0 + r ? b[1] - r - 10 : b[3] + r + 6;
    return [{ v: 'yes', x: x1, y, r }, { v: 'no', x: x2, y, r }];
  }
  // 点在哪个 ✓ / × 钮上（页面坐标）：钮挨得近时取最近的那个
  function voteButtonAt(x, y) {
    const live = liveIds();
    let best = null, bestD = Infinity;
    for (const a of S.page.ai) {
      if (!VOTE_TYPES.has(a.type) || a.sent || a.dismissed || !a.box || gone(a, live)) continue;
      for (const vb of verdictButtons(a)) {
        const d = Math.hypot(x - vb.x, y - vb.y);
        if (d <= vb.r + 12 && d < bestD) { best = { a, v: vb.v }; bestD = d; }
      }
    }
    return best;
  }
  // 点了 ✓ × 钮：手指走 tapAiItem，笔走 commitStroke（这一点不留作笔迹）
  function tapVote(x, y) {
    const hb = voteButtonAt(x, y);
    if (!hb) return false;
    setVerdict(hb.a, hb.v);
    return true;
  }
  function penTapVote(st) {
    const b = strokeBox(st);
    return b[2] - b[0] <= 16 && b[3] - b[1] <= 16 && tapVote(st.pts[0][0], st.pts[0][1]);
  }
  // 用笔（电脑上是鼠标）点一下圈号：打开那条长回答的卡片，这一点不留作笔迹
  function penTapBadge(st) {
    const b = strokeBox(st);
    if (b[2] - b[0] > 16 || b[3] - b[1] > 16) return false;
    const a = badgeAtWorld(st.pts[0][0], st.pts[0][1]);
    if (!a) return false;
    tapBadge(a);
    return true;
  }

  // 建议框上的一行状态：发出后写采纳 / 改着呢，Claude 回报后写已改 / 没改成；那次修改在平板上撤回了写已撤回；还没发的不写（看 ✓ × 钮）
  function voteStatus(a) {
    if (a.result && a.result.ok && a.result.edit && ((S.nb && S.nb.undone) || []).includes(a.result.edit)) return ['已撤回', 'undone'];
    if (a.result) return a.result.ok ? ['已改', 'ok'] : ['没改成' + (a.result.text ? '：' + a.result.text : ''), 'fail'];
    if (a.sent) return a.verdict === 'yes' ? [a.type === 'suggest' ? '改着呢…' : '已采纳', 'yes'] : ['不采纳', 'no'];
    return ['', '']; // 还没发：✓ × 钮的颜色就说明了定没定
  }

  // 这本里有新笔迹（Claude 上次看过之后新写或擦改）的页：others 是这一页以外的（从 0 起），n 是一共几页
  async function newPages() {
    try {
      await flushSave();
      const all = (await (await api(`/api/new-pages?nb=${encodeURIComponent(S.nb.id)}`)).json()).pages || [];
      return { others: all.filter((i) => i !== S.idx), n: all.length };
    } catch (e) {
      return { others: [], n: 0 };
    }
  }

  // 把这一页整页交给 Claude（点「AI」时只有这一页有新写的）：采纳 / 不采纳的决定随这一次带上
  async function send() {
    if (!S.page || S.sending || localBlocked() || targetGone(send)) return;
    const nbId = S.nb.id, sentPage = S.page;
    const groups = computeGroups(inkStrokes());
    const raw = wholePageSel();
    await flushSave(); // 服务器按存好的这一页做本机手写识别
    const { sel, imgs, vs } = prepare(raw, groups, true);
    const body = Object.assign(payloadFor(groups, sel, imgs), { target: effectiveTarget() || '',
      verdicts: vs.length ? vs.map((v) => ({ id: v.id, ref: v.a.id, kind: v.a.type, text: v.a.text, verdict: v.a.verdict,
        on: v.a.onDoc ? 'doc' : 'mine', near: v.near || undefined })) : undefined });
    S.sending = true;
    updateCheck();
    try {
      const r = await api('/api/send', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
      const res = await r.json();
      S.page.lastSent = Date.now();
      startRound(res.id, nbId); // 「AI」按钮变成「已交」；进度只写在按钮上（纸上不再有「已发给……」那一块）
      for (const v of vs) v.a.sent = true; // 决定带出去了：这几条画淡，钮不能再点
      // 卡片上的红字跟着交上去了（服务端按存好的这一页挑的、画成了图）：记下这一轮，圈号上的红点没了
      if (markCardsSent(sentPage, res.cards, res.id) && sentPage === S.page) renderAI();
      if (vs.length) renderAI();
      markDirty();
      toast(`已交给「${sentName(res)}」`, 2200);
    } catch (e) {
      if (e.status === 410 && (await refreshSessions(), targetGone(send))) return; // 刚断开：先问发往哪个对话
      toast('没发出去：' + e.message, 6000);
    } finally {
      S.sending = false;
      updateCheck(); // 没交出去：按钮还是原来的字（「AI」，或这本上一轮还没走完的那一步）
    }
  }

  // Claude 调用 ink_snapshot 时，把当前页（全部笔迹）传回去
  async function doSnapshot(rid) {
    if (!S.page) return;
    await flushSave();
    const groups = computeGroups(inkStrokes());
    let box = null;
    for (const g of groups) if (g.n > g.erased) box = box ? unionBox(box, g.bbox) : g.bbox.slice();
    const raw = box ? { x0: box[0], y0: box[1], x1: box[2], y1: box[3] } : { x0: S.X0, y0: S.Y0, x1: S.W, y1: S.pageH };
    const { sel, imgs } = prepare(raw, groups);
    const body = Object.assign(payloadFor(groups, sel, imgs), { rid });
    try {
      await api('/api/snapshot', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
      toast('Claude 看了一眼这一页', 1600);
    } catch (e) { /* 请求过期就算了 */ }
  }

  // Claude 用 ink_reply 写回的批注先存在服务器的待处理队列，打开这一页时取来落下。
  // 取的时候翻走了（服务器那边已经取走）：留在 held 里，那一页成为当前页、或在连续阅读时显示在屏幕上时再落
  const held = new Map(); // 本子#页 → 取来了、还没落下的待处理条目
  async function fetchPending(nbId, i) {
    let list = [];
    try { list = await (await api(`/api/pending?nb=${encodeURIComponent(nbId)}&i=${i}`)).json(); } catch (e) { return false; }
    const key = nbId + '#' + i;
    S.pendingPages.delete(key);
    if (Array.isArray(list) && list.length) held.set(key, (held.get(key) || []).concat(list));
    return true;
  }
  async function processPending() {
    if (!S.page || !S.nb) return;
    const nb = S.nb, i = S.idx;
    if (!(await fetchPending(nb.id, i))) return;
    if (S.page && S.nb === nb && S.idx === i) landHere();
    else landSoon();
  }

  // 落下当前页取来了的待处理条目（同步做完，中途不会换页）。长回答到了：圈号跳两下，屏幕上方说一句「Claude 回了 N 条」
  function landHere() {
    const key = pageKey(), list = held.get(key);
    if (!list || !list.length) return 0;
    held.delete(key);
    let answers = 0;
    for (const p of list) {
      if (!p || typeof p !== 'object') continue; // 不认识的条目：跳过
      if (Array.isArray(p.vsent)) { // 整本发送时带上了这一页的 ✓/× 决定：记成发过了
        for (const a of S.page.ai) if (p.vsent.includes(a.id)) a.sent = true;
        renderAI();
        markDirty();
        continue;
      }
      if (p.msent && typeof p.msent === 'object') { // 几页一起交时带上了这一页卡片上的红字：记下这一轮，红点没了
        if (markCardsSent(S.page, p.msent, p.req)) { renderAI(); markDirty(); }
        continue;
      }
      if (p.relocate) continue; // 对旧批注的判断（收起、挪动）：这个功能删了，这种条目直接跳过
      if (!Array.isArray(p.items)) continue; // 别的不认识的条目（比如以前的「回答上的批注发过了」）：跳过
      // 发出去之后这一页又转过：回复里的框、圈选框、笔迹分组的位置换算到现在的方向
      const conv = typeof p.rot === 'number' && p.rot !== (S.page.rot || 0) ? Turn.between(p.rot, S.page.rot || 0, S.baseH0) : null;
      const fix = (b) => (conv ? Turn.box(conv, b) : b);
      const s = p.sel || { x0: S.X0, y0: S.Y0, x1: S.W, y1: S.pageH };
      const T = {
        req: p.req, level: p.level, selBox: p.sel ? fix([s.x0, s.y0, s.x1, s.y1]) : [s.x0, s.y0, s.x1, s.y1], conv,
        crop: p.crop || { x0: 0, y0: 0, x1: S.TW, y1: S.pageH, scale: 1 },
        groups: new Map(Object.keys(p.groups || {}).map((id) => [id, Object.assign({ bbox: fix(p.groups[id]) }, (p.gx || {})[id])])),
      };
      for (const it of Array.isArray(p.items) ? p.items : []) if (it && typeof it === 'object' && onItem(it, T) === 'write') answers++;
    }
    if (answers) toast(`Claude 回了 ${answers} 条`, 3000);
    flushSave();
    return answers;
  }

  // 连续阅读：这一页（第 i 页）有没有正显示在屏幕上（在画出来的相邻页里、和屏幕有重叠）；是的话返回它在 flowStrip 里的那一项
  function neighborOnScreen(i) {
    if (!S.flow || !S.page || !S.nb || i === S.idx) return null;
    const n = flowStrip().find((m) => m.i === i);
    if (!n) return null;
    const v = S.view, top = v.ty + (n.D + n.G.Y0) * v.s, bottom = v.ty + (n.D + n.G.pageH) * v.s;
    return bottom > 20 && top < VH - 20 ? n : null;
  }

  // 连续阅读：Claude 回在屏幕上看得见、但不是当前页的那一页上——取来，把那一页临时换成当前页落下，再换回来。
  // 换页用的是滑动换页的同一个办法（activate），屏幕上一点不动；正在写字、擦除、挪纸时等一会儿再落
  async function landNeighbor(i) {
    const nb = S.nb;
    if (!nb || !(await fetchPending(nb.id, i))) return;
    landSoon(0);
  }
  function landSoon(ms = 400) {
    clearTimeout(landSoon.timer);
    landSoon.timer = setTimeout(landVisible, ms);
  }
  function landVisible() {
    if (!S.flow || !S.nb || !S.page || S.replay || S.compare) return;
    for (const key of Array.from(S.pendingPages)) { // Claude 回过、还没取来的页：现在显示在屏幕上了就去取
      const [nbId, i] = [key.slice(0, key.lastIndexOf('#')), Number(key.slice(key.lastIndexOf('#') + 1))];
      if (nbId === S.nb.id && neighborOnScreen(i)) { S.pendingPages.delete(key); landNeighbor(i); return; }
    }
    if (held.has(pageKey())) landHere();
    const busy = S.cur || S.erasing || touches.size || gesture;
    for (const key of Array.from(held.keys())) {
      const [nbId, i] = [key.slice(0, key.lastIndexOf('#')), Number(key.slice(key.lastIndexOf('#') + 1))];
      if (nbId !== S.nb.id) continue;
      const n = neighborOnScreen(i);
      if (!n) continue;
      if (busy) { landSoon(600); return; } // 正在写字、擦除、挪纸：等一会儿
      const back = S.idx;
      S.landing = true;
      try {
        if (!activate(n.i, n.ent, n.D)) return;
        landHere();
        const m = flowStrip().find((x) => x.i === back);
        if (m) activate(m.i, m.ent, m.D); // 换回原来那一页，屏幕不动
      } finally {
        S.landing = false;
      }
      redrawAll();
    }
  }

  async function eventsLoop() {
    for (;;) {
      try {
        const d = await (await api(`/api/events?since=${S.evSeq}&wait=20`)).json();
        const isFirst = S.evSeq === 0;
        S.evSeq = d.seq;
        if (!S.online) { S.online = true; updateStatus(); refreshSessions(); loadCards(); } // 连上了：顶上「连不上电脑」那句收起
        if (!isFirst) for (const ev of d.events) handleEvent(ev);
        // 刚打开（刷新）页面：以前的事件不再处理，只拿服务记着的最近几步，补上刷新前交的那一轮在刷新那会儿走到了哪（见 restoreRounds）
        else for (const ev of d.events) if (ev.type === 'progress') onProgress(ev);
      } catch (e) {
        if (e.message === '访问码不对') return;
        if (S.online) { S.online = false; updateStatus(); }
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  // 这本发往哪个对话：绑了的那个（不在了是 gone）；没绑过的用默认（/ink here 指定的或最近打字的），第一次发送时记下
  function nbTarget() {
    const t = S.nb && S.nb.target, ss = S.sessions || [];
    if (t) { const s = ss.find((x) => x.sid === t.sid); return s ? { s } : { gone: t }; }
    const s = ss.find((x) => x.sid === S.defaultTarget);
    return s ? { s, auto: true } : {};
  }
  function effectiveTarget() { const t = nbTarget(); return t.s ? t.s.sid : null; }

  // 对话的叫法（抽屉里「这本发往」那一行、选对话的列表、「已交给……」的提示、导入面板的下拉框都用这一套）：
  // 项目文件夹的名字；名字相同、完整路径不同的文件夹，带上上一级文件夹的名字；同一个文件夹开着几个对话时，
  // 后面再加上最近在那个对话里打的一句话的开头（还没打过字的写什么时候开的）
  const pathKey = (s) => String(s.cwd || '').replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase() + '\n' + s.label;
  function parentName(cwd) {
    const parts = String(cwd || '').split(/[\\/]+/).filter(Boolean);
    return parts.length >= 2 ? parts[parts.length - 2] : '';
  }
  function folderTitle(s) {
    const clash = (S.sessions || []).some((x) => x.label === s.label && pathKey(x) !== pathKey(s));
    const up = clash ? parentName(s.cwd) : '';
    return up ? `${s.label}（${up}）` : s.label;
  }
  function targetName(s) {
    if ((S.sessions || []).filter((x) => pathKey(x) === pathKey(s)).length < 2) return folderTitle(s);
    const tag = s.hint ? `『${clip(s.hint, 10)}』` : s.started ? `（${startText(s.started)} 开的）` : `（${s.sid.slice(0, 4)}）`;
    return folderTitle(s) + tag;
  }
  // 「已交给……」：交给的那个对话的叫法（服务回来的是对话的编号和文件夹名）
  function sentName(res) {
    const s = (S.sessions || []).find((x) => x.sid === res.target);
    return s ? targetName(s) : res.label;
  }
  function clip(t, n) { return t.length > n ? t.slice(0, n) + '…' : t; }
  const LOCAL_TARGET = '只在本地（不发给 Claude）';
  function targetText() {
    if (S.nb && S.nb.local) return LOCAL_TARGET;
    const t = nbTarget();
    return t.s ? targetName(t.s) : t.gone ? `「${t.gone.label}」（不在了）` : '还没有连着的对话';
  }
  function ago(sec) {
    return sec < 90 ? '刚刚' : sec < 3600 ? `${Math.round(sec / 60)} 分钟前` : sec < 2 * 86400 ? `${Math.round(sec / 3600)} 小时前` : `${Math.round(sec / 86400)} 天前`;
  }
  // 对话什么时候开的：今天 14:05、昨天 21:30、11月12日 09:10
  function startText(ms) {
    const d = new Date(ms), now = new Date(), p2 = (n) => String(n).padStart(2, '0');
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(now) - day(d)) / 86400000), hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
    return diff === 0 ? `今天 ${hm}` : diff === 1 ? `昨天 ${hm}` : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  }

  // 连着的对话按项目文件夹分组：最近有人打字的文件夹在前，组里最近打字的在前（服务给的列表本来就是最近打字的在前）
  function sessionGroups(ss) {
    const groups = new Map();
    for (const s of ss) {
      const k = pathKey(s);
      if (!groups.has(k)) groups.set(k, { title: folderTitle(s), items: [] });
      groups.get(k).items.push(s);
    }
    return Array.from(groups.values());
  }

  // 选这本发往哪个对话（以后都发到这里）。按文件夹分组，文件夹名做小标题；每个对话一行两行字：
  // 最近在那个对话里打的一句话（还没打过字的照写），下面小字写什么时候开的、多久前活跃、执行过 /ink 没有；现在发往的打 ✓。
  // 最下面隔开一项「不发给 Claude（只在本地）」：选了这本就只在本地；只在本地时再选一个对话，就取消只在本地、发往那个对话。
  // why 写在顶上（原对话不在了时）；then 选好对话后接着做（比如接着发送），选了只在本地就不接着做
  function openTargetPick(why, then) {
    hideMenu();
    closeFolderPick();
    const ss = S.sessions || [], local = Boolean(S.nb && S.nb.local), cur = local ? null : effectiveTarget(), list = $('#targetPickList');
    $('#targetPickHead').textContent = why || '这本发往哪个对话（以后都发到这里）';
    list.innerHTML = '';
    if (!ss.length) {
      const d = document.createElement('div');
      d.className = 'row small';
      d.textContent = '还没有连上的对话：在电脑上打开一个装了 inkpad 插件的 Claude Code 对话';
      list.appendChild(d);
    }
    for (const g of sessionGroups(ss)) {
      const h = document.createElement('div');
      h.className = 'tp-folder';
      h.setAttribute('data-lang-keep', ''); // 文件夹名是电脑上的名字，不翻译
      h.textContent = g.title;
      list.appendChild(h);
      for (const s of g.items) list.appendChild(sessionRow(s, s.sid === cur, then));
    }
    const sep = document.createElement('div');
    sep.className = 'tp-sep';
    const lb = pickRow('tp-local', local);
    lb.id = 'tpLocal';
    lb.querySelector('.tp-l1').textContent = '不发给 Claude（只在本地）';
    lb.addEventListener('click', () => { $('#targetPick').hidden = true; if (!local) setLocal(S.nb, true); });
    list.append(sep, lb);
    $('#targetPick').hidden = false;
  }

  // 列表里的一行：上面一行字（.tp-l1）、下面一行小字（.tp-l2，可以没有），选中的白底加粗边框、右边打 ✓
  function pickRow(cls, on) {
    const b = document.createElement('button');
    b.className = `row ${cls}` + (on ? ' on' : '');
    const main = document.createElement('span'), l1 = document.createElement('span');
    main.className = 'tp-main';
    l1.className = 'tp-l1';
    main.appendChild(l1);
    b.appendChild(main);
    if (on) {
      const c = document.createElement('span');
      c.className = 'tp-check';
      c.textContent = '✓';
      b.appendChild(c);
    }
    return b;
  }

  function sessionRow(s, on, then) {
    const b = pickRow('tp-sess', on), l1 = b.querySelector('.tp-l1'), l2 = document.createElement('span');
    b.dataset.sid = s.sid;
    if (s.hint) {
      l1.textContent = s.hint;
      l1.setAttribute('data-lang-keep', ''); // 你打的字，不翻译
    } else {
      l1.textContent = '还没打过字';
      l1.classList.add('none');
    }
    l2.className = 'tp-l2';
    // 什么时候开的：插件报来的（拿不到就不写这一段，不编）
    l2.textContent = [s.started ? `${startText(s.started)} 开的` : '', `${ago(s.idle || 0)}活跃`, s.ink ? '执行过 /ink' : ''].filter(Boolean).join(' · ');
    b.querySelector('.tp-main').appendChild(l2);
    b.addEventListener('click', async () => {
      $('#targetPick').hidden = true;
      if ((await chooseTarget(s.sid)) && then) then();
    });
    return b;
  }

  // 在列表里选了一个对话：先记成发往它（那个对话刚断开就什么都不变），这本只在本地的再取消只在本地
  async function chooseTarget(sid) {
    if (!S.nb || !sid || !(await bindTarget(sid))) return false;
    return S.nb.local ? setLocal(S.nb, false) : true;
  }

  async function bindTarget(sid) {
    if (!S.nb || !sid) return false;
    try {
      const r = await (await api('/api/notebook/target', { method: 'POST', body: JSON.stringify({ nb: S.nb.id, sid }),
        headers: { 'Content-Type': 'application/json' } })).json();
      S.nb.target = r.target;
    } catch (e) {
      toast('没换成：' + e.message, 4000);
      return false;
    }
    updateTargetRow();
    return true;
  }

  // 这本绑定的对话不在了：先问发往哪个对话（列表最下面照样有「只在本地」），选好后接着做 then；
  // 没有连着的对话时不拦（发送时会提示）；只在本地的本子不问（发送前已经拦下）
  function targetGone(then) {
    const t = nbTarget();
    if ((S.nb && S.nb.local) || !t.gone || !(S.sessions || []).length) return false;
    openTargetPick(`这本原来发往「${t.gone.label}」，那个对话现在不在了。发往：`, then);
    return true;
  }

  function handleEvent(ev) {
    if (ev.type === 'sessions') {
      refreshSessions();
    } else if (ev.type === 'ai') {
      if (S.nb && ev.nb === S.nb.id && ev.page === S.idx) processPending();
      else if (S.nb && ev.nb === S.nb.id && neighborOnScreen(ev.page)) landNeighbor(ev.page); // 连续阅读：那一页正显示在屏幕上，直接落下
      else if (ev.what !== 'relocate') { // 不在屏幕上：等翻到时落下（对旧批注的判断已删，不提示）
        if (S.nb && ev.nb === S.nb.id) S.pendingPages.add(ev.nb + '#' + ev.page); // 连续阅读时滑到屏幕上也落下（landVisible）
        toast(`Claude 在别的页写了批注：${ev.label}`, 5000, '去看看', () => openNotebook(ev.nb, ev.page));
      }
    } else if (ev.type === 'folders') { // 抽屉里的文件夹改过了（这台或别的设备上）
      loadNotebooks().catch(() => {});
    } else if (ev.type === 'show') {
      loadNotebooks(S.nb && S.nb.id);
      const what = ev.nb && ev.nb.startsWith('book:') ? `Claude 导入了《${ev.title}》` : `Claude 推送了一页：${ev.title}`;
      toast(what, 8000, '打开', () => openNotebook(ev.nb || 'board', ev.page));
    } else if (ev.type === 'snapshot') {
      doSnapshot(ev.rid);
    } else if (ev.type === 'flush') {
      flushSave();
    } else if (ev.type === 'vsent') { // 整本发送带上了这几页的 ✓/× 决定：画淡，不再发
      if (!S.nb || ev.nb !== S.nb.id) return;
      for (const [k, ids] of Object.entries(ev.pages || {})) {
        const i = Number(k), pg = i === S.idx ? S.page : (S.flowCache.get(i) || {}).page;
        if (!pg) continue;
        for (const a of pg.ai) if (ids.includes(a.id)) a.sent = true;
        if (i === S.idx) { renderAI(); markDirty(); }
      }
    } else if (ev.type === 'msent') { // 几页一起交带上了这几页卡片上的红字：红点没了（没开着的页，打开时由待处理队列合进去）
      if (!S.nb || ev.nb !== S.nb.id) return;
      for (const [k, cards] of Object.entries(ev.pages || {})) {
        const i = Number(k), pg = i === S.idx ? S.page : (S.flowCache.get(i) || {}).page;
        if (markCardsSent(pg, cards, ev.req) && i === S.idx) { renderAI(); markDirty(); }
      }
      if (S.flow) drawNeighborBadges();
    } else if (ev.type === 'progress') { // 这一轮到哪一步了（插件报来）
      onProgress(ev);
    } else if (ev.type === 'confirm' || ev.type === 'confirmed' || ev.type === 'ask' || ev.type === 'asked') {
      loadCards(); // 顶上的卡片：来了一张（问字迹、问话），或答过了一张（可能是在别的设备上答的）
    } else if (ev.type === 'target') { // 这本改发到别的对话了（第一次发送、/ink here、推送或导入）
      if (S.nb && S.nb.id === ev.nb) { S.nb.target = ev.target; updateTargetRow(); }
    } else if (ev.type === 'updated') {
      // 文档原地更新了（Claude 导入了新版，或接受了「替换旧版」）；平板上自己点的更新由 updateBook 处理
      if (S.selfUpdate && (S.selfUpdate === ev.nb || S.selfUpdate === ev.old)) { S.selfUpdate = null; return; }
      loadNotebooks(S.nb && S.nb.id === ev.old ? ev.nb : S.nb && S.nb.id);
      const msg = updateMessage(ev.title, ev.prev, ev.text);
      if (S.nb && (S.nb.id === ev.nb || S.nb.id === ev.old)) {  // 替换成新版本时本子可能改了名
        openNotebook(ev.nb, S.idx).then(() => toast(msg, 8000));
      } else {
        toast(msg, 8000, '打开', () => openNotebook(ev.nb, 0));
      }
    } else if (ev.type === 'undone') { // 撤回了一次修改（这台上自己点的由 undoEdit 处理；别的设备上撤回的：这本重新打开）
      if (S.selfUpdate && (S.selfUpdate === ev.nb || S.selfUpdate === ev.old)) { S.selfUpdate = null; return; }
      if (S.nb && (S.nb.id === ev.nb || S.nb.id === ev.old)) openNotebook(ev.nb, S.idx);
      else loadNotebooks().catch(() => {});
    } else if (ev.type === 'deleted') {
      if (S.nb && S.nb.id === ev.nb) openNotebook('scratch', 0);
      loadNotebooks(S.nb && S.nb.id !== ev.nb ? S.nb.id : 'scratch');
    }
  }

  // ------------------------------------------------------------ 「AI」按钮上的进度
  // 平时写「AI」（2026-11-14 从「检查」改名：用户说点它不一定是要检查，也可能是补充）。
  // AI →（排队中）→ 已交 → Claude 在看 → 在改文件 → 这一轮结束变回「AI」。进度只写在这个按钮上，纸上不另写。
  // 每本记自己最近交的那一轮：换到别的本子是那一本的样子。
  // 这本「只在本地」时按钮写「只在本地」、灰色带锁，点了只提示怎么取消，不发。
  // 几步谁先谁后：服务收下（sent）、对话正忙在排队（queued）、进了对话（delivered）、Claude 读了交上去的图（reading）、
  // 第一次写回草稿纸（replied）、改文件或跑命令（working）、这一轮结束（done）。按钮只往前走不往回退：
  // 改过文件后又读了一次图，还是「在改文件」；写回了批注，至少是「Claude 在看」（写回之后可能还在接着改，不当作结束）
  const ROUND_RANK = { sent: 0, queued: 1, delivered: 2, reading: 3, replied: 3, working: 4, done: 5 };
  const IDLE_TEXT = 'AI';
  const CHECK_TEXT = { sent: '已交', queued: '排队中', delivered: '已交', reading: 'Claude 在看', working: '在改文件' };
  const LOCAL_TEXT = '只在本地';
  const LOCK_HTML = `<span class="ck-lock" aria-hidden="true">${iconSvg('lock')}</span>`; // 只在本地时字前面的那把锁
  const known = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k); // 只认表里写了的那几步

  // 插件报来一步（服务转来的 progress 事件）。服务自己收下时也报一次 sent：那时按钮已经是「已交」了，不用再管
  function onProgress(ev) {
    if (!S.mine.has(ev.id) || !known(ROUND_RANK, ev.stage) || ev.stage === 'sent') return;
    advanceRound(ev.id, ev.stage, ev.t);
  }

  // 交上去了（服务收下）：这本的新一轮从「已交」开始，上一轮还没走完的不再显示
  function startRound(id, nb) {
    S.mine.set(id, nb);
    const old = S.rounds.get(nb);
    if (old) clearTimeout(old.timer);
    const r = { id, nb, stage: 'sent', t: Date.now(), end: false };
    S.rounds.set(nb, r);
    armRound(r);
    saveRounds();
    updateCheck();
  }

  // at：服务记下这一步的时刻（刷新后补上的几步是以前的事，等待时间不从补上的这一刻重新算）
  function advanceRound(id, stage, at) {
    const r = S.rounds.get(S.mine.get(id));
    if (!r || r.id !== id || r.end === 'done') return; // 这本后来又交过一次（按钮上显示新的那一轮），或这一轮已经结束
    if (stage === 'done') r.end = 'done';
    else {
      r.end = false; // 等太久收回去以后又有了下一步（比如排队排得久）：接着显示
      if (ROUND_RANK[stage] > ROUND_RANK[r.stage]) r.stage = stage === 'replied' ? 'reading' : stage;
      r.t = Math.max(r.t, typeof at === 'number' ? Math.min(Date.now(), at) : Date.now());
    }
    armRound(r);
    saveRounds();
    updateCheck();
  }

  // 从最近一步算起，等 S.roundWait 还没有下一步：按钮变回「AI」（之后再来下一步还会接着显示）
  function armRound(r) {
    clearTimeout(r.timer);
    if (r.end) return;
    r.timer = setTimeout(() => { r.end = 'timeout'; saveRounds(); updateCheck(); }, Math.max(0, S.roundWait - (Date.now() - r.t)));
  }

  // 没走完的几轮记在这台设备上：页面刷新（iPad 把放在后台的页面重新载入也算）后接着显示，见 restoreRounds
  function saveRounds() {
    store.set('rounds', Array.from(S.rounds.values()).filter((r) => !r.end).map((r) => ({ id: r.id, nb: r.nb, stage: r.stage, t: r.t })));
  }

  // 刷新后：取回记着的、还没等过头的那几轮；刷新那会儿错过的几步，由打开后第一次取事件时补上（服务记着最近 300 条事件）。
  // 服务重启过、或那几步已经不在服务记着的事件里：停在记着的那一步，等过头了变回「AI」
  function restoreRounds() {
    const now = Date.now();
    for (const x of store.get('rounds', [])) {
      if (!x || typeof x.id !== 'string' || typeof x.nb !== 'string' || !known(CHECK_TEXT, x.stage) || !(now - x.t < S.roundWait)) continue;
      const r = { id: x.id, nb: x.nb, stage: x.stage, t: x.t, end: false };
      S.mine.set(r.id, r.nb);
      S.rounds.set(r.nb, r);
      armRound(r);
    }
    saveRounds();
  }

  // 按钮现在该是哪个样子：'local'（只在本地）、一轮走到的那一步（sent、queued……）、''（平时的「AI」）
  function checkState() {
    if (!S.nb) return '';
    if (S.nb.local) return 'local';
    const r = S.rounds.get(S.nb.id);
    return r && !r.end ? r.stage : '';
  }

  // 右下角那一条和顶栏上的两个「AI」按钮一起改：字、进行中的浅蓝底、只在本地的灰底和锁。按钮一直能点（进行中再点就再交一次）
  function updateCheck() {
    const k = checkState(), busy = k !== 'local' && (Boolean(k) || Boolean(S.sending)); // 交着的那一小会儿也是进行中的样子
    for (const b of [$('#check'), $('#barCheck')]) {
      if (b.dataset.stage !== (k || 'idle')) {
        b.dataset.stage = k || 'idle';
        if (k === 'local') { b.innerHTML = LOCK_HTML; b.appendChild(document.createTextNode(LOCAL_TEXT)); }
        else b.textContent = k ? CHECK_TEXT[k] : IDLE_TEXT;
      }
      b.classList.toggle('busy', busy);
      b.classList.toggle('locked', k === 'local');
      if (k === 'local') b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled');
    }
  }

  // 按钮上会出现的几种字里最长的那个（中文或英文，带锁的算上锁）定按钮的最小宽度：换字时按钮宽度不变，右下角那一条不跳
  function fitCheckWidth() {
    const tr = (s) => (window.InkLang ? window.InkLang.t(s) : s);
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;left:-9999px;top:-9999px;visibility:hidden;white-space:nowrap';
    document.body.appendChild(probe);
    for (const b of [$('#check'), $('#barCheck')]) {
      const cs = getComputedStyle(b), px = (v) => parseFloat(v) || 0;
      Object.assign(probe.style, { fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontWeight: cs.fontWeight, letterSpacing: cs.letterSpacing });
      let w = 0;
      for (const s of [IDLE_TEXT, ...Object.values(CHECK_TEXT), LOCAL_TEXT]) {
        probe.innerHTML = s === LOCAL_TEXT ? LOCK_HTML : '';
        probe.appendChild(document.createTextNode(tr(s)));
        w = Math.max(w, probe.getBoundingClientRect().width);
      }
      const extra = cs.boxSizing === 'border-box' ? px(cs.paddingLeft) + px(cs.paddingRight) + px(cs.borderLeftWidth) + px(cs.borderRightWidth) : 0;
      b.style.minWidth = Math.ceil(w + extra + 2) + 'px';
    }
    probe.remove();
  }

  async function refreshSessions() {
    try {
      const d = await (await api('/api/sessions')).json();
      S.sessions = d.sessions;
      S.defaultTarget = d.default;
    } catch (e) { return; }
    updateTargetRow();
  }

  function onItem(it, T) {
    if (it.type === 'result') { // 回报：改成了标「已改」；没改成写原因，清掉决定，可以重新采纳
      const a = S.page.ai.find((o) => o.id === it.ref);
      if (!a) return;
      a.result = { ok: Boolean(it.ok), text: it.text || '', t: Date.now() };
      if (it.edit) a.result.edit = it.edit; // 是哪一次改文件改的：平板上撤回那一次，「已改」写成「已撤回」
      if (!it.ok) { delete a.verdict; a.sent = false; }
      renderAI();
      markDirty();
      return;
    }
    if (it.type === 'read') { // Claude 读到的字：照旧存进这一页（数据不丢），现在不显示
      S.page.reads = S.page.reads || [];
      S.page.reads.push({ req: T.req, t: Date.now(), level: T.level, text: it.text });
      markDirty();
      return;
    }
    if (it.type === 'write' && it.card !== undefined && appendToCard(it, T)) return 'write'; // 回应卡片上的红字：接在那张卡片下面
    const item = buildItem(it, T);
    if (!item) return null;
    S.page.ai.push(item);
    markDirty();
    if (item.type === 'write') S.fresh.set(item.id, performance.now()); // 圈号到了：跳两下（重画时接着跳，不从头来）
    if (S.aiVisible) {
      const gen = S.renderGen;
      S.aiQueue = S.aiQueue.then(() => (gen === S.renderGen ? drawItem(item, true) : null));
    }
    return item.type;
  }

  function resolveRef(it, key, T) {
    if (key === 'anchor' && Array.isArray(it.box)) {
      const c = T.crop, b = it.box;
      let bx = [c.x0 + Math.min(b[0], b[2]) / c.scale, c.y0 + Math.min(b[1], b[3]) / c.scale,
        c.x0 + Math.max(b[0], b[2]) / c.scale, c.y0 + Math.max(b[1], b[3]) / c.scale];
      if (T.conv) bx = Turn.box(T.conv, bx);
      return [clamp(bx[0], S.X0, S.TW), clamp(bx[1], S.Y0, S.pageH), clamp(bx[2], S.X0, S.TW), clamp(bx[3], S.Y0, S.pageH)];
    }
    let ref = String(it[key] || '').trim().toLowerCase();
    if (/^\d+$/.test(ref)) ref = 'g' + ref;
    const g = T.groups.get(ref);
    return g ? g.bbox.slice() : T.selBox.slice();
  }

  // 标注指着哪几笔（组编号 → 笔迹 id，只留这一页上有的）；指向印刷文字（box）、整块圈选（sel）、页面末尾（end）时不记
  function refIds(it, key, T) {
    if (key === 'anchor' && Array.isArray(it.box)) return null;
    let ref = String(it[key] || '').trim().toLowerCase();
    if (/^\d+$/.test(ref)) ref = 'g' + ref;
    const g = T.groups.get(ref);
    if (!g || !g.ids) return null;
    const have = new Set(S.page.strokes.map((s) => s.id)), ids = g.ids.filter((x) => have.has(x));
    return ids.length ? ids : null;
  }

  // 长回答没指着笔迹时：交上来的红笔（问题）都算它回答了
  function redIdsInSel(T) {
    const have = new Set(S.page.strokes.map((s) => s.id)), ids = [];
    for (const g of T.groups.values()) if (g.red && g.sel && g.ids) ids.push(...g.ids.filter((x) => have.has(x)));
    return ids.length ? ids : null;
  }

  // 这一页的笔迹（擦掉的也在里面，分组要算）
  function inkStrokes(page = S.page) {
    return page.strokes;
  }

  function centerIn(q, b) {
    const cx = (q[0] + q[2]) / 2, cy = (q[1] + q[3]) / 2;
    return cx >= b[0] && cx <= b[2] && cy >= b[1] && cy <= b[3];
  }

  // 这一页没擦掉的笔迹
  function liveIds(page = S.page) {
    const s = new Set();
    if (page) for (const st of inkStrokes(page)) if (!st.erasedAt) s.add(st.id);
    return s;
  }

  // 标注「落空」：它指着的笔迹都擦掉了（或已不在页面上）——不画、点不到、不发给 Claude；撤销擦除就回来。
  // 长回答不算：所答的红笔问题擦掉了，圈号照样留在原处、照样能点开
  function gone(a, live) {
    if (a.type === 'write') return false;
    if (a.type === 'proposal') return true; // 以前「挪动、收起我的笔迹」的提议（功能已删）：数据留着，不画、点不到、不发
    const dead = (ids) => Array.isArray(ids) && ids.length > 0 && !ids.some((x) => live.has(x));
    return dead(a.on) || dead(a.on2);
  }

  // ------------------------------------------------------------ 长回答：纸上一个圈号，点开浮出一张卡片（2026-11-13）
  // 数据：{ id, type: 'write', t, req, text, q, on, n（圈号）, at（圈号圆心，到达时定下）, seen（点开看过）, older?, adopted?, erasedAt? }

  // 带圈号位置的长回答（别的、不认识的样子不画、点不到）
  function isBadge(a) {
    return Boolean(a) && a.type === 'write' && Array.isArray(a.at) && a.at.length === 2 && a.at.every((v) => typeof v === 'number');
  }
  function badgeBox(a, pad = 0) {
    const r = BADGE_R + pad;
    return [a.at[0] - r, a.at[1] - r, a.at[0] + r, a.at[1] + r];
  }

  // 一组笔迹按行分开（和服务器 inksheet.lines 一样）：笔画中心的高度和某一行的平均高度差不到 0.6 个字高就归那一行。返回 [[笔迹]]，从上到下
  function strokeRows(strokes) {
    const ss = strokes.filter((s) => s.pts && s.pts.length);
    if (!ss.length) return [];
    const box = new Map(ss.map((s) => [s, strokeBox(s)]));
    const hs = ss.map((s) => box.get(s)[3] - box.get(s)[1]).sort((a, b) => a - b);
    const ch = Math.max(8, hs[Math.floor(hs.length * 0.75)]) * 1.3, cy = (s) => (box.get(s)[1] + box.get(s)[3]) / 2;
    const tall = ss.filter((s) => box.get(s)[3] - box.get(s)[1] > 1.6 * ch), rows = []; // 竖得很长的一笔（括号、竖线）：最后跟最近的一行
    for (const s of ss.filter((x) => !tall.includes(x)).sort((a, b) => cy(a) - cy(b))) {
      const row = rows.find((r) => Math.abs(r.sum / r.n - cy(s)) < 0.6 * ch);
      if (row) { row.sum += cy(s); row.n++; row.ss.push(s); } else rows.push({ sum: cy(s), n: 1, ss: [s] });
    }
    for (const s of tall) {
      if (rows.length) rows.reduce((p, q) => (Math.abs(q.sum / q.n - cy(s)) < Math.abs(p.sum / p.n - cy(s)) ? q : p)).ss.push(s);
      else rows.push({ sum: cy(s), n: 1, ss: [s] });
    }
    return rows.sort((p, q) => p.sum / p.n - q.sum / q.n).map((r) => r.ss);
  }
  const boxOf = (ss) => ss.map(strokeBox).reduce(unionBox);

  // 纸上已经占着的地方：没擦掉的笔迹、别的圈号、Claude 别的东西
  function occupied(except) {
    const out = [];
    for (const st of inkStrokes()) if (!st.erasedAt && st.pts.length) out.push(strokeBox(st));
    for (const a of S.page.ai) {
      if (a === except || a.erasedAt || a.dismissed) continue;
      if (isBadge(a)) out.push(badgeBox(a));
      else if (a.type !== 'write' && a.hit) out.push(a.hit);
    }
    return out;
  }

  // 长回答的圈号放哪（到达时定下，之后不跟着笔迹动）：所答那组笔迹最后一行的右端外侧、那一行竖直的中间，离字约 16；
  // anchor 是 end 或没给：这一页最后写的那组笔迹的右边；页面是空的：左上方。那里有字或别的圈号就往右、再往下挪到不压东西的地方
  function answerSpot(it, T) {
    let row = null;
    if (Array.isArray(it.box)) row = resolveRef(it, 'anchor', T); // 指着印刷文字：那块的右边
    else if (it.anchor && String(it.anchor).trim().toLowerCase() !== 'end') {
      const ids = new Set(refIds(it, 'anchor', T) || []), ss = inkStrokes().filter((s) => ids.has(s.id) && !s.erasedAt);
      if (ss.length) row = boxOf(strokeRows(ss).pop());
      else {
        let ref = String(it.anchor).trim().toLowerCase();
        if (/^\d+$/.test(ref)) ref = 'g' + ref;
        if (T.groups.has(ref)) row = resolveRef(it, 'anchor', T); // 那组笔迹已经擦掉了：按交上来时的位置
      }
    }
    if (!row) { // 没指着笔迹：最后写的那一组
      const live = computeGroups(inkStrokes()).filter((g) => g.n > g.erased);
      if (live.length) row = boxOf(strokeRows(live[live.length - 1].strokes.filter((s) => !s.erasedAt)).pop());
    }
    const R = BADGE_R, x0 = row ? row[2] + BADGE_GAP + R : 60, y0 = row ? (row[1] + row[3]) / 2 : 60;
    const maxX = S.TW - R - 6, obs = occupied(), pad = 4;
    const free = (x, y) => obs.every((o) => x + R + pad <= o[0] || x - R - pad >= o[2] || y + R + pad <= o[1] || y - R - pad >= o[3]);
    const top = S.Y0 + R + 4, bottom = Math.max(top, S.pageH - R - 4);
    for (let k = 0; k < 40; k++) { // 先往右，到了纸边再往下一行（约一行字高）从原来的横坐标找起
      const y = clamp(y0 + k * 32, top, bottom);
      for (let x = Math.min(x0, maxX); x <= maxX; x += 10) if (free(x, y)) return [n1(x), n1(y)];
      if (y >= bottom) break;
    }
    return [n1(Math.min(x0, maxX)), n1(clamp(y0, top, bottom))];
  }

  // 长回答到了：定下圈号的编号（这一页已有回答的最大圈号加一，擦掉的也占着号）和位置；回答文字一个字都不上纸
  function buildAnswer(it, T, base) {
    const item = { id: base.id, req: base.req, type: 'write', t: base.t, text: String(it.text || ''), on: base.on || [] };
    if (it.q) item.q = it.q;
    item.n = 1 + S.page.ai.reduce((m, a) => (a.type === 'write' && typeof a.n === 'number' ? Math.max(m, a.n) : m), 0);
    item.at = answerSpot(it, T);
    item.seen = false;
    return item;
  }

  // 在 parent 里画一个圈号：没看过的实心（蓝底白字），看过的空心（蓝圈蓝字），采纳的深蓝带 ★；刚到的跳两下
  function drawBadge(it, parent, cls) {
    const g = el('g', { class: (cls ? cls + ' ' : '') + 'badge' + (it.seen ? ' seen' : '') + (it.adopted ? ' adopted' : '') + (it.dismissed ? ' dismissed' : ''),
      'data-id': it.id }, parent);
    const hop = el('g', { class: 'bdg' }, g), [x, y] = it.at;
    el('circle', { cx: f1(x), cy: f1(y), r: BADGE_R }, hop);
    el('text', { x: f1(x), y: f1(y + BADGE_FS * 0.36), 'font-size': BADGE_FS, 'text-anchor': 'middle' }, hop).textContent = String(it.n || '');
    // 卡片上有还没交给 Claude 的红字：右上角一个红点（用 ellipse，不和圈号的 circle 混在一起）
    if (hasUnsentMarks(it)) el('ellipse', { class: 'bdot', cx: f1(x + BADGE_R * 0.78), cy: f1(y - BADGE_R * 0.78), rx: 4.6, ry: 4.6 }, hop);
    if (it.adopted) el('text', { x: f1(x + BADGE_R + 2), y: f1(y - BADGE_R + 6), 'font-size': 16, class: 'adopt-star' }, g).textContent = '★';
    const t0 = S.fresh.get(it.id);
    if (t0 !== undefined) {
      const age = performance.now() - t0;
      if (age < HOP_MS) { g.classList.add('fresh'); hop.style.animationDelay = `-${Math.round(age)}ms`; } else S.fresh.delete(it.id);
    }
    return g;
  }

  // 连续阅读：画出来的相邻页上的圈号，也画在批注层上（往下挪 D）；相邻页的别的蓝字画在底图画布上（paintNeighbor）
  function drawNeighborBadges() {
    const old = aiRoot.querySelector('.nbr-badges');
    if (old) old.remove();
    if (!S.flow || !S.page || !S.aiVisible || S.replay) return;
    const strip = flowStrip();
    if (!strip.length) return;
    const g = el('g', { class: 'nbr-badges' }, aiRoot);
    for (const n of strip) {
      const sub = el('g', { transform: `translate(0 ${f1(n.D)})`, 'data-page': n.i }, g);
      for (const a of n.ent.page.ai) if (isBadge(a) && !a.erasedAt) drawBadge(a, sub, 'nbr-badge');
    }
  }

  // 页面坐标 (x, y) 处当前页上的圈号（点的范围比圈稍大，屏幕上至少 22 像素）
  function badgeAtWorld(x, y, page = S.page) {
    if (!page || !S.aiVisible) return null;
    const reach = Math.max(BADGE_R + 6, 22 / S.view.s);
    let best = null, bestD = Infinity;
    for (const a of page.ai) {
      if (!isBadge(a) || a.erasedAt) continue;
      const d = Math.hypot(x - a.at[0], y - a.at[1]);
      if (d <= reach && d < bestD) { best = a; bestD = d; }
    }
    return best;
  }

  // 手指点一下屏幕上的 (cx, cy)：当前页上的圈号，或连续阅读时画出来的相邻页上的（那一页先换成当前页，屏幕不动）
  function tapBadgeAt(cx, cy) {
    const [x, y] = toWorld(cx, cy);
    let a = badgeAtWorld(x, y);
    if (!a && S.flow && !S.replay && !S.compare) {
      for (const n of flowStrip()) {
        const b = badgeAtWorld(x, y - n.D, n.ent.page);
        if (b && activate(n.i, n.ent, n.D)) { a = b; break; }
      }
    }
    if (!a) return false;
    tapBadge(a);
    return true;
  }

  // 点了圈号：打开它的卡片；它的卡片正开着（手指点：落下时不收卡片），或刚因为这一下落下而收起的正是它（笔点）：就是收起，不再打开
  function tapBadge(a) {
    if (S.card && S.card.id === a.id) { closeCard(); S.cardShut = null; return; }
    const c = S.cardShut;
    if (c && c.id === a.id && c.t >= (S.downAt || 0)) { S.cardShut = null; return; }
    openCard(a);
  }

  // 卡片里的一段文字：单独一行的 $$…$$ 用 KaTeX 排成公式（TeX 源码记在 data-tex 里，存排版快照时用），空行隔段，别的照原样（自动换行）
  function fillText(box, text) {
    box.textContent = '';
    for (const ln of String(text || '').split(/\r?\n/)) {
      const m = /^\s*\$\$(.+)\$\$\s*$/.exec(ln), d = document.createElement('div');
      if (m) { d.className = 'ac-tex'; d.dataset.tex = m[1].trim(); d.innerHTML = texHTML(m[1].trim()); } else if (!ln.trim()) d.className = 'ac-gap';
      else { d.className = 'ac-line'; d.textContent = ln; }
      box.appendChild(d);
    }
  }

  // -- 长回答的卡片：内容、在卡片上用红笔批注、追问（2026-11-14）
  // 数据都在那条长回答里：more 是 Claude 接在下面的各段回应 [{id, t, req, q, text, on}]；marks 是卡片上的红字
  // [{id, blk, pts, t0, w, c, req?, erasedAt?}]，坐标相对它所在那一块（主回答 a、某一段回应的 id、之前的版本 o0、o1……）的左上角，
  // 单位是固定宽度 CARD_W 下的单位：下面再接新段、底下的旧版往下挪，红字都不错位；sheet 是最近一次改红字时卡片的排版快照
  // （每一块的位置和高度、每一行字的位置和文字、公式的位置和 TeX），服务端照它画卡片的图给 Claude。
  // 没 req 的红字是「还没交」（圈号上的红点）；有 req、但不在任何一段回应的 on 里的是「交了还没被回应」：下次点「AI」两种都交
  const moreOf = (a) => (a && Array.isArray(a.more) ? a.more.filter((m) => m && typeof m === 'object' && String(m.text || '').trim()) : []);
  const marksOf = (a) => (a && Array.isArray(a.marks) ? a.marks.filter((m) => m && Array.isArray(m.pts) && m.pts.length) : []);
  function hasUnsentMarks(a) { return marksOf(a).some((m) => !m.erasedAt && !m.req); }
  function cardItem() { return S.card && S.page ? S.page.ai.find((o) => o.id === S.card.id) || null : null; }

  // 卡片里的内容：主回答（问：……、全文）、接着的各段回应（前面写着它回应的那句红字）、最底下之前的版本
  function renderCard(a) {
    $('#acQ').hidden = !a.q;
    $('#acQt').textContent = a.q || '';
    fillText($('#acBody'), a.text);
    const box = $('#acMore');
    box.textContent = '';
    for (const m of moreOf(a)) {
      const d = document.createElement('div');
      d.className = 'ac-blk ac-seg';
      d.dataset.blk = String(m.id);
      if (m.q) {
        const h = document.createElement('div'), lab = document.createElement('span'), t = document.createElement('span');
        h.className = 'ac-mq';
        lab.className = 'ac-mqh';
        lab.textContent = '红字：';
        t.className = 'ac-mqt';
        t.setAttribute('data-lang-keep', '');
        t.textContent = m.q;
        h.append(lab, t);
        d.appendChild(h);
      }
      const b = document.createElement('div');
      b.className = 'ac-mbody';
      b.setAttribute('data-lang-keep', '');
      fillText(b, m.text);
      d.appendChild(b);
      box.appendChild(d);
    }
    const older = (Array.isArray(a.older) ? a.older : []).map((o, k) => [o, k]).filter(([o]) => o && String(o.text || '').trim());
    $('#acOlder').hidden = !older.length;
    const list = $('#acOlist');
    list.textContent = '';
    for (const [o, k] of older) {
      const d = document.createElement('div');
      d.className = 'ac-old ac-blk';
      d.dataset.blk = 'o' + k;
      fillText(d, o.text);
      list.appendChild(d);
    }
  }

  // 卡片里的内容按固定宽度 CARD_W 排好，整体缩放到卡片的宽度（卡片宽约半屏，最多 460 像素）；返回缩放倍数
  function layoutCard() {
    const c = $('#answerCard'), pg = $('#acPage'), k = (c.clientWidth || CARD_W) / CARD_W;
    pg.style.transform = `scale(${k})`;
    const h = pg.offsetHeight;
    $('#acSizer').style.height = `${Math.ceil(h * k)}px`;
    const ink = $('#acInk');
    ink.setAttribute('width', CARD_W);
    ink.setAttribute('height', h);
    ink.setAttribute('viewBox', `0 0 ${CARD_W} ${h}`);
    if (S.card) S.card.k = k;
    return k;
  }

  // 卡片里的各块（主回答、各段回应、之前的版本）：块的编号 → {el, y, h}（固定宽度下的单位，从卡片内容的顶上量）
  function cardBlocks() {
    const pg = $('#acPage'), r0 = pg.getBoundingClientRect(), k = (S.card && S.card.k) || 1, out = new Map();
    for (const el of pg.querySelectorAll('.ac-blk')) {
      if (!el.getClientRects().length) continue; // 藏着的（没有之前的版本时那一栏）
      const r = el.getBoundingClientRect();
      out.set(el.dataset.blk, { el, y: (r.top - r0.top) / k, h: r.height / k });
    }
    return out;
  }

  // 屏幕上的一点 → 卡片内容里的坐标（固定宽度下的单位）
  function cardPoint(e) {
    const r = $('#acPage').getBoundingClientRect(), k = (S.card && S.card.k) || 1;
    return [(e.clientX - r.left) / k, (e.clientY - r.top) / k];
  }

  // 一笔红字画成 SVG（一个点的画成小圆），往下挪 dy（它那一块的顶）
  function drawMarkPath(parent, m, dy, cls) {
    const p = m.pts, w = penWidth(m, p.reduce((s, q) => s + (q[2] || 0.5), 0) / p.length);
    if (p.length === 1) return el('circle', { cx: f1(p[0][0]), cy: f1(p[0][1] + dy), r: f1(Math.max(1, w / 2)), class: cls || '', 'data-id': m.id || '' }, parent);
    const d = 'M' + p.map((q) => `${f1(q[0])} ${f1(q[1] + dy)}`).join(' L');
    return el('path', { d, 'stroke-width': f1(w), class: cls || '', 'data-id': m.id || '' }, parent);
  }

  // 卡片上的红字：叠在内容上面的一层 SVG，和内容一起缩放、一起滑
  function drawCardInk() {
    const layer = $('#acInk'), a = cardItem();
    layer.textContent = '';
    if (!a) return;
    const blocks = cardBlocks();
    for (const m of marksOf(a)) {
      if (m.erasedAt) continue;
      const b = blocks.get(m.blk) || blocks.get('a');
      drawMarkPath(layer, m, b ? b.y : 0);
    }
    drawCardLive();
  }
  function drawCardLive() { // 正在写的那一笔（坐标已经是卡片内容里的）
    const layer = $('#acInk'), old = layer.querySelector('.live');
    if (old) old.remove();
    if (S.cardInk) drawMarkPath(layer, S.cardInk, 0, 'live');
  }

  // 排版快照：每一块的位置和高度，块里每一行字（相对这一块）的位置、文字、字号，公式的位置和 TeX 源码。
  // 服务端排不出和平板一样的换行，画卡片的图给 Claude 时照这个画（整本一起交时服务端自己取页面数据，也靠它）
  function captureSheet() {
    const pg = $('#acPage'), k = (S.card && S.card.k) || 1, r0 = pg.getBoundingClientRect(), blocks = [];
    for (const [id, b] of cardBlocks()) blocks.push({ id, y: r1(b.y), h: r1(b.h), rows: sheetRows(b.el, r0, k, b.y) });
    return { w: CARD_W, h: r1(pg.offsetHeight), t: Date.now(), blocks };
  }
  function sheetRows(blockEl, r0, k, by) {
    const rows = [], X = (v) => r1((v - r0.left) / k), Y = (v) => r1((v - r0.top) / k - by);
    for (const t of blockEl.querySelectorAll('.ac-tex')) {
      const r = t.getBoundingClientRect();
      rows.push({ x: X(r.left), y: Y(r.top), w: r1(r.width / k), h: r1(r.height / k), tex: t.dataset.tex || '' });
    }
    // 文字：一个字一个字量，换了一行（顶边差出半个字高）就另起一行；「问：」「红字：」和后面的字在同一行
    const walk = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT), rg = document.createRange();
    let row = null;
    const push = () => {
      if (row && row.t.trim()) rows.push({ x: X(row.l), y: Y(row.top), w: r1((row.r - row.l) / k), h: r1((row.b - row.top) / k), fs: row.fs, t: row.t.trim(), k: row.kind });
      row = null;
    };
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const host = n.parentElement;
      if (!host || host.closest('.ac-tex')) continue;
      const fs = r1(parseFloat(getComputedStyle(host).fontSize) || 20);
      const kind = host.closest('.ac-q') ? 'q' : host.closest('.ac-mq') ? 'mq' : host.closest('.ac-older') ? 'old' : '';
      const s = n.nodeValue;
      for (let i = 0; i < s.length;) {
        const len = s.codePointAt(i) > 0xffff ? 2 : 1, ch = s.slice(i, i + len);
        rg.setStart(n, i);
        rg.setEnd(n, i + len);
        i += len;
        const r = rg.getBoundingClientRect();
        if (!r.width) { if (row) row.t += ch; continue; } // 行尾折行处的空格之类：只记字
        if (!row || row.kind !== kind || Math.abs(r.top - row.top) > (r.bottom - r.top) * 0.5) {
          push();
          row = { l: r.left, r: r.right, top: r.top, b: r.bottom, t: '', fs, kind };
        }
        row.t += ch;
        row.l = Math.min(row.l, r.left);
        row.r = Math.max(row.r, r.right);
        row.b = Math.max(row.b, r.bottom);
      }
    }
    push();
    return rows;
  }

  // 红字改过了：记下这时的排版快照。手写体、公式的字还在载入时等载入好再量（不然换行不一样）
  function saveSheet(a) {
    const take = () => {
      if (!S.card || S.card.id !== a.id || $('#answerCard').hidden) return false;
      layoutCard();
      a.sheet = captureSheet();
      return true;
    };
    if (document.fonts && document.fonts.status !== 'loaded') {
      document.fonts.ready.then(() => { if (take()) { drawCardInk(); markDirty(); } });
      return;
    }
    take();
  }

  // 卡片上写完一笔红字：归到它中间那一高度所在的那一块（落在块和块之间就归最近的那块），坐标换成相对那一块的
  function finishCardInk() {
    const st = S.cardInk;
    S.cardInk = null;
    const a = cardItem();
    if (!st || !a) { drawCardLive(); return; }
    const ys = st.pts.map((p) => p[1]), cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    let blk = 'a', top = 0, best = Infinity;
    for (const [id, b] of cardBlocks()) {
      const d = cy < b.y ? b.y - cy : cy > b.y + b.h ? cy - b.y - b.h : 0;
      if (d < best) { best = d; blk = id; top = b.y; }
    }
    const mark = { id: st.id, blk, pts: st.pts.map((p) => [p[0], r1(p[1] - top), p[2], p[3]]), t0: st.t0, w: st.w, c: 'r' };
    a.marks = (Array.isArray(a.marks) ? a.marks : []).concat([mark]);
    S.undo.push({ t: 'cmark', a: a.id, id: mark.id });
    cardInkChanged(a);
  }

  // 橡皮在卡片上：擦掉碰到的红字（一笔整笔擦），撤销能找回
  function eraseCardAt(x, y) {
    const a = cardItem(), er = S.cardErase;
    if (!a || !er) return;
    const r = 14 / ((S.card && S.card.k) || 1), blocks = cardBlocks(), now = Date.now();
    let hit = false;
    for (const m of marksOf(a)) {
      if (m.erasedAt) continue;
      const b = blocks.get(m.blk) || blocks.get('a'), dy = b ? b.y : 0;
      if (strokeDist({ pts: m.pts.map((p) => [p[0], p[1] + dy]) }, x, y) <= r) { m.erasedAt = now; er.ids.push(m.id); hit = true; }
    }
    if (hit) drawCardInk();
  }
  function finishCardErase() {
    const er = S.cardErase;
    S.cardErase = null;
    const a = cardItem();
    if (!er || !a || !er.ids.length) return;
    S.undo.push({ t: 'cerase', a: a.id, ids: er.ids });
    cardInkChanged(a);
  }

  function cardInkChanged(a) {
    saveSheet(a);
    markDirty();
    drawCardInk();
    redrawBadge(a); // 圈号上的红点
    if (S.card && S.card.stale) refreshCard(); // 写的时候 Claude 的回应到了：写完再排
  }

  // 只重画这一个圈号（红点、实心空心、跳两下）：不动别的蓝字（它们可能正在一个字一个字写出来）
  function redrawBadge(a) {
    const old = aiRoot.querySelector(`g.ai-write[data-id="${CSS.escape(String(a.id))}"]`);
    if (old) old.remove();
    if (S.aiVisible && isBadge(a) && !a.erasedAt) drawBadge(a, aiRoot, 'ai-item ai-write');
  }

  // 卡片的位置：紧挨圈号，默认在右下方；放不下就翻到左边、上边，始终整个在屏幕里
  function placeCard(a) {
    const card = $('#answerCard');
    measureStage();
    const v = S.view, s = v.s, cx = stageRect.left + v.tx + a.at[0] * s, cy = stageRect.top + v.ty + a.at[1] * s, r = BADGE_R * s;
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight, m = 8;
    const w = card.offsetWidth, h = card.offsetHeight;
    let left = cx + r + 6, top = cy - r * 0.4;
    if (left + w > vw - m) { // 右边放不下：翻到左边（右沿对着圈号），放在圈号那一行的下面，下面放不下就放上面——不盖住所答的那一行
      left = cx + r - w;
      top = cy + r + 6;
      if (top + h > vh - m) top = cy - r - 6 - h;
    } else if (top + h > vh - m) top = cy + r * 0.4 - h; // 下面放不下：翻到上边（还在圈号右边）
    Object.assign(card.style, { left: `${clamp(left, m, Math.max(m, vw - m - w))}px`, top: `${clamp(top, m, Math.max(m, vh - m - h))}px` });
  }

  // 把卡片里的某一块滑到卡片顶上（滑不到底的就停在最底下）
  function scrollCardTo(blk) {
    const b = cardBlocks().get(blk), card = $('#answerCard');
    if (b) card.scrollTop = Math.max(0, b.y * ((S.card && S.card.k) || 1) - 6);
  }

  // 打开一条长回答的卡片（一次只开一张），记为看过（存盘）。卡片是页面上的浮层，不是画在纸上的。
  // Claude 接着回了新的一段、还没看过：点开时滑到最新的那一段
  function openCard(a) {
    const card = $('#answerCard');
    closeCard();
    const segs = moreOf(a), jump = !a.seen && segs.length ? String(segs[segs.length - 1].id) : null;
    S.card = { id: a.id, k: 1 };
    renderCard(a);
    card.hidden = false;
    card.scrollTop = 0;
    layoutCard();
    placeCard(a);
    drawCardInk();
    if (jump) scrollCardTo(jump);
    if (!a.seen) { // 看过了：圈号变空心，存下来
      a.seen = true;
      markDirty();
      renderAI();
    }
    // 手写体、公式的字还在载入：载入好再排一次（宽度固定，只是换行、行高可能变），红字跟着
    if (document.fonts && document.fonts.status !== 'loaded') {
      document.fonts.ready.then(() => {
        if (!S.card || S.card.id !== a.id) return;
        layoutCard();
        placeCard(a);
        drawCardInk();
        if (jump) scrollCardTo(jump);
      });
    }
  }

  // 开着的卡片内容变了（Claude 接着回了一段）：重排，滑到的位置不动
  function refreshCard() {
    const a = cardItem(), card = $('#answerCard');
    if (!a) return;
    S.card.stale = false;
    const top = card.scrollTop;
    renderCard(a);
    layoutCard();
    placeCard(a);
    card.scrollTop = top;
    drawCardInk();
  }

  // 收起卡片：点别处、落笔、挪动或缩放纸面、翻页、开抽屉时。卡片上正写着的一笔先收好
  function closeCard() {
    if (!S.card) return;
    if (S.cardInk) finishCardInk();
    if (S.cardErase) finishCardErase();
    S.cardDrag = null;
    S.cardShut = { id: S.card.id, t: performance.now() };
    S.card = null;
    $('#answerCard').hidden = true;
    $('#acInk').textContent = '';
  }

  // Claude 回应卡片上的红字（write 带 card）：接在那张卡片最下面成为一段，前面写着它回应的那句红字（q）；
  // 上面原来的回答和红字不动；这一轮交上去、还没被回应的红字记进这一段的 on。圈号重新变实心、跳两下。
  // 那张卡片不在了（擦掉了）：返回 null，照普通的长回答另标一个圈号，回应不丢
  function appendToCard(it, T) {
    const n = Number(it.card), text = String(it.text || '').trim();
    const a = S.page.ai.find((o) => isBadge(o) && o.id === it.cid) || S.page.ai.find((o) => isBadge(o) && o.n === n);
    if (!a || a.erasedAt || a.dismissed || !text) return null;
    const answered = new Set(moreOf(a).flatMap((m) => (Array.isArray(m.on) ? m.on : [])));
    const open = marksOf(a).filter((m) => m.req && !m.erasedAt && !answered.has(m.id));
    let on = open.filter((m) => m.req === T.req);
    if (!on.length) on = open; // 不是按投递回的（比如没带 submission）：交了还没被回应的都算
    const seg = { id: 'm' + uid(), t: Date.now(), req: T.req, text, on: on.map((m) => m.id) };
    if (it.q) seg.q = String(it.q);
    a.more = (Array.isArray(a.more) ? a.more : []).concat([seg]);
    a.seen = false;
    S.fresh.set(a.id, performance.now());
    markDirty();
    redrawBadge(a);
    if (S.card && S.card.id === a.id) {
      if (S.cardInk || S.cardErase) S.card.stale = true; // 正在卡片上写：写完再排
      else refreshCard();
    }
    return a;
  }

  // 卡片上的这些红字交给 Claude 了：cards 是 {长回答 id: [红字 id]}，req 是这一轮的投递编号。
  // 同一笔红字再交一次，记最近的那一轮（投递编号按时间排，只往后换）。返回改了几笔
  function markCardsSent(page, cards, req) {
    if (!page || !cards || typeof cards !== 'object' || !req) return 0;
    let n = 0;
    for (const a of page.ai) {
      const ids = cards[a.id];
      if (!Array.isArray(ids)) continue;
      for (const m of marksOf(a)) if (ids.includes(m.id) && (!m.req || String(req) > String(m.req))) { m.req = String(req); n++; }
    }
    return n;
  }

  // -- 卡片上的笔、橡皮、手指：红笔写在卡片上，黑笔收起卡片，橡皮擦卡片上的红字，手指上下滑（笔刚用过一秒内落下的不算）
  function cardDown(e) {
    if (!S.card) return;
    e.preventDefault();
    const card = $('#answerCard');
    if (e.pointerType === 'touch') {
      // 笔正在卡片上写、擦，或笔刚用过：多半是手掌、手环，不管它；已经有一根手指在滑：第二根不管
      if (S.cardInk || S.cardErase || S.cardDrag || penJustUsed()) return;
      S.cardDrag = { pid: e.pointerId, y: e.clientY, top: card.scrollTop };
      try { card.setPointerCapture(e.pointerId); } catch (err) { /* 有些浏览器不支持 */ }
      return;
    }
    if (e.pointerType === 'pen') S.penAt = performance.now();
    // 笔落下时还按着的手指（手掌、手环）：不再跟着它滑卡片、挪纸
    S.cardDrag = null;
    if (touches.size) { touches.clear(); gesture = null; if (!flowCheck()) redrawAll(); }
    if (S.cardInk) finishCardInk(); // 上一笔的抬笔没到：先收好
    if (S.cardErase) finishCardErase();
    const tool = isEraserButton(e) ? 'eraser' : S.tool;
    if (tool === 'pen') { closeCard(); return; } // 黑笔落在卡片里：卡片收起，这一笔不留（用户：蓝字上肯定是红笔而不是黑笔）
    if (!cardItem()) return;
    try { card.setPointerCapture(e.pointerId); } catch (err) { /* 有些浏览器不支持 */ }
    const [x, y] = cardPoint(e);
    if (tool === 'red') {
      S.cardInk = { id: uid(), t0: Date.now(), w: PEN_W, c: 'r', pts: [[r1(x), r1(y), Math.round(pressureOf(e) * 100) / 100, 0]], _pid: e.pointerId, _ts0: e.timeStamp };
      drawCardLive();
    } else if (tool === 'eraser') {
      S.cardErase = { pid: e.pointerId, ids: [] };
      eraseCardAt(x, y);
    }
  }
  function cardMove(e) {
    const d = S.cardDrag, card = $('#answerCard');
    if (d && e.pointerId === d.pid) { card.scrollTop = d.top - (e.clientY - d.y); return; }
    const st = S.cardInk;
    if (st && e.pointerId === st._pid) {
      const evs = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
      for (const ev of evs.length ? evs : [e]) {
        const [x, y] = cardPoint(ev), p = st.pts, last = p[p.length - 1];
        if (Math.hypot(x - last[0], y - last[1]) < 0.35) continue;
        p.push([r1(x), r1(y), Math.round(((pressureOf(ev) + last[2]) / 2) * 100) / 100, Math.max(last[3], Math.round(ev.timeStamp - st._ts0))]);
      }
      drawCardLive();
      return;
    }
    if (S.cardErase && e.pointerId === S.cardErase.pid) { const [x, y] = cardPoint(e); eraseCardAt(x, y); }
  }
  function cardUp(e) {
    if (S.cardDrag && e.pointerId === S.cardDrag.pid) { S.cardDrag = null; return; }
    if (e.pointerType === 'pen') S.penAt = performance.now();
    if (S.cardInk && e.pointerId === S.cardInk._pid) { finishCardInk(); return; }
    if (S.cardErase && e.pointerId === S.cardErase.pid) finishCardErase();
  }

  function buildItem(it, T) {
    const id = uid(), rnd = rng(id);
    const base = { id, req: T.req, type: it.type, t: Date.now(), level: T.level };
    const on = refIds(it, 'anchor', T);
    if (on) base.on = on;
    if (it.type === 'note' || it.type === 'question' || it.type === 'suggest') {
      ensureMargin();
      const box = resolveRef(it, 'anchor', T);
      const lines = wrapText(it.text, NOTE_W, NOTE_FS);
      const h = lines.length * NOTE_LH + 8;
      const ay = (box[1] + box[3]) / 2;
      const y = findFreeY(clamp(ay - NOTE_LH * 0.7, S.Y0 + 6, S.pageH - h - 6), h);
      const nx = noteX();
      const lay = { x: nx, y, w: NOTE_W, h, lines, fs: NOTE_FS, lh: NOTE_LH };
      const paths = [];
      if (box[0] < S.W - 4) {
        const sx = nx - 8, sy = y + NOTE_LH * 0.55;
        const px = clamp(sx, box[0], box[2]), py = clamp(sy, box[1], box[3]);
        paths.push({ d: sketchLine(px + 6, py, sx, sy, rnd, 10), cls: 'leader', w: 1.3 });
      }
      if (it.type === 'suggest') { // 修改建议：要改的那块框上虚线框；记下它是不是书页上的字
        const b = [box[0] - 6, box[1] - 6, box[2] + 6, box[3] + 6].map(f1);
        paths.push({ d: `M${b[0]} ${b[1]} L${b[2]} ${b[1]} L${b[2]} ${b[3]} L${b[0]} ${b[3]} L${b[0]} ${b[1]}`, cls: 'sbox', w: 1.6 });
        // 推送页（「Claude 推送」那本）的底图铺满整页：指着我手写的字（anchor 是笔迹编号）的建议不算在文档上（阶段 C 修的小毛病）
        const onMyInk = Boolean(S.nb && S.nb.kind === 'board' && base.on);
        if (S.bgImg && !onMyInk && centerIn(box, [0, 0, W, S.baseH])) base.onDoc = true;
        else { base.type = 'note'; paths.pop(); } // 写在我自己的字上：我自己改，画成页边批注，不出采纳 / 不采纳
      }
      return Object.assign(base, { text: it.text, box, lay, paths, hit: [nx - 6, y - 4, nx + NOTE_W, y + h + 4] });
    }
    if (it.type === 'write') { // 长回答：纸上只标一个圈号
      if (!String(it.text || '').trim()) return null;
      if (!base.on) { const reds = redIdsInSel(T); if (reds) base.on = reds; } // 没指着笔迹：交上来的红笔问题算它回答了（照旧）
      return buildAnswer(it, T, base);
    }
    if (MARK_TYPES.has(it.type)) return buildMark(it, resolveRef(it, 'anchor', T), base, rnd);

    if (MAP_TYPES.has(it.type)) return buildMap(it, T, base, rnd);
    if (it.type === 'sketch') return buildSketch(it, T, base, rnd);
    if (it.type === 'formula') return buildFormula(it, T, base);
    if (it.type === 'figure') return buildFigure(it, T, base);
    if (it.type === 'underline') {
      const b = resolveRef(it, 'anchor', T), y = b[3] + 6;
      const d = sketchLine(b[0] - 4, y, b[2] + 4, y + (rnd() - 0.5) * 4, rnd, 5) + ' ' +
        sketchLine(b[0] + 2, y + 3, b[2] + 1, y + 2 + (rnd() - 0.5) * 3, rnd, 5);
      return Object.assign(base, { box: b, paths: [{ d, w: 2.2 }], hit: [b[0] - 8, b[3] - 4, b[2] + 8, b[3] + 18] });
    }
    if (it.type === 'circle') {
      const b = resolveRef(it, 'anchor', T);
      const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2, rx = (b[2] - b[0]) / 2 + 14, ry = (b[3] - b[1]) / 2 + 11;
      return Object.assign(base, { box: b, paths: [{ d: sketchEllipse(cx, cy, rx, ry, rnd), w: 2.2 }],
        hit: [cx - rx - 6, cy - ry - 6, cx + rx + 6, cy + ry + 6] });
    }
    if (it.type === 'arrow') {
      const a = resolveRef(it, 'from', T), b = resolveRef(it, 'to', T);
      const ar = arrowPaths(a, b, rnd);
      delete base.on;
      const to = refIds(it, 'to', T), from = refIds(it, 'from', T);
      if (to) base.on = to;
      if (from) base.on2 = from;
      const item = Object.assign(base, { box: b, paths: [{ d: ar.shaft, w: 2 }, { d: ar.head, w: 2 }],
        hit: [Math.min(ar.x1, ar.x2) - 10, Math.min(ar.y1, ar.y2) - 10, Math.max(ar.x1, ar.x2) + 10, Math.max(ar.y1, ar.y2) + 10] });
      if (it.text) {
        item.text = it.text;
        item.lay = { x: ar.lx, y: ar.ly - 18, w: 200, h: 24, lines: [it.text.slice(0, 16)], fs: 18, lh: 24 };
      }
      return item;
    }
    return null;
  }

  const BLOCK_TYPES = new Set(['sketch', 'formula', 'figure']); // 占一整块的：示意图、公式、图
  function contentBottom() {
    let b = 0;
    for (const st of inkStrokes()) if (!st.erasedAt) { const bb = strokeBox(st); if (bb[0] < S.W) b = Math.max(b, bb[3]); }
    for (const a of S.page.ai) if (isBadge(a) && !a.erasedAt) b = Math.max(b, badgeBox(a)[3]);
    for (const a of S.page.ai) if (BLOCK_TYPES.has(a.type) && a.hit && !a.dismissed) b = Math.max(b, a.hit[3]);
    return b || 20;
  }

  // 从 y 往下找一块不压着笔迹、圈号和其他整块的空白
  function freeBlockY(x, w, h, y) {
    const boxes = [];
    for (const st of inkStrokes()) if (!st.erasedAt) boxes.push(strokeBox(st));
    for (const a of S.page.ai) if (isBadge(a) && !a.erasedAt) boxes.push(badgeBox(a, 4));
    for (const a of S.page.ai) if (BLOCK_TYPES.has(a.type) && a.hit && !a.dismissed) boxes.push(a.hit);
    for (let guard = 0; guard < 300; guard++) {
      const hit = boxes.filter((b) => b[0] < x + w && b[2] > x && b[1] < y + h && b[3] > y);
      if (!hit.length) return y;
      y = Math.max.apply(null, hit.map((b) => b[3])) + 20;
    }
    return y;
  }

  function findFreeY(y, h) {
    const occ = S.page.ai.filter((a) => a.lay && a.type !== 'arrow' && a.type !== 'write').map((a) => [a.lay.y, a.lay.y + a.lay.h]);
    const free = (yy) => yy >= S.Y0 + 4 && yy + h <= S.pageH - 4 && occ.every((o) => yy + h + 6 <= o[0] || yy >= o[1] + 6);
    if (free(y)) return y;
    const cands = [];
    for (const o of occ) cands.push(o[1] + 6, o[0] - h - 6);
    const ok = cands.filter(free).sort((p, q) => Math.abs(p - y) - Math.abs(q - y));
    return ok.length ? ok[0] : y;
  }

  // ------------------------------------------------------------ AI 层（SVG）

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function renderAI() {
    S.renderGen++;
    S.aiQueue = Promise.resolve();
    while (aiRoot.firstChild) aiRoot.removeChild(aiRoot.firstChild);
    texLayer.textContent = '';
    if (!S.page) return;
    if (S.aiVisible) {
      const live = liveIds();
      for (const it of S.page.ai) {
        if (it.erasedAt || gone(it, live)) continue; // 擦掉的不画
        drawItem(it, false);
      }
    }
    markConfirmOnPage();
    markChanges();
    drawNeighborBadges();
  }

  function drawItem(it, animate) {
    if (it.type === 'write') { // 长回答：纸上只有圈号（没有圈号位置的旧样子不画）
      if (isBadge(it)) drawBadge(it, aiRoot, 'ai-item ai-write');
      return Promise.resolve();
    }
    const vcls = VOTE_TYPES.has(it.type) ? ' v-' + (it.verdict || 'none') + (it.sent ? ' sent' : '') : '';
    const g = el('g', { class: 'ai-item ai-' + it.type + (it.dismissed ? ' dismissed' : '') + vcls + (it.adopted ? ' adopted' : ''),
      'data-id': it.id }, aiRoot);
    if (it.fig && it.img) { // Claude 放上来的图
      const f = it.fig;
      el('image', { href: figUrl(it.img), x: f.x, y: f.y, width: f.w, height: f.h, preserveAspectRatio: 'xMidYMid meet', class: 'fig' }, g);
      figImage(it.img);
    }
    const paths = (it.paths || []).map((p) => el('path', { d: p.d, class: p.cls || '', 'stroke-width': p.w || 2.2 }, g));
    const texts = [];
    if (it.type === 'formula' && it.lay) texAt(it.lay.x, it.lay.y, it.lay.h, it.tex || it.text, FORMULA_FS, it.dismissed);
    else if (it.lay) {
      it.lay.lines.forEach((line, i) => {
        const t = el('text', { x: f1(it.lay.x), y: f1(it.lay.y + it.lay.fs + i * it.lay.lh), 'font-size': it.lay.fs, rotate: jitter(line, it.id + i) }, g);
        t.textContent = animate ? '' : line;
        texts.push([t, line]);
      });
    }
    for (const lb of it.labels || []) { // 示意图里的字
      const t = el('text', { x: f1(lb.x), y: f1(lb.y + lb.fs), 'font-size': lb.fs, rotate: jitter(lb.text, it.id + lb.x) }, g);
      t.textContent = animate ? '' : lb.text;
      texts.push([t, lb.text]);
    }
    if (it.adopted) { // 采纳的：右上角一颗星
      const h = it.hit || it.box;
      if (h) el('text', { x: f1(h[2] + 4), y: f1(h[1] + 16), 'font-size': 18, class: 'adopt-star' }, g).textContent = '★';
    }
    if (VOTE_TYPES.has(it.type) && it.box) {
      const b = it.vbox || it.box;
      let x0 = b[2] + 10; // 状态那行字从哪儿写起
      if (!it.sent) { // ✓ × 两个钮：手指、笔点一下就定，再点一次取消
        for (const vb of verdictButtons(it)) {
          const bg = el('g', { class: 'vbtn ' + vb.v + (it.verdict === vb.v ? ' on' : '') }, g);
          el('circle', { cx: f1(vb.x), cy: f1(vb.y), r: vb.r }, bg);
          el('text', { x: f1(vb.x), y: f1(vb.y + vb.r * 0.45), 'font-size': f1(vb.r * 1.3), 'text-anchor': 'middle' }, bg).textContent = vb.v === 'yes' ? '✓' : '×';
          if (vb.y === (b[1] + b[3]) / 2) x0 = Math.max(x0, vb.x + vb.r + 8);
        }
      }
      const [txt0, cls] = voteStatus(it);
      // 这行状态是界面的话（不是 Claude 写的）：英文界面里跟着翻译（批注那一层平时不翻译）
      const txt = txt0 && window.InkLang ? window.InkLang.t(txt0) : txt0;
      if (txt) { // 定了、发出去以后：采纳 / 改着呢 / 已改 / 没改成 / 已撤回（还没定的有 ✓ × 钮，不再写怎么回应）
        const fs = 20;
        measure.font = `${fs}px ${FONT}`;
        const right = x0 + measure.measureText(txt).width <= S.TW - 8; // 右边放得下就写在右边，否则写在框上方
        const at = right ? { x: f1(x0), y: f1((b[1] + b[3]) / 2 + fs * 0.35), 'text-anchor': 'start' }
          : { x: f1(b[2]), y: f1(b[1] - 8 >= S.Y0 + fs ? b[1] - 8 : b[3] + fs + 4), 'text-anchor': 'end' };
        el('text', Object.assign(at, { 'font-size': fs, class: 'vstat ' + cls }), g).textContent = txt;
      }
    }
    if (!animate) return Promise.resolve();
    if (it.type === 'sketch') return (async () => { // 示意图：线多，先画线（一共约 1.6 秒），再写字
      const ms = clamp(1600 / Math.max(1, paths.length), 60, 420);
      for (const p of paths) await animPath(p, ms);
      for (const tl of texts) await typeText(tl[0], tl[1], 24);
    })();
    return (async () => {
      for (const p of paths) if (p.getAttribute('class') === 'leader') await animPath(p, 260);
      for (const tl of texts) await typeText(tl[0], tl[1], 32);
      for (const p of paths) if (p.getAttribute('class') !== 'leader') await animPath(p, 420);
    })();
  }

  function animPath(p, ms) {
    let L = 0;
    try { L = p.getTotalLength(); } catch (e) { return Promise.resolve(); }
    p.style.strokeDasharray = L;
    p.style.strokeDashoffset = L;
    return new Promise((res) => {
      const t0 = performance.now();
      const step = (now) => {
        const k = Math.min(1, (now - t0) / ms);
        p.style.strokeDashoffset = L * (1 - k);
        if (k < 1) requestAnimationFrame(step);
        else { p.style.strokeDasharray = ''; p.style.strokeDashoffset = ''; res(); }
      };
      requestAnimationFrame(step);
    });
  }

  function typeText(t, line, ms) {
    const chars = Array.from(line);
    return new Promise((res) => {
      let n = 0;
      const tick = () => {
        n++;
        t.textContent = chars.slice(0, n).join('');
        if (n < chars.length) setTimeout(tick, ms || 32);
        else res();
      };
      tick();
    });
  }

  // 用手指点一下 Claude 的东西：圈号打开长回答的卡片；建议旁的 ✓ × 钮；别的蓝字提示怎么用笔回应
  function tapAiItem(cx, cy) {
    if (!S.page || !S.aiVisible) return false;
    const [x, y] = toWorld(cx, cy), live = liveIds();
    if (tapVote(x, y)) return true; // 建议旁的 ✓ × 钮
    if (tapBadgeAt(cx, cy)) return true; // 圈号（连续阅读时相邻页上的也算）
    for (let i = S.page.ai.length - 1; i >= 0; i--) {
      const it = S.page.ai[i];
      if (it.erasedAt || VOTE_TYPES.has(it.type) || it.type === 'write') continue; // 擦掉的点不着；建议用 ✓ × 钮（或笔打勾、横划）回应，点框本身不动它
      const h = it.hit;
      if (!h || gone(it, live) || x < h[0] || x > h[2] || y < h[1] || y > h[3]) continue;
      toast('蓝字用笔回应：旁边画个星号采纳；不要的用橡皮擦', 2200);
      return true;
    }
    return false;
  }

  // -- 手绘风格的线、圈、箭头（按批注 id 生成固定的随机抖动）

  function rng(seed) {
    let s = 0;
    for (const ch of String(seed)) s = (s * 31 + ch.charCodeAt(0)) | 0;
    return () => { s = (Math.imul(s, 1103515245) + 12345) | 0; return ((s >>> 16) & 0x7fff) / 0x7fff; };
  }

  function sketchLine(x1, y1, x2, y2, r, amp, bow) {
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len;
    const off = (r() - 0.5) * amp * Math.min(1, len / 120) + (bow || 0);
    const t = 0.45 + r() * 0.1;
    const mx = x1 + dx * t + nx * off, my = y1 + dy * t + ny * off;
    const j = () => (r() - 0.5) * amp * 0.3;
    return `M${f1(x1 + j())} ${f1(y1 + j())} Q${f1(mx)} ${f1(my)} ${f1(x2 + j())} ${f1(y2 + j())}`;
  }

  function sketchEllipse(cx, cy, rx, ry, r) {
    const n = 26, start = r() * Math.PI * 2, sweep = Math.PI * 2 + 0.3 + r() * 0.35, pts = [];
    for (let i = 0; i <= n; i++) {
      const t = start + (sweep * i) / n, k = 1 + (r() - 0.5) * 0.07;
      pts.push([cx + Math.cos(t) * rx * k, cy + Math.sin(t) * ry * k]);
    }
    let d = `M${f1(pts[0][0])} ${f1(pts[0][1])}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      d += ` C${f1(p1[0] + (p2[0] - p0[0]) / 6)} ${f1(p1[1] + (p2[1] - p0[1]) / 6)} ` +
        `${f1(p2[0] - (p3[0] - p1[0]) / 6)} ${f1(p2[1] - (p3[1] - p1[1]) / 6)} ${f1(p2[0])} ${f1(p2[1])}`;
    }
    return d;
  }

  function edgePoint(box, tx, ty, pad) {
    const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
    const hw = (box[2] - box[0]) / 2 + pad, hh = (box[3] - box[1]) / 2 + pad;
    const dx = tx - cx, dy = ty - cy;
    const k = 1 / Math.max(Math.abs(dx) / hw || 0, Math.abs(dy) / hh || 0, 1e-6);
    return [cx + dx * Math.min(k, 1), cy + dy * Math.min(k, 1)];
  }

  function arrowPaths(a, b, r) {
    const ac = [(a[0] + a[2]) / 2, (a[1] + a[3]) / 2], bc = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
    const p1 = edgePoint(a, bc[0], bc[1], 8), p2 = edgePoint(b, ac[0], ac[1], 10);
    const dx = p2[0] - p1[0], dy = p2[1] - p1[1], len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len, bow = len * 0.12 * (r() < 0.5 ? 1 : -1);
    const cx = (p1[0] + p2[0]) / 2 + nx * bow, cy = (p1[1] + p2[1]) / 2 + ny * bow;
    const shaft = `M${f1(p1[0])} ${f1(p1[1])} Q${f1(cx)} ${f1(cy)} ${f1(p2[0])} ${f1(p2[1])}`;
    const ang = Math.atan2(p2[1] - cy, p2[0] - cx), hl = 15;
    const h1 = [p2[0] - hl * Math.cos(ang - 0.45), p2[1] - hl * Math.sin(ang - 0.45)];
    const h2 = [p2[0] - hl * Math.cos(ang + 0.45), p2[1] - hl * Math.sin(ang + 0.45)];
    const head = `M${f1(h1[0])} ${f1(h1[1])} L${f1(p2[0])} ${f1(p2[1])} L${f1(h2[0])} ${f1(h2[1])}`;
    const lx = (p1[0] + p2[0]) / 2 + nx * (bow / 2 + 14 * Math.sign(bow || 1)), ly = (p1[1] + p2[1]) / 2 + ny * (bow / 2 + 14 * Math.sign(bow || 1));
    return { shaft, head, x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1], lx, ly };
  }

  // 批改符号：画在那块（b）上，带的一句话写在旁边，右边放不下就写在那块下面
  const MARK_TYPES = new Set(['tick', 'cross', 'strike', 'insert', 'wavy', 'highlight', 'brace', 'number']);
  const MARK_FS = 20, MARK_LH = 26;
  function buildMark(it, b, base, r) {
    const paths = [], text = String(it.text || '').trim(), cy = (b[1] + b[3]) / 2;
    let sym = null, lay = null;
    const textWidth = (t, fs) => { measure.font = `${fs}px ${FONT}`; return Math.min(320, measure.measureText(t).width + 4); };
    const textAt = (x, y, maxW) => { // 从 (x, y) 往右写，按宽度折行；右边放不下就写在那块下面
      if (!text) return;
      let w = Math.min(maxW || 320, S.TW - x - 12), tx = x, ty = y;
      if (S.TW - x - 12 < Math.min(120, maxW || 320)) { tx = b[0]; ty = b[3] + 8; w = Math.min(maxW || 320, S.TW - tx - 12); }
      const lines = wrapText(text, w, MARK_FS);
      w = Math.min(w, Math.max(...lines.map((l) => textWidth(l, MARK_FS))));
      lay = { x: tx, y: ty, w, h: lines.length * MARK_LH + 4, lines, fs: MARK_FS, lh: MARK_LH };
    };
    if (it.type === 'tick') { // 对 ✓
      const y = cy + 4, x = clearX(b[2] + 10, y - 20, y + 8, 32);
      paths.push({ d: sketchLine(x, y - 6, x + 9, y + 6, r, 2) + ' ' + sketchLine(x + 9, y + 6, x + 27, y - 18, r, 3), w: 2.6 });
      sym = [x - 2, y - 20, x + 30, y + 8];
      textAt(x + 36, y - 18);
    } else if (it.type === 'cross') { // 错 ✗，旁边一句为什么
      const s = 11, x = clearX(b[2] + 10, cy - s - 2, cy + s + 2, 2 * s + 4);
      paths.push({ d: sketchLine(x, cy - s, x + 2 * s, cy + s, r, 2) + ' ' + sketchLine(x + 2 * s, cy - s, x, cy + s, r, 2), w: 2.6 });
      sym = [x - 2, cy - s - 2, x + 2 * s + 2, cy + s + 2];
      textAt(x + 2 * s + 10, cy - 14);
    } else if (it.type === 'strike') { // 删除线；text 是改成什么，写在上方
      paths.push({ d: sketchLine(b[0] - 4, cy, b[2] + 4, cy + (r() - 0.5) * 3, r, 3), w: 2.4 });
      sym = [b[0] - 4, cy - 4, b[2] + 4, cy + 4];
      if (text) {
        const w = textWidth(text, MARK_FS);
        textAt(Math.max(S.X0 + 4, (b[0] + b[2]) / 2 - w / 2), b[1] - MARK_LH - 6, w);
      }
    } else if (it.type === 'insert') { // 插入符 ^，补的字写在上方
      const x = it.box ? (b[0] + b[2]) / 2 : b[2] + 6, y = b[3] + 2;
      paths.push({ d: sketchLine(x - 8, y + 13, x, y, r, 1) + ' ' + sketchLine(x, y, x + 8, y + 13, r, 1), w: 2.4 });
      sym = [x - 10, y - 2, x + 10, y + 15];
      const w = textWidth(text, MARK_FS);
      textAt(Math.max(S.X0 + 4, x - w / 2), b[1] - MARK_LH - 6, w);
    } else if (it.type === 'wavy') { // 波浪线：存疑
      const y = b[3] + 6, n = Math.max(2, Math.round((b[2] - b[0]) / 12)), step = (b[2] - b[0]) / n;
      let d = `M${f1(b[0])} ${f1(y)}`;
      for (let i = 0; i < n; i++) d += ` Q${f1(b[0] + step * (i + 0.5))} ${f1(y + (i % 2 ? 4 : -4) + (r() - 0.5))} ${f1(b[0] + step * (i + 1))} ${f1(y)}`;
      paths.push({ d, w: 2.2 });
      sym = [b[0], y - 6, b[2], y + 6];
      textAt(b[2] + 12, b[3] - 20);
    } else if (it.type === 'highlight') { // 荧光笔：黄色半透明底，至少一行高
      const ey = Math.max(0, 22 - (b[3] - b[1])) / 2;
      const p = [b[0] - 3, b[1] - 2 - ey, b[2] + 3, b[3] + 2 + ey].map(f1);
      paths.push({ d: `M${p[0]} ${p[1]} L${p[2]} ${p[1]} L${p[2]} ${p[3]} L${p[0]} ${p[3]} L${p[0]} ${p[1]}`, cls: 'hl' });
    } else if (it.type === 'brace') { // 大括号把这几行括起来，旁边一句话
      const w = 9, y0 = b[1], y1 = b[3], ym = cy, x = clearX(b[2] + 10, y0, y1, 2 * w + 2);
      paths.push({ d: `M${f1(x)} ${f1(y0)} Q${f1(x + w)} ${f1(y0)} ${f1(x + w)} ${f1(y0 + 10)} L${f1(x + w)} ${f1(ym - 8)} `
        + `Q${f1(x + w)} ${f1(ym)} ${f1(x + 2 * w)} ${f1(ym)} Q${f1(x + w)} ${f1(ym)} ${f1(x + w)} ${f1(ym + 8)} `
        + `L${f1(x + w)} ${f1(y1 - 10)} Q${f1(x + w)} ${f1(y1)} ${f1(x)} ${f1(y1)}`, w: 2.2 });
      sym = [x, y0, x + 2 * w + 2, y1];
      textAt(x + 2 * w + 8, ym - 14);
    } else if (it.type === 'number') { // 圈着的编号，放在那块左边
      const cx = Math.max(S.X0 + 16, b[0] - 22), w = textWidth(text, 18);
      paths.push({ d: sketchEllipse(cx, cy, Math.max(13, w / 2 + 6), 13, r), w: 1.8 });
      sym = [cx - 16, cy - 15, cx + 16, cy + 15];
      lay = { x: cx - w / 2 + 2, y: cy - 13, w, h: 24, lines: [text], fs: 18, lh: 24 };
    }
    if (lay && it.type !== 'number') freeSpot(lay, sym, it.type === 'strike' || it.type === 'insert');
    let hit = b.slice();
    if (sym) hit = unionBox(hit, sym);
    if (lay) hit = unionBox(hit, [lay.x, lay.y, lay.x + lay.w, lay.y + lay.h]);
    return Object.assign(base, { text: text || undefined, box: b, paths, lay, hit, sym: sym && sym.map(n1) });
  }

  // 概念图上的互动：label 给我的箭头补关系词；node、link、group 是建议（虚线，我点 ✓/×）
  const MAP_TYPES = new Set(['label', 'node', 'link', 'group']);
  const NODE_FS = 22;
  function groupOf(ref, T) { // 组号 → 那组的外框和笔迹 id
    let k = String(ref || '').trim().toLowerCase();
    if (/^\d+$/.test(k)) k = 'g' + k;
    const g = T.groups.get(k);
    if (!g) return null;
    const have = new Set(S.page.strokes.map((s) => s.id));
    return { box: g.bbox.slice(), ids: (g.ids || []).filter((x) => have.has(x)) };
  }
  function buildMap(it, T, base, r) {
    const text = String(it.text || '').trim(), tw = (t, fs) => { measure.font = `${fs}px ${FONT}`; return measure.measureText(t).width + 4; };
    if (it.type === 'label') { // 关系词：写在那条箭头中点的一侧（垂直于箭头，偏上）
      const b = resolveRef(it, 'anchor', T), g = it.anchor ? groupOf(it.anchor, T) : null;
      let d = [1, 0];
      if (g && g.ids.length) { // 箭头的方向：组里最长的那一笔，首尾两点
        const ss = S.page.strokes.filter((s) => g.ids.includes(s.id) && s.pts.length > 1);
        const len = (s) => Math.hypot(s.pts[s.pts.length - 1][0] - s.pts[0][0], s.pts[s.pts.length - 1][1] - s.pts[0][1]);
        const s = ss.sort((p, q) => len(q) - len(p))[0];
        if (s && len(s) > 8) d = [(s.pts[s.pts.length - 1][0] - s.pts[0][0]) / len(s), (s.pts[s.pts.length - 1][1] - s.pts[0][1]) / len(s)];
      }
      let n = [-d[1], d[0]];
      if (n[1] > 0 || (n[1] === 0 && n[0] > 0)) n = [-n[0], -n[1]]; // 朝上（竖着的箭头朝左）
      const w = tw(text, MARK_FS), h = MARK_LH + 4, off = 10 + Math.abs(n[0]) * w / 2 + Math.abs(n[1]) * h / 2;
      const cx = (b[0] + b[2]) / 2 + n[0] * off, cy = (b[1] + b[3]) / 2 + n[1] * off;
      const lay = { x: clamp(cx - w / 2, S.X0 + 4, S.TW - w - 4), y: cy - h / 2, w, h, lines: [text], fs: MARK_FS, lh: MARK_LH };
      freeSpot(lay, null, n[1] < 0, g && new Set(g.ids));
      const ul = `M${f1(lay.x)} ${f1(lay.y + h + 1)} L${f1(lay.x + w)} ${f1(lay.y + h + 1)}`; // 建议：虚线，采纳了变实线
      const v = [lay.x - 4, lay.y - 4, lay.x + w + 4, lay.y + h + 4].map(n1);
      return Object.assign(base, { text, box: v, vbox: v, labelOf: b.map(n1), paths: [{ d: ul, cls: 'dash', w: 1.6 }], lay, hit: v.slice() });
    }
    if (it.type === 'node') { // 建议加的概念：虚线椭圆，放在 anchor 旁边的空处；links 用虚线连过去
      const w = Math.min(320, tw(text, NODE_FS)), rx = w / 2 + 20, ry = 24;
      const a = it.anchor || it.box ? resolveRef(it, 'anchor', T) : T.selBox.slice();
      const [cx, cy] = nodeSpot(a, rx, ry), e = [cx - rx, cy - ry, cx + rx, cy + ry].map(n1);
      const paths = [{ d: sketchEllipse(cx, cy, rx, ry, r), cls: 'dash', w: 2 }];
      for (const ref of it.links || []) {
        const g = groupOf(ref, T);
        if (g) paths.push({ d: arrowPaths(e, g.box, r).shaft, cls: 'dash', w: 1.8 });
      }
      const lay = { x: cx - w / 2 + 2, y: cy - 15, w, h: 30, lines: [text], fs: NODE_FS, lh: 28 };
      return Object.assign(base, { text, box: e, vbox: e, sym: e, paths, lay, hit: e.slice() });
    }
    if (it.type === 'link') { // 建议加的连线：from → to 的虚线箭头，关系词写在中点
      const a = resolveRef(it, 'from', T), b = resolveRef(it, 'to', T), ar = arrowPaths(a, b, r);
      delete base.on;
      const to = refIds(it, 'to', T), from = refIds(it, 'from', T);
      if (to) base.on = to;
      if (from) base.on2 = from;
      const paths = [{ d: ar.shaft, cls: 'dash', w: 2 }, { d: ar.head, w: 2 }];
      let lay = null, v = [ar.lx - 24, ar.ly - 18, ar.lx + 24, ar.ly + 18];
      if (text) { // 关系词放在弯线中点的外侧（arrowPaths 的 lx、ly 在中点外 14 处），按字的宽高再让开
        const w = tw(text, MARK_FS), h = MARK_LH + 4, mx = (ar.x1 + ar.x2) / 2, my = (ar.y1 + ar.y2) / 2;
        const L = Math.hypot(ar.lx - mx, ar.ly - my) || 1, u = [(ar.lx - mx) / L, (ar.ly - my) / L];
        const k = -14 + 8 + Math.abs(u[0]) * w / 2 + Math.abs(u[1]) * h / 2, cx = ar.lx + u[0] * k, cy = ar.ly + u[1] * k;
        lay = { x: cx - w / 2, y: cy - h / 2, w, h, lines: [text], fs: MARK_FS, lh: MARK_LH };
        v = [lay.x - 6, lay.y - 4, lay.x + w + 6, lay.y + h + 4];
      }
      v = v.map(n1);
      const hit = unionBox([Math.min(ar.x1, ar.x2) - 10, Math.min(ar.y1, ar.y2) - 10, Math.max(ar.x1, ar.x2) + 10, Math.max(ar.y1, ar.y2) + 10], v);
      return Object.assign(base, { text: text || undefined, box: v, vbox: v, paths, lay, hit });
    }
    if (it.type === 'group') { // 建议的分组：几组外面一个虚线圆角框，类名写在框上方
      const gs = (it.anchors || []).map((x) => groupOf(x, T)).filter(Boolean);
      if (!gs.length) return null;
      const u = gs.map((g) => g.box).reduce(unionBox), R = [u[0] - 16, u[1] - 16, u[2] + 16, u[3] + 16].map(n1), k = 14;
      const j = () => (r() - 0.5) * 2;
      const d = `M${f1(R[0] + k)} ${f1(R[1] + j())} L${f1(R[2] - k)} ${f1(R[1] + j())} Q${R[2]} ${R[1]} ${f1(R[2] + j())} ${f1(R[1] + k)} `
        + `L${f1(R[2] + j())} ${f1(R[3] - k)} Q${R[2]} ${R[3]} ${f1(R[2] - k)} ${f1(R[3] + j())} L${f1(R[0] + k)} ${f1(R[3] + j())} `
        + `Q${R[0]} ${R[3]} ${f1(R[0] + j())} ${f1(R[3] - k)} L${f1(R[0] + j())} ${f1(R[1] + k)} Q${R[0]} ${R[1]} ${f1(R[0] + k)} ${f1(R[1])}`;
      base.on = gs.flatMap((g) => g.ids);
      if (!base.on.length) delete base.on;
      let lay = null, hit = R.slice();
      if (text) {
        const w = Math.min(320, tw(text, MARK_FS));
        lay = { x: R[0] + 8, y: R[1] - MARK_LH - 8, w, h: MARK_LH + 4, lines: [text], fs: MARK_FS, lh: MARK_LH };
        freeSpot(lay, null, true);
        hit = unionBox(hit, [lay.x, lay.y, lay.x + w, lay.y + lay.h]);
      }
      return Object.assign(base, { text: text || undefined, box: R, vbox: R, paths: [{ d, cls: 'dash', w: 2 }], lay, hit });
    }
    return null;
  }

  // 示意图、公式放哪：居中；anchor/box 那块下面，否则接在页面内容后面；找不压着笔迹、圈号的空处
  function blockSpot(it, T, w, h) {
    const x = 48 + Math.max(0, (S.W - 96 - w) / 2);
    let y;
    if (it.box || (it.anchor && it.anchor !== 'end')) y = resolveRef(it, 'anchor', T)[3] + 30;
    else if (S.bgImg) y = Math.max(contentBottom(), S.baseH) + 40;
    else y = contentBottom() + 44;
    y = freeBlockY(x, w, h, y);
    maybeExtend(y + h + 60);
    keepHeight(y + h + 60);
    return [x, y];
  }

  // 公式：KaTeX 排好放在批注层上面那层 HTML（#tex，和批注层一起缩放）；发给 Claude 的图、服务端的图、PDF 里是 LaTeX 源码（lay 的那一行）
  const FORMULA_FS = 26;
  function texHTML(tex) {
    try {
      if (window.katex) return window.katex.renderToString('\\displaystyle ' + tex, { throwOnError: false, output: 'html' });
    } catch (e) { /* 写错了的公式：显示源码 */ }
    const d = document.createElement('div');
    d.textContent = tex;
    return d.innerHTML;
  }
  const texSizes = new Map();
  function measureTex(tex, fs) { // 公式排出来多大（页面坐标）
    const key = fs + '|' + tex;
    if (texSizes.has(key)) return texSizes.get(key);
    const d = document.createElement('div');
    d.className = 'tx';
    d.style.cssText = `position:absolute;left:-9999px;top:0;visibility:hidden;font-size:${fs}px;white-space:nowrap`;
    d.innerHTML = texHTML(tex);
    document.body.appendChild(d);
    const r = { w: Math.ceil(d.offsetWidth) + 4, h: Math.ceil(d.offsetHeight) + 4 };
    d.remove();
    if (window.katex) texSizes.set(key, r);
    return r;
  }
  function texAt(x, y, h, tex, fs, faded) { // 从 (x, y) 起、高 h 的一块里排一个公式，竖直居中
    const d = document.createElement('div');
    d.className = 'tx' + (faded ? ' faded' : '');
    d.style.cssText = `left:${x}px;top:${y}px;height:${h}px;font-size:${fs}px`;
    d.innerHTML = texHTML(tex);
    texLayer.appendChild(d);
  }
  function buildFormula(it, T, base) {
    const tex = String(it.tex || it.text || ''), m = measureTex(tex, FORMULA_FS);
    const w = Math.min(m.w, S.W - 96), h = Math.max(m.h, 40), [x, y] = blockSpot(it, T, w, h);
    delete base.on;
    const lay = { x, y, w, h, lines: [tex], fs: 18, lh: h };
    const hit = [x - 8, y - 6, x + w + 8, y + h + 6].map(n1);
    return Object.assign(base, { tex, text: tex, box: hit, sym: hit, lay, paths: [], hit });
  }

  // 示意图、方框图：Claude 在自己的坐标（w × h，默认 600 × 300）里给出形状，按页宽缩放，手绘风格画出来；字放进 labels
  const SKETCH_FS = 20;
  function arrowHead(p, q, r) { // q 处的箭头：从 p 指向 q
    const ang = Math.atan2(q[1] - p[1], q[0] - p[0]), hl = 13 + r() * 3;
    const h1 = [q[0] - hl * Math.cos(ang - 0.45), q[1] - hl * Math.sin(ang - 0.45)];
    const h2 = [q[0] - hl * Math.cos(ang + 0.45), q[1] - hl * Math.sin(ang + 0.45)];
    return `M${f1(h1[0])} ${f1(h1[1])} L${f1(q[0])} ${f1(q[1])} L${f1(h2[0])} ${f1(h2[1])}`;
  }
  function smoothPath(pts, r) { // 过这些点的平滑曲线（Catmull-Rom 转三次贝塞尔），带一点抖
    const P = pts.map((p) => [p[0] + (r() - 0.5) * 1.5, p[1] + (r() - 0.5) * 1.5]);
    let d = `M${f1(P[0][0])} ${f1(P[0][1])}`;
    for (let i = 0; i < P.length - 1; i++) {
      const p0 = P[i - 1] || P[i], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2] || p2;
      d += ` C${f1(p1[0] + (p2[0] - p0[0]) / 6)} ${f1(p1[1] + (p2[1] - p0[1]) / 6)} ` +
        `${f1(p2[0] - (p3[0] - p1[0]) / 6)} ${f1(p2[1] - (p3[1] - p1[1]) / 6)} ${f1(p2[0])} ${f1(p2[1])}`;
    }
    return d;
  }
  function buildSketch(it, T, base, r) {
    const sw = it.w || 600, sh = it.h || 300, k = clamp(((S.W - 96) * 0.8) / sw, 0.3, 2);
    const W0 = sw * k, cap = it.text ? 36 : 0, H0 = sh * k + cap;
    const [x0, y0] = blockSpot(it, T, W0, H0);
    delete base.on; // 指着的字擦掉了，图照样留着
    const X = (x) => x0 + x * k, Y = (y) => y0 + y * k, paths = [], labels = [];
    const tw = (t, fs) => { measure.font = `${fs}px ${FONT}`; return measure.measureText(t).width + 2; };
    const fsOf = (s) => clamp((s.size || SKETCH_FS) * Math.sqrt(k), 14, 34);
    const label = (text, x, cy, fs, left) => { // left：从 x 往右写；否则以 x 为中心；cy 是这行字竖直的中间
      const w = tw(text, fs);
      labels.push({ x: n1(left ? x : x - w / 2), y: n1(cy - fs * 0.6), w: n1(w), text, fs: n1(fs) });
    };
    const seg = (pts, cls) => { // 折线：一段段手绘线
      let d = '';
      for (let i = 0; i < pts.length - 1; i++) d += (d ? ' ' : '') + sketchLine(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], r, 2.5);
      paths.push(Object.assign({ d, w: 2 }, cls ? { cls } : {}));
    };
    for (const s of it.shapes || []) {
      const dash = s.dash ? 'dash' : null;
      if (s.type === 'line' || s.type === 'curve') {
        const pts = s.pts.map((p) => [X(p[0]), Y(p[1])]), n = pts.length;
        if (s.type === 'line') seg(pts, dash);
        else paths.push(Object.assign({ d: smoothPath(pts, r), w: 2 }, dash ? { cls: dash } : {}));
        if (s.arrow === 'end' || s.arrow === 'both') paths.push({ d: arrowHead(pts[n - 2], pts[n - 1], r), w: 2 });
        if (s.arrow === 'start' || s.arrow === 'both') paths.push({ d: arrowHead(pts[1], pts[0], r), w: 2 });
        if (s.text) { // 写在中段旁边（上方）
          const i = Math.floor((n - 1) / 2), a = pts[i], b = pts[i + 1], fs = fsOf(s);
          label(s.text, (a[0] + b[0]) / 2, Math.min(a[1], b[1]) - fs * 0.8, fs);
        }
      } else if (s.type === 'rect') {
        const a = [X(s.x), Y(s.y), X(s.x + s.w), Y(s.y + s.h)], o = 3;
        seg([[a[0] - o, a[1]], [a[2] + o, a[1]]], dash);
        seg([[a[2], a[1] - o], [a[2], a[3] + o]], dash);
        seg([[a[2] + o, a[3]], [a[0] - o, a[3]]], dash);
        seg([[a[0], a[3] + o], [a[0], a[1] - o]], dash);
        if (s.text) label(s.text, (a[0] + a[2]) / 2, (a[1] + a[3]) / 2, fsOf(s));
      } else if (s.type === 'ellipse') {
        paths.push(Object.assign({ d: sketchEllipse(X(s.cx), Y(s.cy), s.rx * k, s.ry * k, r), w: 2 }, dash ? { cls: dash } : {}));
        if (s.text) label(s.text, X(s.cx), Y(s.cy), fsOf(s));
      } else if (s.type === 'text') {
        label(s.text, X(s.x), Y(s.y), fsOf(s), true);
      } else if (s.type === 'axes') { // 坐标轴：左下角为原点，带箭头
        const o = [X(s.x), Y(s.y + s.h)], xe = [X(s.x + s.w), o[1]], ye = [o[0], Y(s.y)], fs = fsOf(s);
        seg([o, xe]);
        paths.push({ d: arrowHead(o, xe, r), w: 2 });
        seg([o, ye]);
        paths.push({ d: arrowHead(o, ye, r), w: 2 });
        if (s.xlabel) label(s.xlabel, xe[0] + 8, xe[1], fs, true); // 横轴名写在箭头右边，不和图注挤在一起
        if (s.ylabel) label(s.ylabel, ye[0] + 12, ye[1] + fs * 0.3, fs, true);
      }
    }
    if (it.text) label(it.text, x0 + W0 / 2, y0 + sh * k + cap / 2 + 6, SKETCH_FS); // 图注
    const hit = [x0 - 8, y0 - 8, x0 + W0 + 8, y0 + H0 + 8].map(n1);
    return Object.assign(base, { text: it.text || undefined, box: hit, sym: hit, paths, labels, hit });
  }

  // Claude 在电脑上生成的图（数据图、函数曲线）：放在 anchor 那块下面，按页宽缩放，最高 900；text 是图注
  function buildFigure(it, T, base) {
    const iw = it.iw || 800, ih = it.ih || 600, cap = it.text ? 36 : 0;
    let W0 = Math.min((S.W - 96) * 0.8, Math.max(240, iw / 1.5)), H0 = (W0 * ih) / iw;
    if (H0 > 900) { W0 *= 900 / H0; H0 = 900; }
    const [x0, y0] = blockSpot(it, T, W0, H0 + cap);
    delete base.on; // 指着的字擦掉了，图照样留着
    const labels = [];
    if (it.text) {
      measure.font = `${SKETCH_FS}px ${FONT}`;
      const w = measure.measureText(it.text).width + 2;
      labels.push({ x: n1(x0 + W0 / 2 - w / 2), y: n1(y0 + H0 + 8), w: n1(w), text: it.text, fs: SKETCH_FS });
    }
    const hit = [x0 - 8, y0 - 8, x0 + W0 + 8, y0 + H0 + cap + 8].map(n1);
    return Object.assign(base, { text: it.text || undefined, img: it.img, iw, ih, src: it.src,
      fig: { x: n1(x0), y: n1(y0), w: n1(W0), h: n1(H0) }, box: hit, sym: hit, paths: [], labels, hit });
  }

  // 图的地址（<image> 不能带请求头：访问凭据放在地址里）；画进发给 Claude 的图时用同一张，先载入好
  function figUrl(name) { return `/api/figure?f=${encodeURIComponent(name)}&${TOKEN ? 'd=' + encodeURIComponent(TOKEN) : 'k=' + encodeURIComponent(CODE)}`; }
  const FIGS = new Map();
  function figImage(name) {
    let im = FIGS.get(name);
    if (!im) { im = new Image(); im.src = figUrl(name); FIGS.set(name, im); }
    return im;
  }

  // 新概念放哪：anchor 的右、下、左、上，再远一点；不压着我的字和别的批注，不出页面
  function nodeSpot(a, rx, ry) {
    const obs = aiRects();
    for (const st of S.page.strokes) if (!st.erasedAt && st.pts.length) obs.push(strokeBox(st));
    const mx = (a[0] + a[2]) / 2, my = (a[1] + a[3]) / 2, cands = [];
    for (const gap of [50, 110, 180]) {
      cands.push([a[2] + gap + rx, my], [mx, a[3] + gap * 0.8 + ry], [a[0] - gap - rx, my], [mx, a[1] - gap * 0.8 - ry],
        [a[2] + gap + rx, a[3] + gap * 0.6 + ry], [a[0] - gap - rx, a[3] + gap * 0.6 + ry]);
    }
    const inPage = (c) => c[0] - rx >= S.X0 + 4 && c[0] + rx <= S.W - 4 && c[1] - ry >= S.Y0 + 4 && c[1] + ry <= S.pageH - 4;
    const free = (c) => obs.every((o) => c[0] + rx + 10 <= o[0] || c[0] - rx - 10 >= o[2] || c[1] + ry + 10 <= o[1] || c[1] - ry - 10 >= o[3]);
    return cands.find((c) => inPage(c) && free(c)) || cands.find(inPage) || [clamp(mx, S.X0 + rx + 4, S.W - rx - 4), a[3] + 50 + ry];
  }

  // 页面上已有的批注、符号占着的地方
  function aiRects() {
    const obs = [];
    for (const a of S.page.ai) {
      if (a.dismissed) continue;
      if (isBadge(a)) obs.push(badgeBox(a, 2)); // 长回答的圈号
      if (a.lay) obs.push([a.lay.x, a.lay.y, a.lay.x + a.lay.w, a.lay.y + a.lay.h]);
      if (a.sym) obs.push(a.sym);
    }
    return obs;
  }

  // 画在那块右边的符号（✓ ✗ 括号）：那里已有别的批注或符号就往右让开
  function clearX(x, y0, y1, w) {
    const obs = aiRects();
    for (let k = 0; k < 6; k++) {
      const o = obs.find((r) => x < r[2] && x + w > r[0] && y0 < r[3] && y1 > r[1]);
      if (!o) break;
      x = o[2] + 6;
    }
    return x;
  }

  // 符号旁边那句话别压着别的东西（已有的批注、别的符号、我的字）：先试原处，再往下、往上挪半行；都挪不开就放原处
  function freeSpot(L, mine, up, skip) { // up：写在上方的先往上挪；skip：不算这几笔
    const obs = aiRects();
    if (mine) obs.push(mine);
    for (const st of S.page.strokes) if (!st.erasedAt && st.pts.length && !(skip && skip.has(st.id))) obs.push(strokeBox(st));
    const clear = (y) => obs.every((o) => L.x + L.w <= o[0] || L.x >= o[2] || y + L.h <= o[1] || y >= o[3]);
    for (const dy of up ? [0, -13, -26, -39, 13, -52] : [0, 13, 26, 39, -13, 52, -26, 65, 78]) {
      if (clear(L.y + dy)) { L.y += dy; return; }
    }
  }

  function jitter(line, seed) {
    const r = rng(seed);
    return Array.from(line).map(() => ((r() - 0.5) * 5).toFixed(1)).join(' ');
  }

  function wrapText(text, maxW, fs) {
    const out = [];
    for (const para of String(text).split(/\r?\n/)) {
      if (!para.trim()) { if (out.length && out[out.length - 1] !== '') out.push(''); continue; }
      out.push.apply(out, wrapLine(para, maxW, fs));
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    return out.length ? out : [''];
  }

  function wrapLine(text, maxW, fs) {
    measure.font = `${fs}px ${FONT}`;
    const tokens = String(text).replace(/\s+/g, ' ').match(/[A-Za-z0-9.,'+\-*/^=_()[\]]+|\s|./gu) || [];
    const lines = [];
    let cur = '';
    for (const tk of tokens) {
      if (tk === ' ' && !cur) continue;
      const next = cur + tk;
      if (!cur || measure.measureText(next).width <= maxW) { cur = next; continue; }
      if (/^[，。、；：？！）》」』,.;:?!)]$/.test(tk)) { cur = next; continue; } // 标点不放行首
      lines.push(cur.trimEnd());
      cur = tk === ' ' ? '' : tk;
    }
    if (cur.trim()) lines.push(cur.trimEnd());
    return lines.length ? lines : [''];
  }

  // ------------------------------------------------------------ 回放书写过程

  function replay() {
    if (!S.page) return;
    const strokes = S.page.strokes.filter((s) => s.pts.length).slice().sort((a, b) => a.t0 - b.t0);
    if (!strokes.length) { toast('本页还没有笔迹'); return; }
    const SPEED = 2, CAP = 450, ev = [];
    for (const s of strokes) {
      ev.push({ t: s.t0, kind: 'draw', s });
      if (s.erasedAt) ev.push({ t: s.erasedAt, kind: 'erase', s });
    }
    ev.sort((a, b) => a.t - b.t);
    let v = 0, lastReal = ev[0].t;
    for (const e of ev) {
      v += Math.min(Math.max(0, e.t - lastReal) / SPEED, CAP);
      e.v = v;
      if (e.kind === 'draw') { v += (strokeT1(e.s) - e.s.t0) / SPEED; lastReal = strokeT1(e.s); } else lastReal = e.t;
    }
    S.replay = { ev, next: 0, active: [], shown: [], start: performance.now(), SPEED };
    closeCard();
    aiRoot.style.display = 'none';
    texLayer.style.display = 'none';
    drawInk();
    toast('回放中（2 倍速，长停顿已压缩），点一下页面停止', 2500);
    requestAnimationFrame(replayFrame);
  }

  function replayFrame(now) {
    const R = S.replay;
    if (!R) return;
    const t = now - R.start, ctx = cvInk.getContext('2d');
    setT(ctx);
    let redraw = false;
    while (R.next < R.ev.length && R.ev[R.next].v <= t) {
      const e = R.ev[R.next++];
      if (e.kind === 'draw') { const a = { s: e.s, v: e.v, done: 1 }; R.active.push(a); R.shown.push(a); } else {
        R.shown = R.shown.filter((a) => a.s !== e.s);
        R.active = R.active.filter((a) => a.s !== e.s);
        redraw = true;
      }
    }
    if (redraw) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cvInk.width, cvInk.height);
      setT(ctx);
      for (const a of R.shown) drawStroke(ctx, a.s, inkOf(a.s), 1, a.done);
    }
    for (const a of R.active) {
      const target = (t - a.v) * R.SPEED, p = a.s.pts;
      let n = a.done;
      while (n < p.length && p[n][3] <= target) n++;
      if (a.done === 1 && p.length === 1) drawStroke(ctx, a.s, inkOf(a.s));
      else if (n > a.done) drawStroke(ctx, a.s, inkOf(a.s), a.done, n);
      a.done = Math.max(a.done, n);
    }
    R.active = R.active.filter((a) => a.done < a.s.pts.length);
    if (R.next >= R.ev.length && !R.active.length) { setTimeout(stopReplay, 700); return; }
    requestAnimationFrame(replayFrame);
  }

  function stopReplay() {
    if (!S.replay) return;
    S.replay = null;
    aiRoot.style.display = '';
    texLayer.style.display = '';
    drawInk();
  }

  // ------------------------------------------------------------ 本子、页面、保存

  const pageKey = () => (S.nb ? S.nb.id + '#' + S.idx : '');

  function normalizePage(p) {
    p = p && typeof p === 'object' ? p : {};
    return {
      v: 1,
      strokes: Array.isArray(p.strokes) ? p.strokes.filter((s) => s && Array.isArray(s.pts)) : [],
      ai: Array.isArray(p.ai) ? p.ai : [],
      reads: Array.isArray(p.reads) ? p.reads : [],
      h: typeof p.h === 'number' ? p.h : 0,
      lastSent: typeof p.lastSent === 'number' ? p.lastSent : 0,
      xw: typeof p.xw === 'number' ? p.xw : 0,
      ox: typeof p.ox === 'number' ? p.ox : 0,
      oy: typeof p.oy === 'number' ? p.oy : 0,
      mg: p.mg === true,
      rot: [90, 180, 270].includes(p.rot) ? p.rot : 0,
      judged: Array.isArray(p.judged) ? p.judged : [], // 以前「文档更新后收起、挪动旧批注」留下的记录：页面不再用、不画、不发给 Claude，载入时留着、保存时原样写回（迁移脚本 tools/migrate_cards.py 也不动它；这两处不能删，删了平板一存这页就把它丢了）
      rev: typeof p.rev === 'number' ? p.rev : 0, // 服务端的版本号：存的时候带上，别处改过就不覆盖
    };
  }

  function serializePage() {
    return {
      v: 1,
      strokes: S.page.strokes.map((s) => {
        const o = { id: s.id, t0: s.t0, w: s.w, pts: s.pts };
        if (s.c) o.c = s.c;
        if (s.erasedAt) o.erasedAt = s.erasedAt;
        if (s.faded) o.faded = true;
        return o;
      }),
      ai: S.page.ai,
      reads: S.page.reads,
      h: S.page.h || undefined,
      lastSent: S.page.lastSent || undefined,
      xw: S.page.xw || undefined,
      ox: S.page.ox || undefined,
      oy: S.page.oy || undefined,
      mg: S.page.mg || undefined,
      rot: S.page.rot || undefined,
      judged: S.page.judged.length ? S.page.judged : undefined,
      rev: S.page.rev || 0,
    };
  }

  function markDirty() {
    S.dirty = true;
    updateStatus('未保存');
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(flushSave, 1200);
  }

  // 待保存的页面按「本子#页码」排队；保存失败的留在队里，翻页后也会继续重试
  const pendingSaves = new Map();

  // 这一页有改动：排进保存队列（同步，换页前调用）
  function queueSave() {
    if (S.dirty && S.page && S.nb) {
      pendingSaves.set(pageKey(), { nb: S.nb.id, i: S.idx, body: JSON.stringify(serializePage()), page: S.page });
      S.dirty = false;
    }
  }

  async function flushSave() {
    clearTimeout(S.saveTimer);
    queueSave();
    let failed = false;
    if (pendingSaves.size && !S.saveTryAt) S.saveTryAt = Date.now(); // 从这时起一直没存上（电脑睡了、网断了时请求会挂很久）：见 troubleText
    for (const [key, job] of Array.from(pendingSaves)) {
      try {
        const r = await api(`/api/page?nb=${encodeURIComponent(job.nb)}&i=${job.i}`, {
          method: 'PUT', body: job.body, headers: { 'Content-Type': 'application/json' }, keepalive: job.body.length < 60000,
        });
        try { const d = await r.json(); if (job.page && typeof d.rev === 'number') job.page.rev = d.rev; } catch (e) { /* 旧服务 */ }
        if (pendingSaves.get(key) === job) pendingSaves.delete(key);
      } catch (e) {
        if (e.status === 409) { // 这一页在别的设备上改过了：服务端已把这份另存，这边换成那边的版本
          if (pendingSaves.get(key) === job) pendingSaves.delete(key);
          onConflict(job, e.message);
        } else failed = true;
      }
    }
    if (failed) {
      updateStatus('保存失败，稍后重试');
      S.saveTimer = setTimeout(flushSave, 5000);
    } else {
      if (!pendingSaves.size) S.saveTryAt = 0;
      updateStatus(S.dirty ? '未保存' : '已保存');
    }
  }

  // 没有状态栏：只在出问题时在顶上写一句——连不上电脑，或有字一直没存上（没存上的只在这一页的内存里，刷新就没了）
  function troubleText() {
    if (!S.cfg) return ''; // 还没连上过：打开时的提示另有
    const unsaved = S.dirty || pendingSaves.size > 0;
    if (!S.online) return '连不上电脑' + (unsaved ? '：新写的字还没存上，先别刷新这一页' : '');
    const stuck = pendingSaves.size > 0 && S.saveTryAt && Date.now() - S.saveTryAt > 8000;
    return S.saveState === '保存失败，稍后重试' || stuck ? '新写的字还没存上，正在重试；先别刷新这一页' : '';
  }

  // 存的时候发现这一页在别的设备上改过了：相邻页的缓存丢掉，当前页重新载入那边的版本
  function onConflict(job, msg) {
    const i = job.i;
    if (S.nb && S.nb.id === job.nb) {
      const e = S.flowCache.get(i);
      if (e && e.url) URL.revokeObjectURL(e.url);
      S.flowCache.delete(i);
      if (S.undos) S.undos.delete(job.nb + '#' + i);
      if (S.idx === i && job.page === S.page) {
        S.dirty = false;
        S.undo = [];
        setTimeout(() => openPage(i), 0);
      }
    }
    toast(msg + '（已换成那边的版本）', 9000);
  }

  // 名字开头一长串相同的本子（如 …进展_202610_v47_…、…进展_202610_v48_…），列表里只显示不同的那段
  const SEP = /[_\-\s·.]/;
  function commonPrefix(a, b) {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  }
  function cutAtSep(t, n) {
    for (let i = n - 1; i >= 0; i--) if (SEP.test(t[i])) return i + 1;
    return 0;
  }
  function shortTitle(t, others) {
    const cut = sharedCut(t, others);
    return cut ? '…' + t.slice(cut) : t;
  }

  // 和别的本子名字开头一样的那一段有多长（同一系列的新旧版本）；没有就是 0
  function sharedCut(t, others) {
    let n = 0;
    for (const o of others) if (o !== t) n = Math.max(n, commonPrefix(t, o));
    const cut = n >= 8 ? cutAtSep(t, n) : 0;
    return cut >= 6 && t.length - cut >= 2 ? cut : 0;
  }

  // 本子名字写成一行：放不下就左右滑着看全；开头和别的本子一样的，先滑到不一样的那段（像原来的「…v48_修改6」）
  function nameLine(el, title, others) {
    const cut = sharedCut(title, others || []), pre = document.createElement('span');
    pre.textContent = title.slice(0, cut);
    el.textContent = '';
    el.append(pre, title.slice(cut));
    el.title = title;
    const fade = () => {
      el.classList.toggle('fade-l', el.scrollLeft > 2);
      el.classList.toggle('fade-r', el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
    };
    el.onscroll = fade;
    requestAnimationFrame(() => {
      el.scrollLeft = cut && el.scrollWidth > el.clientWidth ? Math.max(0, pre.offsetWidth - 12) : 0;
      fade();
    });
  }

  const bookTitles = () => (S.nbList || []).filter((n) => n.id.startsWith('book:')).map((n) => n.title);
  // 两个版本名只留不同的部分：「…v48_按草稿纸批注」「…v50_按意见修改8」
  function diffNames(a, b) {
    const cut = cutAtSep(a, commonPrefix(a, b));
    return cut >= 6 ? ['…' + a.slice(cut), '…' + b.slice(cut)] : [a, b];
  }

  // 本子列表和抽屉里的文件夹一起取（文件夹取不到就当没有，本子照样列出来）
  async function loadNotebooks() {
    const [list, fl] = await Promise.all([api('/api/notebooks').then((r) => r.json()),
      api('/api/folders').then((r) => r.json()).catch(() => ({ folders: S.folders }))]);
    S.nbList = list;
    S.folders = Array.isArray(fl.folders) ? fl.folders : [];
    renderNbList();
    setNbTitle();
    return S.nbList;
  }


  function iconSvg(name) {
    return `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  }

  function iconButton(icon, label) {
    const b = document.createElement('button');
    b.dataset.icon = icon;
    b.setAttribute('aria-label', label);
    b.innerHTML = iconSvg(icon);
    return b;
  }

  // 给页面里带 data-icon 的按钮插上图标
  function applyIcons(root) {
    for (const b of root.querySelectorAll('[data-icon]')) if (!b.querySelector('svg')) b.innerHTML = iconSvg(b.dataset.icon);
  }

  // 长按图标按钮：提示它是做什么的（iPad 没有鼠标悬停），这次松手不触发按钮
  function initLongPress() {
    let timer = null, start = null;
    document.addEventListener('pointerdown', (e) => {
      const b = e.target.closest && e.target.closest('[data-icon]');
      clearTimeout(timer);
      if (!b) return;
      start = [e.clientX, e.clientY];
      timer = setTimeout(() => { b.dataset.lp = '1'; toast(b.getAttribute('aria-label') || '', 2400); }, 550);
    }, true);
    document.addEventListener('pointermove', (e) => {
      if (start && Math.hypot(e.clientX - start[0], e.clientY - start[1]) > 10) clearTimeout(timer);
    }, true);
    for (const t of ['pointerup', 'pointercancel']) document.addEventListener(t, () => { clearTimeout(timer); start = null; }, true);
    document.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('[data-icon]');
      if (b && b.dataset.lp) { delete b.dataset.lp; e.stopImmediatePropagation(); e.preventDefault(); }
    }, true);
    document.addEventListener('contextmenu', (e) => { if (e.target.closest && e.target.closest('[data-icon]')) e.preventDefault(); }, true);
  }

  function setNbTitle() {
    if (!S.nb) return;
    nameLine($('#nbTitle'), S.nb.title, S.nb.id.startsWith('book:') ? bookTitles() : []);
    updateChip();
  }

  // 全屏时左上角：本子名和页码（只有一页时不写页码），点一下打开抽屉
  function updateChip() {
    if (!S.nb) return;
    $('#chipName').textContent = S.nb.title;
    $('#chipPage').textContent = S.nb.pages > 1 ? `${S.idx + 1}/${S.nb.pages}` : '';
    updateSegs();
    placeVer(); // 左上角那一排变宽变窄了：右上角的提示条看还挤不挤得下同一行
  }

  // 抽屉里的本子列表：最上面是草稿本和「Claude 推送」（不进文件夹）；接着是文件夹（一行，点一下折叠或展开，
  // 写着里面几本；展开时里面的本子缩进列在下面）；最后是不在文件夹里的本子。文件夹只有一层。
  // 已经设了只在本地的本子，名字后面用小字写「只在本地」（2026-11-14：原来那把小锁图标去掉，设置并进「这本发往」）
  const FIXED_NB = new Set(['scratch', 'board']);
  function renderNbList() {
    const box = $('#nbList');
    box.innerHTML = '';
    const books = bookTitles(), list = S.nbList || [], ids = new Set(list.map((n) => n.id)), holder = new Map();
    for (const f of S.folders || []) for (const id of f.items || []) if (ids.has(id) && !holder.has(id)) holder.set(id, f);
    for (const nb of list) if (FIXED_NB.has(nb.id)) nbRow(box, nb, false, books);
    for (const f of S.folders || []) {
      const inside = list.filter((nb) => holder.get(nb.id) === f);
      folderRow(box, f, inside.length);
      if (!isFolded(f)) for (const nb of inside) nbRow(box, nb, true, books);
    }
    for (const nb of list) if (!FIXED_NB.has(nb.id) && !holder.has(nb.id)) nbRow(box, nb, false, books);
  }

  // 一本的那一行：名字（放不下左右滑），只在本地的写个小字；右边一排图标：存回 PDF（当前这本有原 PDF 时）、文件夹、改名、删除
  function nbRow(box, nb, nested, books) {
    const cur = Boolean(S.nb && nb.id === S.nb.id), own = nb.id.startsWith('book:') || nb.id.startsWith('pad:');
    const row = document.createElement('div'), name = document.createElement('span'), acts = document.createElement('span');
    row.className = 'nb-item' + (cur ? ' cur' : '') + (nested ? ' nested' : '');
    row.dataset.nb = nb.id;
    name.className = 'nb-name';
    name.setAttribute('role', 'button');
    acts.className = 'nb-acts';
    row.appendChild(name);
    if (nb.local) {
      const tag = document.createElement('small');
      tag.className = 'nb-local';
      tag.textContent = '只在本地';
      row.appendChild(tag);
    }
    row.appendChild(acts);
    row.addEventListener('click', () => openNotebook(nb.id, 0));
    // 右边的图标：当前这本沿用原来的 id（存回 PDF 只有它有）；不能用的隐藏
    const btn = (icon, label, id, on, fn) => {
      const b = iconButton(icon, label);
      if (cur && id) b.id = id;
      b.hidden = !on;
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(nb, b); });
      acts.appendChild(b);
      return b;
    };
    if (cur) btn('save', '存回 PDF：把这本上的手写和 Claude 的批注写进原 PDF 文件（先留底，存完能撤回）', 'actSavePdf', Boolean(S.nb.savePdf), () => savePdf());
    if (own) btn('folder', '文件夹：放进哪个文件夹、移出文件夹、新建文件夹', 'actFolder', true, openFolderPick); // 草稿本和「Claude 推送」不进文件夹
    if (cur || own) {
      btn('edit', '改名', 'actRename', own, renameNotebook);
      btn('trash', '删除这本（文件还留在电脑上）', 'actDelete', own, deleteNotebook);
    }
    // 当前这本能撤回上一次修改（Claude 改的、另存的、存回 PDF 的）：名字下面另起一行一个文字按钮「撤回上次修改」。
    // 不和右边那排图标挤在一行（名字长时会被挤出抽屉）；右上角的提示条关掉以后在这里找（2026-11-14，阶段 C）
    if (cur && S.nb.undo) {
      const sub = document.createElement('div'), b = document.createElement('button');
      sub.className = 'nb-sub';
      b.id = 'actUndoEdit';
      b.textContent = '撤回上次修改';
      b.addEventListener('click', (e) => { e.stopPropagation(); toggleDrawer(false); undoEdit(); });
      sub.appendChild(b);
      row.appendChild(sub);
    }
    box.appendChild(row);
    nameLine(name, nb.title, nb.id.startsWith('book:') ? books : []);
  }

  // 文件夹那一行：▸ / ▾、文件夹名、里面几本；右边改名、删除两个图标
  function folderRow(box, f, n) {
    const folded = isFolded(f);
    const row = document.createElement('div'), mark = document.createElement('span'), name = document.createElement('span');
    const cnt = document.createElement('small'), acts = document.createElement('span');
    row.className = 'nf-item' + (folded ? '' : ' open');
    row.dataset.fid = f.id;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-expanded', String(!folded));
    mark.className = 'nf-mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.innerHTML = (folded ? '▸' : '▾') + iconSvg('folder');
    name.className = 'nf-name';
    name.textContent = f.name;
    cnt.className = 'nf-count';
    cnt.textContent = `${n} 本`;
    acts.className = 'nb-acts';
    for (const [icon, label, fn] of [['edit', '改这个文件夹的名字', renameFolder], ['trash', '删除这个文件夹（里面的本子回到外面，本子本身不动）', deleteFolder]]) {
      const b = iconButton(icon, label);
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(f); });
      acts.appendChild(b);
    }
    row.append(mark, name, cnt, acts);
    row.addEventListener('click', () => toggleFolder(f.id));
    box.appendChild(row);
  }

  // 折叠状态记在这台设备上；这台设备上没点过的，按文件夹自己带的默认（「原先」那个默认折叠，自己新建的默认展开）
  function folds() { const v = store.get('folds', {}); return v && typeof v === 'object' ? v : {}; }
  function isFolded(f) { const v = folds(); return Object.prototype.hasOwnProperty.call(v, f.id) ? Boolean(v[f.id]) : Boolean(f.folded); }
  function setFolded(fid, on) { const v = folds(); v[fid] = on; store.set('folds', v); }
  function toggleFolder(fid) {
    const f = (S.folders || []).find((x) => x.id === fid);
    if (!f) return;
    setFolded(fid, !isFolded(f));
    renderNbList();
  }
  const folderOfNb = (id) => (S.folders || []).find((f) => (f.items || []).includes(id)) || null;
  // 当前打开的本子在一个折叠着的文件夹里：那个文件夹自动展开（记成展开，之后想折叠再点一下）
  function revealCurrent() {
    const f = S.nb && folderOfNb(S.nb.id);
    if (f && isFolded(f)) setFolded(f.id, false);
  }

  // 点一本旁边的文件夹图标：在它下面弹出一个小列表——现有的各个文件夹（它在的那个打 ✓）、「移出文件夹」（在文件夹里时才有）、「新建文件夹…」
  function openFolderPick(nb, anchor) {
    $('#targetPick').hidden = true;
    const box = $('#folderPick'), list = $('#folderPickList'), inF = folderOfNb(nb.id);
    list.innerHTML = '';
    for (const f of S.folders || []) {
      const b = pickRow('fp-folder', inF === f);
      b.dataset.fid = f.id;
      const l1 = b.querySelector('.tp-l1');
      l1.textContent = f.name;
      l1.setAttribute('data-lang-keep', ''); // 文件夹名是你起的，不翻译
      b.addEventListener('click', () => { closeFolderPick(); if (inF !== f) moveToFolder(nb, f); });
      list.appendChild(b);
    }
    if (!(S.folders || []).length) {
      const d = document.createElement('div');
      d.className = 'row small';
      d.textContent = '还没有文件夹';
      list.appendChild(d);
    }
    const sep = document.createElement('div');
    sep.className = 'tp-sep';
    list.appendChild(sep);
    if (inF) {
      const out = document.createElement('button');
      out.className = 'row';
      out.id = 'fpOut';
      out.textContent = '移出文件夹';
      out.addEventListener('click', () => { closeFolderPick(); moveToFolder(nb, null); });
      list.appendChild(out);
    }
    const add = document.createElement('button');
    add.className = 'row';
    add.id = 'fpNew';
    add.textContent = '新建文件夹…';
    add.addEventListener('click', () => { closeFolderPick(); newFolder(nb); });
    list.appendChild(add);
    box.dataset.nb = nb.id;
    box.hidden = false;
    // 紧挨着那个图标：放在它下面，靠右对齐；下面放不下就放到上面
    const r = anchor.getBoundingClientRect(), w = box.offsetWidth, h = box.offsetHeight;
    box.style.left = clamp(r.right - w, 8, innerWidth - w - 8) + 'px';
    box.style.top = (r.bottom + 4 + h <= innerHeight - 8 ? r.bottom + 4 : Math.max(8, r.top - 4 - h)) + 'px';
  }
  function closeFolderPick() { $('#folderPick').hidden = true; }

  async function folderOp(path, body) {
    const res = await (await api(path, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })).json();
    if (Array.isArray(res.folders)) S.folders = res.folders;
    return res;
  }

  // 放进文件夹（f 为 null 是移出）。放进去的是当前这本、那个文件夹又折叠着：展开它，免得当前这本看不见了
  async function moveToFolder(nb, f) {
    try {
      await folderOp('/api/folders/move', { nb: nb.id, folder: f ? f.id : '' });
    } catch (e) { toast('没放成：' + e.message, 4000); return; }
    revealCurrent();
    renderNbList();
    toast(f ? `已放进「${f.name}」` : '已移出文件夹', 1800);
  }

  // 新建文件夹：起个名字（和新建本子一样，在一张卡片里写）；nb 给了就顺手把它放进去
  async function newFolder(nb) {
    const name = await askName('新建文件夹', '');
    if (name === null) return;
    try {
      await folderOp('/api/folders/new', nb ? { name, nb: nb.id } : { name });
    } catch (e) { toast('没建成：' + e.message, 4000); return; }
    revealCurrent();
    renderNbList();
    toast(nb ? `已放进「${name}」` : `已建立文件夹「${name}」`, 2200);
  }

  async function renameFolder(f) {
    const name = await askName('文件夹改名', f.name);
    if (name === null || name === f.name) return;
    try { await folderOp('/api/folders/rename', { id: f.id, name }); } catch (e) { toast('没改成：' + e.message, 4000); return; }
    renderNbList();
    toast(`已改名为「${name}」`, 2000);
  }

  // 删文件夹前问一句；删了以后里面的本子回到外面，本子本身不动
  async function deleteFolder(f) {
    const n = (f.items || []).filter((id) => (S.nbList || []).some((x) => x.id === id)).length;
    if (!confirm(`删除文件夹「${f.name}」？\n里面的 ${n} 本回到外面，本子本身不动。`)) return;
    try { await folderOp('/api/folders/delete', { id: f.id }); } catch (e) { toast('没删成：' + e.message, 4000); return; }
    renderNbList();
    toast(`已删除文件夹「${f.name}」`, 2000);
  }

  // 起名字的卡片（新建文件夹、文件夹改名）：和「新建本子」同一种卡片，不用浏览器自带的输入框。返回写的名字，取消是 null
  function askName(title, value) {
    const card = $('#nameAsk'), input = $('#nameAskInput');
    if (S.nameAsk) S.nameAsk(null); // 上一张还开着：当作取消
    $('#nameAskTitle').textContent = title;
    input.value = value || '';
    card.hidden = false;
    setTimeout(() => { try { input.focus(); input.select(); } catch (e) { /* */ } }, 50);
    return new Promise((res) => {
      S.nameAsk = (v) => { S.nameAsk = null; card.hidden = true; res(v); };
    });
  }
  function answerName(ok) {
    if (!S.nameAsk) return;
    const v = $('#nameAskInput').value.trim();
    if (ok && !v) { toast('名字是空的', 1800); return; }
    S.nameAsk(ok ? v : null);
  }

  // 只在本地（不发给 Claude）：在「这本发往」的列表里选（最下面那一项），选一个对话就取消。
  // 发送、整本发送都在平板上先拦下（服务端也拦）；设置记在电脑上
  async function setLocal(nb, on) {
    if (!nb) return false;
    try {
      await api('/api/notebook/setting', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nb: nb.id, key: 'local', value: on }) });
    } catch (e) { toast('没设成：' + e.message); return false; }
    nb.local = on;
    const inList = (S.nbList || []).find((x) => x.id === nb.id);
    if (inList) inList.local = on;
    if (S.nb && S.nb.id === nb.id) S.nb.local = on;
    renderNbList();
    updateTargetRow();
    updateCheck(); // 「AI」按钮换成「只在本地」，或换回来
    toast(on ? `《${nb.title}》只在本地：不会发给 Claude` : `《${nb.title}》可以发给 Claude 了`, 2600);
    return true;
  }

  function localBlocked() {
    if (!S.nb || !S.nb.local) return false;
    toast(`《${S.nb.title}》设为「只在本地」，不发给 Claude。要发的话，在抽屉里点「这本发往」选一个对话。`, 4000);
    return true;
  }

  async function openNotebook(id, idx) {
    await flushSave();
    let info;
    try { info = await (await api('/api/notebook?nb=' + encodeURIComponent(id))).json(); } catch (e) {
      toast('打不开这个本子：' + e.message);
      if (id !== 'scratch') return openNotebook('scratch', 0);
      return;
    }
    S.nb = info;
    updateCheck(); // 「AI」按钮换成这一本的样子（这本交过、还没走完的那一轮；只在本地）
    S.page = null; // 别把上一本的页当成这一本的相邻页
    flowReset();
    // 这本上没选过就上下页接在一起、滑着翻；在抽屉、左上角或顶栏里选过「单页」的照选的来
    S.flow = info.flowSet ? Boolean(info.flow) : true;
    updateSegs();
    if (!(S.nbList || []).some((n) => n.id === id)) await loadNotebooks();
    revealCurrent(); // 这本在一个折叠着的文件夹里：抽屉里那个文件夹展开
    setNbTitle();
    updateTargetRow(); // 「这本发往」那一行换成这一本的（只在本地的写只在本地）
    renderNbList();
    await openPage(clamp(idx || 0, 0, info.pages - 1));
  }

  // 按页面数据摆纸：存下来的高度、正文区和页边宽度、向左向上扩出的纸
  function layoutPage() {
    const G = geomOf(S.page, S.idx);
    Object.assign(S, { baseH: G.baseH, storedH: G.storedH, pageH: G.pageH, W: G.W, M: G.M, TW: G.TW, X0: G.X0, Y0: G.Y0 });
  }

  // 一页的纸（当前页和连续阅读的相邻页共用）：没转 / 转后的底图高度、存下来的高度、正文区和页边宽度、向左向上扩出的纸
  function geomOf(page, i) {
    const baseH0 = S.nb && S.nb.sizes && S.nb.sizes[i] ? S.nb.sizes[i].h : SCRATCH_H;
    const baseH = Turn.heightAt(page.rot, baseH0), storedH = Math.max(baseH, page.h || 0), Wp = W + (page.xw || 0);
    const Mp = needsMargin(page, Wp) ? M : 0;
    const G = { baseH0, baseH, storedH, pageH: storedH, W: Wp, M: Mp, TW: Wp + Mp, X0: -(page.ox || 0), Y0: -(page.oy || 0), rot: page.rot || 0 };
    // 连续阅读的最后一页下面没有别的页：纸至少铺到屏幕底，和 fit() 里单页时的算法一样（「整页」适配时不铺）
    if (S.flow && S.fitMode !== 'page' && lastPage(i)) {
      const pad = S.collapsed ? 0 : 10;
      G.pageH = Math.max(storedH, Math.floor(G.Y0 + (VH - 2 * pad) * (G.TW - G.X0) / (VW - 2 * pad)));
    }
    return G;
  }
  const lastPage = (i) => Boolean(S.nb) && i === S.nb.pages - 1;

  async function openPage(i) {
    S.compare = false;
    stopReplay();
    await flushSave();
    if (S.flow && S.page && S.idx !== i) { // 连续阅读：离开的这页留着（数据、底图、撤销记录）
      S.flowCache.set(S.idx, { page: S.page, img: S.bgImg, url: S.bgUrl, undo: S.undo });
      S.undos.set(pageKey(), S.undo);
      S.bgUrl = null;
    }
    const cached = S.flow ? S.flowCache.get(i) : null;
    S.idx = i;
    S.baseH0 = S.nb.sizes && S.nb.sizes[i] ? S.nb.sizes[i].h : SCRATCH_H;
    S.baseH = S.baseH0;
    S.pageH = S.baseH;
    S.undo = S.flow ? S.undos.get(pageKey()) || (cached && cached.undo) || [] : [];
    closeCard(); // 翻页：卡片收起
    S.page = null;
    if (S.bgUrl) { URL.revokeObjectURL(S.bgUrl); S.bgUrl = null; }
    S.bgImg = null;
    $('#pageNo').textContent = `${i + 1}/${S.nb.pages}`;
    $('#prev').disabled = i <= 0;
    $('#next').disabled = i >= S.nb.pages - 1;
    let page, img;
    if (cached) {
      S.flowCache.delete(i);
      page = cached.page;
      img = cached.img;
      S.bgUrl = cached.url;
    } else {
      const key = pageKey();
      [page, img] = await Promise.all([
        api(`/api/page?nb=${encodeURIComponent(S.nb.id)}&i=${i}`).then((r) => r.json()),
        loadBgImage(S.nb, i),
      ]);
      if (key !== pageKey()) return; // 用户已经翻走了
      page = normalizePage(page);
    }
    S.page = page;
    S.bgImg = img;
    layoutPage();
    fit(S.fitMode || 'width');
    showPage();
  }

  // 当前页换好之后：页码、按钮、记住位置、批注、提示条、缩略图、Claude 的新回复、连续阅读的相邻页。
  // 把 Claude 的回复落到相邻页时（S.landing）只是临时换过去又换回来：不报位置、不另去取待处理的回复
  function showPage() {
    const i = S.idx;
    $('#pageNo').textContent = `${i + 1}/${S.nb.pages}`;
    updateChip();
    $('#prev').disabled = i <= 0;
    $('#next').disabled = i >= S.nb.pages - 1;
    if (!S.landing) {
      api('/api/where', { method: 'POST', body: JSON.stringify({ nb: S.nb.id, page: i }), headers: { 'Content-Type': 'application/json' } })
        .catch(() => {});
      store.set('pos', { nb: S.nb.id, i });
    }
    renderAI();
    updateStatus(S.dirty ? '未保存' : '已保存');
    updateVerChip();
    if (!$('#drawer').hidden) renderThumbs();
    if (!S.landing) processPending();
    ensureNeighbors();
  }

  // ------------------------------------------------------------ 书更新：原文件改了、这一页改了什么、对比旧版

  function pageChange() {
    const ch = S.nb && S.nb.changes, pi = S.nb && S.nb.pageInfo && S.nb.pageInfo[S.idx];
    if (!ch || !ch.pages || !pi || pi.pdf === null || pi.pdf === undefined) return null;
    return ch.pages[String(pi.pdf)] || null;
  }

  function updateVerChip() {
    const chip = $('#verchip'), act = $('#verAct'), nb = S.nb;
    chip.classList.remove('old');
    const pc = pageChange();
    if (nb && nb.kind === 'book' && !nb.sourceChanged && nb.hiddenMissing && !S.verHidden['src:' + nb.id]) {
      $('#verText').textContent = `原 PPT 有 ${nb.hiddenMissing} 张隐藏页没转进来`;
      act.textContent = '重新转换';
      act.hidden = false;
      chip.dataset.kind = 'source';
      chip.hidden = false;
    } else if (nb && nb.kind === 'book' && nb.sourceChanged && !S.verHidden['src:' + nb.id]) {
      $('#verText').textContent = `原文件「${nb.source}」改过了`;
      act.textContent = '更新到草稿纸';
      act.hidden = false;
      chip.dataset.kind = 'source';
      chip.hidden = false;
    } else if (pc && !S.verHidden[verKey('page', nb)]) {
      chip.dataset.kind = 'page';
      if (pc.status === 'new') {
        $('#verText').textContent = '这一页是更新后新加的';
        act.hidden = true;
      } else {
        const ch = nb.changes, [from, to] = ch.from && ch.to && ch.from !== ch.to ? diffNames(ch.from, ch.to) : ['', ''];
        const vers = from ? `（${from} → ${to}）` : '';
        $('#verText').textContent = S.compare ? `正在看更新前的旧版${from ? '（' + from + '）' : ''}` : `这一页更新时改过${vers}，橙框处`;
        act.textContent = S.compare ? '回到新版' : '对比旧版';
        act.hidden = false;
        chip.classList.toggle('old', S.compare);
      }
      chip.hidden = false;
    } else {
      chip.hidden = true;
    }
    // 这次换新版是 Claude 改文件后导入的（或刚撤回过一次）：提示条上带「撤回这次修改」（「再往回撤一次」）
    const ub = $('#verUndo'), ut = !chip.hidden && chip.dataset.kind === 'page' && !S.compare ? chipUndoText() : '';
    ub.textContent = ut;
    ub.hidden = !ut;
    placeVer();
    placeQ(); // 右上角的提示条出来、收起：顶上的卡片跟着让开
  }

  // 关掉的提示条记在哪个键下：「原文件改过了」按这本记；「这一页更新时改过」按这本的这一版记——
  // 关掉的是这一次更新的提示，之后再换新版（Claude 又改了、撤回了一次）照样出来（2026-11-14，阶段 C）
  function verKey(kind, nb) {
    nb = nb || S.nb;
    return kind === 'source' ? 'src:' + nb.id : `chg:${nb.id}@${nb.v || 0}`;
  }

  // 提示条上撤回按钮的字：这次换新版就是能撤回的那一次修改 →「撤回这次修改」；刚在平板上撤回过（换回去的）、还能往回撤 →「再往回撤一次」；
  // 别的情况（比如原文件是用户自己在电脑上改的、点了更新）不出，抽屉里这本那一行照样能撤回
  function chipUndoText() {
    const nb = S.nb, u = nb && nb.undo, ch = nb && nb.changes;
    if (!u || !ch) return '';
    if (ch.undo) return '再往回撤一次';
    return ch.edit && ch.edit === u.edit ? '撤回这次修改' : '';
  }

  // 右上角的提示条放在哪（2026-11-14，阶段 C：原来全屏时压在页面右上角）：全屏时和左上角那一排同一行、靠右，
  // 放不下就排在那一排下面；退出全屏时在顶栏下面靠右。挪到上面来的右下角那一条正好在那儿的话，排在它下面。
  // 顶上居中归问话卡片和小条（placeQ 让它们排在提示条下面）
  function placeVer() {
    const c = $('#verchip');
    if (c.hidden) return;
    const vw = document.documentElement.clientWidth, w = c.offsetWidth, h = c.offsetHeight;
    let top;
    if (S.collapsed) {
      const row = $('#chipRow').getBoundingClientRect();
      top = row.top + (row.height - h) / 2;
      if (row.right + 12 > vw - 10 - w) top = row.bottom + 6; // 和左上角那一排挤不下
    } else {
      top = $('#bar').getBoundingClientRect().bottom + 8;
    }
    const t = $('#tools');
    if (S.collapsed && t.offsetWidth) {
      const r = t.getBoundingClientRect();
      if (r.left < vw - 10 && r.right > vw - 10 - w && r.top < top + h && r.bottom > top) top = r.bottom + 6;
    }
    c.style.top = `${Math.round(Math.max(0, top))}px`;
  }

  // 改动的地方用橙色虚线框标出来（新版、旧版上都标）
  function markChanges() {
    const old = aiRoot.querySelector('.chg-marks');
    if (old) old.remove();
    const pc = pageChange();
    if (!pc || pc.status !== 'changed' || S.verHidden[verKey('page')]) return;
    const g = el('g', { class: 'ai-temp chg-marks' }, aiRoot);
    const m = Turn.between(0, S.page.rot || 0, S.baseH0); // 改动框按没转的页面算的
    for (const b0 of pc.boxes) {
      const b = Turn.box(m, b0);
      el('rect', { x: f1(b[0]), y: f1(b[1]), width: f1(b[2] - b[0]), height: f1(b[3] - b[1]), rx: 6, class: 'chg' }, g);
    }
  }

  async function toggleCompare() {
    const pc = pageChange();
    if (!pc || pc.old === null || pc.old === undefined) return;
    const key = pageKey();
    const img = await loadBgImage(S.nb, S.idx, !S.compare);
    if (key !== pageKey() || !img) return;
    S.compare = !S.compare;
    S.bgImg = img;
    redrawAll();
    renderAI();
    updateVerChip();
  }

  // 「已换成新版（…v48 → …v50）：第 2 页有改动」或「《例会》已更新：第 3 页有改动」
  function updateMessage(title, prev, text) {
    if (prev) {
      const [a, b] = diffNames(prev, title);
      return `已换成新版（${a} → ${b}）：${text}`;
    }
    return `《${shortTitle(title, [])}》已更新：${text}`;
  }

  // 改名：自己建的本子改标题；导入的书连 PDF 文件一起改名，笔迹跟着走
  async function renameNotebook(target) {
    const nb = target || S.nb;
    if (!nb || !(nb.id.startsWith('book:') || nb.id.startsWith('pad:'))) return;
    const title = prompt('改成什么名字？', nb.title);
    if (title === null || !title.trim() || title.trim() === nb.title) return;
    try {
      await flushSave();
      const res = await (await api('/api/notebook/rename', { method: 'POST', body: JSON.stringify({ nb: nb.id, title }),
        headers: { 'Content-Type': 'application/json' } })).json();
      await loadNotebooks();
      if (S.nb && nb.id === S.nb.id) await openNotebook(res.id, S.idx); // 改的是正开着的这本
      toast(`已改名为「${res.title}」`, 2500);
    } catch (e) {
      toast('没改成：' + e.message, 5000);
    }
  }

  async function deleteNotebook(target) {
    hideMenu();
    const nb = target || S.nb, pad = nb && nb.id.startsWith('pad:');
    if (!nb || !(pad || nb.id.startsWith('book:'))) return;
    // 平板上没有找回的入口：电脑上是挪开留着（PDF 进 books/_已删除，笔迹文件夹改成 _deleted 开头），要找回得让 Claude 挪回来
    if (!confirm(pad ? `从列表里删除「${nb.title}」？\n上面的手写还留在电脑上，要找回就让 Claude 帮你挪回来。`
      : `从列表里删除《${nb.title}》？\nPDF 和上面的手写都还留在电脑上，要找回就让 Claude 帮你挪回来。`)) return;
    try {
      await flushSave();
      await api('/api/notebook/delete', { method: 'POST', body: JSON.stringify({ nb: nb.id }), headers: { 'Content-Type': 'application/json' } });
      await loadNotebooks();
      if (!S.nb || nb.id === S.nb.id) await openNotebook('scratch', 0); // 删的是正开着的这本：回到草稿本
      toast(`已删除「${nb.title}」。文件还留在电脑上，要找回就让 Claude 帮你挪回来。`, 5000);
    } catch (e) {
      toast('没删成：' + e.message, 5000);
    }
  }

  // 存回 PDF：手写和 Claude 的批注作为标准 PDF 批注写进原文件（电脑上先留底，存完能撤回；再存时替换上次写的）
  async function savePdf() {
    const nb = S.nb;
    if (!nb || !nb.savePdf) return;
    if (!nb.saved && !confirm(`把这本上的手写和 Claude 的批注写进原文件「${nb.source}」？\n写之前先把原文件留一份底，存完能撤回；以后再存会替换上次写进去的。`)) return;
    toast(`正在存回 ${nb.source}…`, 60000);
    try {
      await flushSave();
      const res = await (await api('/api/book/save-pdf', { method: 'POST', body: JSON.stringify({ nb: nb.id }),
        headers: { 'Content-Type': 'application/json' } })).json();
      nb.saved = new Date().toISOString();
      // 存之前留了底：提示上带「撤回」（先在顶上问一句，和撤回 Claude 的修改同一套）
      if (res.undo) toast(savedMessage(res), 10000, '撤回', () => undoEdit());
      else toast(savedMessage(res), 6000);
      refreshBookInfo(); // 抽屉里这本那一行出「撤回上次修改」
    } catch (e) {
      toast('没存成：' + e.message, 6000);
    }
  }

  function savedMessage(r) {
    const done = [`手写 ${r.ink} 组`];
    if (r.marks + r.notes) done.push(`Claude 批注 ${r.marks + r.notes} 条`);
    const skip = [];
    if (r.outside) skip.push(`页边和加长纸上的 ${r.outside} 组`);
    if (r.blank) skip.push(`插入空白页上的 ${r.blank} 组`);
    if (r.outside_ai) skip.push(`Claude 指着页面外的 ${r.outside_ai} 条`);
    const msg = `已存回 ${r.name}：${done.join('、')}` + (skip.length ? `（${skip.join('、')}没法写进 PDF）` : '');
    return msg + (r.unplaced ? `。第 ${r.unplaced_pages.join('、')} 页还有 Claude 的 ${r.unplaced} 条回复没落到纸上，没写进去：翻到那几页后再存一次` : '');
  }

  async function updateBook() {
    const nb = S.nb;
    if (!nb || nb.kind !== 'book') return;
    toast(`正在更新《${nb.title}》…（PPT/Word 要先转换，稍等）`, 180000);
    await flushSave();
    S.selfUpdate = nb.id;
    try {
      const body = JSON.stringify({ nb: nb.id });
      const res = await (await api('/api/book-update', { method: 'POST', body, headers: { 'Content-Type': 'application/json' } })).json();
      await openNotebook(res.id || nb.id, S.idx);
      toast(updateMessage(res.title, res.prev, res.text), 8000);
    } catch (e) {
      toast('没更新成：' + e.message, 6000);
    }
  }

  // ------------------------------------------------------------ 撤回对原文件的上一次修改（2026-11-14，阶段 C；《产品定义》第 4 节）
  // 入口：右上角提示条上的「撤回这次修改」、抽屉里这本那一行的「撤回上次修改」、存回 PDF 后提示上的「撤回」。
  // 点了先在顶上问一句（和问话卡片同一种卡片）；文件在那次修改之后又改过的，那一句写明会连后来的改动一起回退、现在这份另留一份。
  // 确认后电脑上的文件回到修改之前（另存的那次：这本换回原文件，另存出来的留在电脑上），这本原地换回去；纸上那几条「已改」写成「已撤回」。
  // 不需要 Claude 在场；撤回后服务给改它的那个对话送一条简短的消息。

  async function undoEdit() {
    const nb = S.nb;
    if (!nb || nb.kind !== 'book' || S.undoing) return;
    let u;
    try {
      await flushSave();
      u = await (await api(`/api/book/undo?nb=${encodeURIComponent(nb.id)}`)).json();
    } catch (e) {
      toast('没撤回：' + e.message, 6000);
      return;
    }
    if (S.nb !== nb) return;
    if (!u.can) { toast('没有可撤回的修改了', 3000); refreshBookInfo(); return; }
    toggleDrawer(false); // 顶上的卡片在抽屉底下：先收起抽屉
    if (!(await askLocal({ head: '撤回修改', text: undoQuestion(u), yes: '撤回' })) || S.nb !== nb) return;
    S.undoing = true;
    S.selfUpdate = nb.id;
    toast('正在撤回…', 180000);
    try {
      const res = await (await api('/api/book/undo', { method: 'POST', body: JSON.stringify({ nb: nb.id, id: u.id, changed: u.changed }),
        headers: { 'Content-Type': 'application/json' } })).json();
      await loadNotebooks();
      await openNotebook(res.id || nb.id, S.idx);
      toast(undoMessage(res), res.ok && !res.warning ? 8000 : 12000);
    } catch (e) {
      S.selfUpdate = null;
      toast('没撤回：' + e.message, 8000);
      refreshBookInfo();
    } finally {
      S.undoing = false;
    }
  }

  // 撤回前问的那一句：平常的、另存的、存回 PDF 的；文件在那次修改之后又改过的，加上会连后来的改动一起回退、现在这份另留一份
  function undoQuestion(u) {
    if (u.kind === 'saveas') return `撤回对《${u.file}》的另存？平板上这本换回原文件《${u.back}》，另存出来的《${u.file}》留在电脑上，不删。`;
    const head = u.mode === 'savepdf' ? `撤回对《${u.file}》的上一次存回？电脑上的文件会回到存回之前。` : `撤回对《${u.file}》的上一次修改？电脑上的文件会回到修改之前。`;
    return head + (u.changed ? '\n这个文件在那次修改之后又改过，撤回会连后来的改动一起回退；现在这份会另留一份，要用可以让 Claude 找回。' : '');
  }

  // 撤回之后的一句话。撤回成了：说回到了哪里、还能不能再往回撤；没成（没有可撤的、那一版的留底用不了、写不回去）：
  // 中文界面照服务说的原话（比如文件正被 Word 开着，关掉再撤），英文界面按是哪一种出一句英文
  const UNDO_FAIL = {
    nothing: '没有可撤回的修改了',
    skipped: '那一版的留底用不了（可能被手动删了），这条记录已去掉；文件没动，再点撤回会接着撤更早的一次',
    failed: '没撤回：文件可能正被 Word、PowerPoint 等程序开着，或者没有权限写；关掉后再撤。电脑上的文件没动',
  };
  function undoMessage(r) {
    const en = window.InkLang && window.InkLang.lang === 'en';
    if (!r.ok) return en ? (UNDO_FAIL[r.action] || UNDO_FAIL.failed) : (r.message || UNDO_FAIL[r.action] || UNDO_FAIL.failed);
    let msg = r.action === 'switched' ? `已撤回另存：这本换回了《${r.back || ''}》，《${r.file}》留在电脑上`
      : r.mode === 'savepdf' ? `已撤回：《${r.file}》回到了存回之前` : `已撤回：《${r.file}》回到了修改之前`;
    if (r.aside) msg += '；后来又改过的那份另留了一份';
    if (r.action !== 'switched') msg += r.left ? `（还能再往回撤 ${r.left} 次）` : '（再往前没有留底了）';
    if (r.warning) msg += en ? '' : `。${r.warning}`;
    return msg;
  }

  // 顶上问一句（和问话卡片同一张卡片、同一个位置，排在服务发来的卡片前面）：点「撤回」得 true，点「取消」或在纸上落笔得 false
  function askLocal(o) {
    return new Promise((res) => {
      if (S.qLocal) S.qLocal.done(false);
      const c = Object.assign({ id: 'local-' + uid(), kind: 'local' }, o);
      c.done = (v) => {
        if (S.qLocal !== c) return;
        S.qLocal = null;
        S.qShown = null;
        renderQ();
        res(Boolean(v));
      };
      S.qLocal = c;
      S.qMin = false;
      $('#toast').hidden = true; // 之前那句提示（比如「已更新」）已经过时了，别压在这一句上
      renderQ();
    });
  }

  // 回到前台（或别的设备撤回过）：重新问一下这本书的情况——原文件在电脑上改过了没有、还能不能撤回、哪几次撤回过。
  // 书本身换了版本（别处更新过）就整本重新打开
  async function refreshBookInfo() {
    const nb = S.nb;
    if (!nb || nb.kind !== 'book') return;
    let info;
    try { info = await (await api('/api/notebook?nb=' + encodeURIComponent(nb.id))).json(); } catch (e) { return; }
    if (S.nb !== nb) return;
    if (info.v !== nb.v || info.pages !== nb.pages) { await openNotebook(nb.id, S.idx); return; }
    for (const k of ['sourceChanged', 'undo', 'undone', 'changes', 'saved', 'savePdf', 'source']) nb[k] = info[k];
    updateVerChip();
    markChanges();
    renderAI();
    if (!$('#drawer').hidden) renderNbList();
  }

  // 书页和 Claude 推送的页面有背景图；草稿本没有
  async function loadBgImage(nb, i, old) {
    try {
      const r = await fetchBg(nb, i, old);
      if (!r) return null;
      S.bgUrl = r.url;
      return r.img;
    } catch (e) {
      toast('背景加载失败：' + e.message);
      return null;
    }
  }

  // 一页的底图：{img, url}（url 用完要放掉）；没有底图的页为 null
  async function fetchBg(nb, i, old) {
    const path = nb.kind === 'book' ? '/api/bookpage' : nb.kind === 'board' ? '/api/boardbg' : null;
    const pi = nb.pageInfo && nb.pageInfo[i];
    if (!path || (pi && pi.blank)) return null; // 插入的空白纸没有底图
    // v：书的版本（文件修改时间），书更新后地址变了，不会拿到缓存里的旧图
    const extra = nb.kind === 'book' ? `&v=${nb.v || 0}${old ? '&old=1' : ''}` : '';
    const blob = await (await api(`${path}?nb=${encodeURIComponent(nb.id)}&i=${i}${extra}`)).blob();
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.src = url;
    await img.decode();
    return { img, url };
  }

  // ------------------------------------------------------------ 左侧抽屉：本子、页面缩略图、加页删页

  function toggleDrawer(show) {
    const d = $('#drawer');
    const on = show === undefined ? d.hidden : show;
    d.hidden = !on;
    if (!on) closeFolderPick();
    if (on) {
      closeCard(); // 开抽屉：卡片收起
      S.thumbVer = Date.now();
      renderNbList();
      updateTargetRow();
      renderThumbs();
      updateSegs();
      $('#hiddenList').hidden = true;
    }
  }

  // 抽屉里「这本发往」那一行：点开选对话（某个项目的专用对话在这里绑一次），或选「不发给 Claude（只在本地）」
  function updateTargetRow() {
    $('#actTarget').textContent = '这本发往：' + targetText() + ' ▾';
  }

  function renderThumbs() {
    const box = $('#thumbs');
    box.innerHTML = '';
    if (!S.nb) return;
    $('#thumbCount').textContent = `（${S.nb.pages} 页${S.nb.hidden ? `，已删 ${S.nb.hidden} 页` : ''}）`;
    for (let i = 0; i < S.nb.pages; i++) {
      const pi = (S.nb.pageInfo || [])[i] || {};
      const d = document.createElement('div');
      d.className = 'th' + (i === S.idx ? ' cur' : '') + (pi.blank && S.nb.kind !== 'scratch' && S.nb.kind !== 'pad' ? ' blank' : '')
        + (pi.hiddenSlide ? ' hid' : '');
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = `第 ${i + 1} 页`;
      img.src = `/api/thumb?nb=${encodeURIComponent(S.nb.id)}&i=${i}&${TOKEN ? 'd=' + encodeURIComponent(TOKEN) : 'k=' + encodeURIComponent(CODE)}&t=${S.thumbVer || 0}`;
      const label = document.createElement('span');
      label.textContent = String(i + 1);
      d.append(img, label);
      d.addEventListener('click', () => openPage(i));
      box.appendChild(d);
    }
    const cur = box.querySelector('.th.cur');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  function pageHasContent() {
    return S.page && (S.page.strokes.some((s) => !s.erasedAt) || S.page.ai.some((a) => !a.dismissed));
  }

  async function pageOp(path, body) {
    await flushSave();
    return (await api(path, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })).json();
  }

  async function addPageAfter(orient) {
    if (!S.nb) return;
    try {
      const res = await pageOp('/api/page/insert', { nb: S.nb.id, after: S.idx, orient });
      S.nb = res.notebook;
      flowReset(); // 页号变了
      queueSave();
      S.page = null;
      S.thumbVer = Date.now();
      await openPage(res.page);
      toast(`已在第 ${res.page} 页后加了一张空白页`, 2000);
    } catch (e) { toast('没加成：' + e.message, 4000); }
  }

  // 左上角和顶栏上的「加页」：在这一页后面加一张和它同方向的空白页（这一页横着——转过的算转过以后——就加横版，否则竖版），
  // 翻过去。用的是抽屉里两个加页图标的同一个办法；这一页还没载入完时不动（还不知道它是横是竖）
  function addPageLikeThis() {
    if (!S.nb || !S.page) return;
    addPageAfter(S.baseH < W ? 'landscape' : 'portrait');
  }

  // 旋转这一页：底图、笔迹、Claude 的批注一起转 90°（dir 1 右转，-1 左转），存下来；不进撤销，反向转回去
  async function rotatePage(dir) {
    if (!S.page || S.replay) return;
    closeCard();
    Turn.turnPage(S.page, dir, { h0: S.baseH0, mainW: S.W });
    S.undo = [];
    layoutPage();
    markDirty();
    fit(S.fitMode || 'width');
    renderAI();
    S.thumbVer = Date.now();
    await flushSave();
    if (!$('#drawer').hidden) renderThumbs();
  }

  async function deletePage() {
    if (!S.nb) return;
    if (S.nb.pages <= 1) { toast('最后一页不能删'); return; }
    if (pageHasContent() && !confirm('这一页写过字，确定从本子里删掉？\n可以在抽屉的「显示已删的页」里恢复。')) return;
    try {
      const res = await pageOp('/api/page/delete', { nb: S.nb.id, i: S.idx });
      S.nb = res.notebook;
      flowReset(); // 页号变了
      queueSave();
      S.page = null;
      S.thumbVer = Date.now();
      await openPage(Math.min(S.idx, S.nb.pages - 1));
      toast('已删除这一页（可以恢复）', 2500);
    } catch (e) { toast('没删成：' + e.message, 4000); }
  }

  async function showHidden() {
    const box = $('#hiddenList');
    if (!box.hidden) { box.hidden = true; return; }
    let list = [];
    try { list = await (await api(`/api/page/hidden?nb=${encodeURIComponent(S.nb.id)}`)).json(); } catch (e) { return; }
    box.innerHTML = '';
    if (!list.length) box.textContent = '这本没有删掉的页。';
    for (const h of list) {
      const row = document.createElement('div');
      row.className = 'hr';
      const t = document.createElement('span');
      t.textContent = h.label + (h.ink ? '（写过字）' : '');
      const b = document.createElement('button');
      b.textContent = '恢复';
      b.addEventListener('click', async () => {
        try {
          const res = await pageOp('/api/page/restore', { nb: S.nb.id, key: h.key });
          S.nb = res.notebook;
          flowReset(); // 页号变了
          queueSave();
          S.page = null;
          S.thumbVer = Date.now();
          box.hidden = true;
          await openPage(res.page);
        } catch (e) { toast('没恢复成：' + e.message, 4000); }
      });
      row.append(t, b);
      box.appendChild(row);
    }
    box.hidden = false;
  }

  // ------------------------------------------------------------ 新建本子

  function openNewNotebook() {
    toggleDrawer(false);
    $('#newNbTitle').value = '';
    $('#newNbPaper').value = 'portrait';
    $('#newNb').hidden = false;
  }

  async function createNotebook() {
    const title = $('#newNbTitle').value.trim() || '新本子';
    try {
      const info = await pageOp('/api/notebook/new', { title, paper: $('#newNbPaper').value });
      $('#newNb').hidden = true;
      await loadNotebooks();
      await openNotebook(info.id, 0);
      toast(`已建立「${info.title}」`, 2000);
    } catch (e) { toast('没建成：' + e.message, 4000); }
  }

  // ------------------------------------------------------------ 导入：浏览电脑上对话所在的文件夹

  const FILE_ICON = (ext) => (/^\.(pptx?|odp)$/.test(ext) ? '📊' : /^\.(png|jpe?g|svg|gif|webp|bmp|tiff?)$/.test(ext) ? '🖼' : '📄');

  function whenText(ms) {
    const d = new Date(ms), now = new Date(), p2 = (n) => String(n).padStart(2, '0');
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = (day(now) - day(d)) / 86400000;
    if (diff === 0) return `今天 ${p2(d.getHours())}:${p2(d.getMinutes())}`;
    if (diff === 1) return '昨天';
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }

  async function openImport() {
    hideMenu();
    toggleDrawer(false);
    await refreshSessions();
    const sel = $('#isSession');
    sel.innerHTML = '';
    for (const s of S.sessions) { // 和「这本发往」同一套叫法：文件夹名，同一个文件夹开着几个对话时加上最近打的那句话的开头
      const o = document.createElement('option');
      o.value = s.sid;
      o.textContent = targetName(s);
      sel.appendChild(o);
    }
    const t = effectiveTarget();
    if (S.sessions.some((s) => s.sid === t)) sel.value = t;
    $('#importSheet').hidden = false;
    browseTo('');
    S.zView = null; // Zotero 一栏每次打开面板都重新读（导入过的标记可能变了）
    showImportTab(store.get('importTab', 'folder'));
  }

  function showImportTab(tab) {
    store.set('importTab', tab);
    document.querySelectorAll('#importSheet .is-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    $('#isFolder').hidden = tab !== 'folder';
    $('#isZotero').hidden = tab !== 'zotero';
    if (tab === 'zotero' && !S.zView) zoteroTo({ q: $('#zq').value.trim() });
  }

  async function browseTo(path) {
    const sid = $('#isSession').value, list = $('#isList'), crumbs = $('#isCrumbs');
    list.innerHTML = '';
    crumbs.innerHTML = '';
    if (!sid) { list.textContent = '没有连着的 Claude Code 对话。在电脑上的对话里执行一次 /ink，或者从 iPad 上传。'; return; }
    let d;
    try { d = await (await api(`/api/files?sid=${encodeURIComponent(sid)}&path=${encodeURIComponent(path)}`)).json(); } catch (e) {
      list.textContent = '打不开这个文件夹：' + e.message;
      return;
    }
    // 路径：根文件夹 › 子文件夹 …，每一级都能点回去
    const parts = d.path ? d.path.split('/') : [];
    const link = (text, p) => { const a = document.createElement('a'); a.textContent = text; a.addEventListener('click', () => browseTo(p)); return a; };
    crumbs.appendChild(link(d.rootName, ''));
    parts.forEach((name, k) => { crumbs.append(' › '); crumbs.appendChild(link(name, parts.slice(0, k + 1).join('/'))); });
    const head = (text) => { const h = document.createElement('div'); h.className = 'is-head'; h.textContent = text; list.appendChild(h); };
    if (d.recent && d.recent.length) {
      head('最近改过的');
      for (const e of d.recent) list.appendChild(importRow(e, true));
      head('文件夹里');
    }
    if (!d.entries.length) head('这里没有能导入的文件（PDF、PPT、Word、Markdown、图片）。');
    for (const e of d.entries) list.appendChild(importRow(e, false));
  }

  function importRow(e, showPath) {
    const row = document.createElement('div');
    row.className = 'is-item';
    const ico = document.createElement('span');
    ico.className = 'is-ico';
    ico.textContent = e.kind === 'dir' ? '📁' : FILE_ICON(e.ext);
    const nm = document.createElement('div');
    nm.className = 'is-name';
    nm.textContent = showPath ? e.path : e.name;
    row.append(ico, nm);
    if (e.kind === 'dir') {
      row.addEventListener('click', () => browseTo(e.path));
      return row;
    }
    const small = document.createElement('small');
    const size = e.size > 1048576 ? (e.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(e.size / 1024)) + ' KB';
    small.textContent = `${whenText(e.mtime)} · ${size}`;
    nm.appendChild(small);
    if (e.imported) {
      const b = document.createElement('span');
      b.className = 'is-badge' + (e.changed ? ' chg' : '');
      b.textContent = e.changed ? '原文件改过 · 点了更新' : '已导入 ›';
      row.appendChild(b);
      row.addEventListener('click', () => importFile(e));
    } else if (e.replace) {
      small.textContent += ` · 像是《${diffNames(e.name.replace(/\.[^.]+$/, ''), e.replace)[1]}》的新版`;
      const rep = document.createElement('button');
      rep.textContent = '替换旧版';
      rep.className = 'primary';
      rep.addEventListener('click', (ev) => { ev.stopPropagation(); importFile(e, 'replace'); });
      const add = document.createElement('button');
      add.textContent = '另加一本';
      add.addEventListener('click', (ev) => { ev.stopPropagation(); importFile(e, 'new'); });
      row.append(rep, add);
    } else {
      row.addEventListener('click', () => importFile(e));
    }
    return row;
  }

  // 导入时纸上的提示：一律「正在导入 X…」，真要先转换的（PPT、Word 等，用电脑上的 Office）才说要等
  const needsConvert = (name) => /\.(pptx?|docx?|odp|odt|rtf)$/i.test(name);
  const importingText = (name) => `正在导入 ${name}…` + (needsConvert(name) ? '（要先转换，稍等）' : '');

  async function importFile(e, mode) {
    $('#importSheet').hidden = true; // 先关面板：「正在导入」的提示在草稿纸上，面板开着会盖住它
    toast(e.imported && !e.changed ? `正在打开 ${e.name}…` : importingText(e.name), 180000); // 导入过、原文件没改：只是打开那本
    try {
      await flushSave();
      const res = await (await api('/api/files/import', { method: 'POST', body: JSON.stringify({ sid: $('#isSession').value, path: e.path, mode }),
        headers: { 'Content-Type': 'application/json' } })).json();
      await openImported(res);
    } catch (err) {
      toast('没导入成：' + err.message, 6000);
    }
  }

  async function openImported(res) {
    $('#importSheet').hidden = true;
    await loadNotebooks();
    await openNotebook(res.nb, res.page || 0);
    toast(res.updated ? updateMessage(res.title, res.prev, res.summary) : res.opened ? `已打开《${res.title}》` : `已导入《${res.title}》`, 4000);
  }

  // ------------------------------------------------------------ 导入：Zotero 里的文献（电脑上 Zotero 的本机接口）

  // v：{q 搜索词, coll 分类, start 从第几篇起}；more 为 true 时接在已列出的后面（「再显示 30 篇」）
  async function zoteroTo(v, more) {
    v = Object.assign({ q: '', coll: '', start: 0 }, v);
    S.zView = v;
    const list = $('#zList'), crumbs = $('#zCrumbs');
    if (!more) { list.textContent = '正在读 Zotero…'; crumbs.innerHTML = ''; }
    let d;
    try { d = await (await api(`/api/zotero?q=${encodeURIComponent(v.q)}&coll=${encodeURIComponent(v.coll)}&start=${v.start}`)).json(); } catch (e) {
      if (S.zView === v) list.textContent = e.message;
      return;
    }
    if (S.zView !== v) return; // 等的时候又搜了别的
    const head = (text) => { const h = document.createElement('div'); h.className = 'is-head'; h.textContent = text; list.appendChild(h); };
    if (!more) {
      list.innerHTML = '';
      const link = (text, to) => {
        const a = document.createElement('a');
        a.textContent = text;
        a.addEventListener('click', () => { $('#zq').value = ''; zoteroTo(to); });
        return a;
      };
      crumbs.appendChild(link('Zotero', {}));
      for (const c of d.path) { crumbs.append(' › '); crumbs.appendChild(link(c.name, { coll: c.key })); }
      if (v.q) crumbs.append(` › 搜索“${v.q}”`);
      const cols = document.createElement('div');
      for (const c of d.collections) cols.appendChild(zoteroDir(c));
      if (d.collections.length && v.coll) list.append(cols); // 分类里：子分类在前
      if (v.q) head(d.total ? `找到 ${d.total} 篇` : '没有找到');
      else if (!v.coll) head('最近添加');
      else if (!d.items.length) head('这个分类里没有文献');
      S.zItems = document.createElement('div');
      list.appendChild(S.zItems);
      if (d.collections.length && !v.coll) { head('分类'); list.append(cols); } // 首页：分类在最近添加后面
    }
    const old = list.querySelector('.is-more');
    if (old) old.remove();
    for (const e of d.items) S.zItems.appendChild(zoteroRow(e));
    if (d.items.length && d.start + d.items.length < d.total) {
      const b = document.createElement('button');
      b.className = 'is-more';
      b.textContent = `再显示 30 篇（共 ${d.total} 篇）`;
      b.addEventListener('click', () => zoteroTo(Object.assign({}, v, { start: v.start + 30 }), true));
      S.zItems.after(b);
    }
  }

  function zoteroDir(c) {
    const row = document.createElement('div');
    row.className = 'is-item';
    const ico = document.createElement('span');
    ico.className = 'is-ico';
    ico.textContent = '📁';
    const nm = document.createElement('div');
    nm.className = 'is-name';
    nm.textContent = c.name;
    row.append(ico, nm);
    row.addEventListener('click', () => { $('#zq').value = ''; zoteroTo({ coll: c.key }); });
    return row;
  }

  function zoteroRow(e) {
    const row = document.createElement('div');
    row.className = 'is-item' + (e.pdf ? '' : ' off');
    const ico = document.createElement('span');
    ico.className = 'is-ico';
    ico.textContent = '📄';
    const nm = document.createElement('div');
    nm.className = 'is-name';
    nm.textContent = e.title;
    const small = document.createElement('small');
    small.textContent = [e.creators, e.year, e.type].filter(Boolean).join(' · ') + (e.pdf ? '' : ' · 没有 PDF');
    nm.appendChild(small);
    row.append(ico, nm);
    if (e.imported) {
      const b = document.createElement('span');
      b.className = 'is-badge' + (e.changed ? ' chg' : '');
      b.textContent = e.changed ? '原文件改过 · 点了更新' : '已导入 ›';
      row.appendChild(b);
    }
    row.addEventListener('click', () => (e.pdf ? importZotero(e) : toast('这篇在 Zotero 里没有 PDF', 2500)));
    return row;
  }

  async function importZotero(e) {
    $('#importSheet').hidden = true; // 先关面板，提示才看得见
    toast(e.imported && !e.changed ? `正在打开《${e.title}》…` : `正在导入《${e.title}》…`, 180000);
    try {
      await flushSave();
      const res = await (await api('/api/zotero/import', { method: 'POST', body: JSON.stringify({ key: e.key }),
        headers: { 'Content-Type': 'application/json' } })).json();
      await openImported(res);
    } catch (err) {
      toast('没导入成：' + err.message, 6000);
    }
  }

  async function uploadPdf(file) {
    if (!file) return;
    $('#importSheet').hidden = true; // 先关面板，提示才看得见
    toast(importingText(file.name), 180000);
    try {
      const r = await api('/api/upload?name=' + encodeURIComponent(file.name), { method: 'POST', body: file });
      const { id } = await r.json();
      await loadNotebooks(id);
      await openNotebook(id, 0);
      toast('已打开', 1500);
    } catch (e) {
      toast('导入失败：' + e.message, 6000);
    }
  }

  // ------------------------------------------------------------ 整本发送、确认字迹

  // 整本交给 Claude：服务器把这本里有新笔迹的页（onlyNew）或写过字的页都画成图，一起投递；各页的 ✓/× 决定由服务器从存好的页面里带上
  async function sendAll(onlyNew) {
    if (!S.nb || S.sending || localBlocked() || targetGone(() => sendAll(onlyNew))) return;
    const nbId = S.nb.id;
    await flushSave();
    S.sending = true;
    updateCheck();
    try {
      const body = { nb: nbId, target: effectiveTarget() || '', only_new: onlyNew };
      const res = await (await api('/api/send-all', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })).json();
      startRound(res.id, nbId); // 「AI」按钮变成「已交」
      toast(`已把 ${res.pages} 页交给「${sentName(res)}」`, 3000);
    } catch (e) {
      if (e.status === 410 && (await refreshSessions(), targetGone(() => sendAll(onlyNew)))) return;
      toast('没发出去：' + e.message, 6000);
    } finally {
      S.sending = false;
      updateCheck();
    }
  }

  // 点「AI」：把上次交过之后写过的页交上去。只有这一页就整页交；别的页也有新写的，就一起交，不再问。
  // 这本只在本地：只提示，不发。上一轮还在走时也能再点（再交一次，按钮上显示新的这一轮）；只是交出去之前的这一小会儿不重复交
  async function check() {
    if (!S.page || S.sending || S.checking) return;
    if (localBlocked()) return;
    S.checking = true;
    try {
      const d = await newPages();
      if (d.others.length) return await sendAll(true);
      if (!S.page.strokes.some((s) => !s.erasedAt) && !(S.page.ai || []).length) { toast('这一页还没写字'); return; }
      return await send();
    } finally {
      S.checking = false;
    }
  }

  // ------------------------------------------------------------ 顶上的卡片：问话卡片、字迹确认卡片（2026-11-14，阶段 C）
  // 同一种卡片、排同一个队：Claude 用 ink_ask 发来的问题、结果，用 ink_confirm 问的字迹，按先后排，一次只显示一张，从屏幕顶上落下、居中。
  // 在卡片外的纸上落笔，卡片缩成顶上一小条（写着问的是什么、还有几张），点小条再展开；答了、点了「知道了」，这张消失，下一张落下。
  // 没答的记在电脑上（服务），刷新、重开页面还在；答过的平板上不留。

  async function loadCards() {
    const gen = ++S.qGen;
    // 两样各取各的：一样取不到（比如电脑上的服务还是没有问话卡片的旧版本）不连累另一样
    const list = (path) => api(path).then((r) => r.json()).then((v) => (Array.isArray(v) ? v : [])).catch(() => null);
    const [asks, confirms] = await Promise.all([list('/api/asks'), list('/api/confirms')]);
    if (!asks && !confirms) return; // 都没取到（连不上）：照旧显示手上的
    if (gen !== S.qGen) return; // 后发的那次已经回来了：这次的作废
    const keep = (kind) => S.cards.filter((c) => (kind === 'confirm' ? c.kind === 'confirm' : c.kind !== 'confirm')); // 这次没取到的那一样：先留着手上的
    S.cards = (asks || keep('ask')).concat(confirms ? confirms.map((c) => Object.assign({ kind: 'confirm' }, c)) : keep('confirm'))
      .filter((c) => !S.qDone.has(c.id)) // 刚在这里答掉的不再放回来（取列表的请求可能是答之前发出的）
      .sort((a, b) => (a.t || 0) - (b.t || 0));
    renderQ();
  }

  // 队首那一张：展开（卡片）或收着（小条）；换了一张才重新填内容（同一张不重填：写了一半的手写、输入框里的字不冲掉）。
  // 平板自己要问的一句（撤回修改前的确认，S.qLocal）排在最前面，答了才轮到服务发来的
  function renderQ() {
    const c = S.qLocal || S.cards[0] || null, box = $('#qcard'), bar = $('#qbar');
    if (!c) {
      box.hidden = true;
      bar.hidden = true;
      $('#qbarAll').hidden = true;
      S.qShown = null;
      S.qMin = false;
      S.qInk = null;
      markConfirmOnPage();
      return;
    }
    if (c === S.qLocal) S.qMin = false; // 平板自己问的一句不缩成小条（在纸上落笔就当「取消」）
    const fresh = S.qShown !== c.id, wasHidden = box.hidden;
    if (fresh) { fillQ(c); S.qShown = c.id; }
    box.hidden = S.qMin;
    bar.hidden = !S.qMin;
    fillQBar(c);
    updateQAll(c);
    placeQ();
    if (!S.qMin) {
      if (fresh || wasHidden) { box.classList.remove('qc-drop'); void box.offsetWidth; box.classList.add('qc-drop'); } // 从顶上落下来
      sizePads();
    }
    markConfirmOnPage();
  }

  function firstLine(s) { return (String(s || '').split(/\r?\n/).find((x) => x.trim()) || '').trim(); }

  // 「全部忽略（N 张）」：服务发来的卡片排着不止一张时，卡片底下左边和小条旁边各一个（N 是排着的张数）
  function updateQAll(c) {
    const n = S.cards.length, on = n > 1 && c && c !== S.qLocal, label = `全部忽略（${n} 张）`;
    const inCard = $('#qcAll');
    if (inCard) { inCard.hidden = !on; inCard.textContent = label; }
    const nearBar = $('#qbarAll');
    nearBar.hidden = !on || !S.qMin;
    nearBar.textContent = label;
  }

  // 忽略这一张问题卡片：不答了，这张消失、不算回答，下一张落下。Claude 还在等的会被告知用户忽略了；已经不等了的不往对话里送消息
  async function ignoreQ(c) {
    if (S.qBusy) return;
    S.qBusy = true;
    let gone = true;
    try {
      await api('/api/ask-ignore', { method: 'POST', body: JSON.stringify({ id: c.id }), headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      toast(e.message, 3000);
      gone = e.status === 404; // 别处已经答过、过期了：收走；连不上电脑：留着
    } finally {
      S.qBusy = false;
    }
    if (gone) dropQ(c.id);
  }

  // 全部忽略：一次清掉排着的所有卡片（不再问一句）：问题卡片按忽略算，字迹确认卡片按「看不清，跳过」算，结果卡片按点了「知道了」算
  async function ignoreAllQ() {
    if (S.qBusy || !S.cards.length) return;
    const ids = S.cards.map((x) => x.id);
    S.qBusy = true;
    try {
      await api('/api/cards/ignore-all', { method: 'POST', body: JSON.stringify({ ids }), headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      toast(e.message, 3000);
      S.qBusy = false;
      return;
    }
    S.qBusy = false;
    for (const id of ids) S.qDone.add(id);
    S.cards = S.cards.filter((x) => !ids.includes(x.id));
    S.qMin = false;
    renderQ();
    toast(`已忽略 ${ids.length} 张卡片`, 1800);
  }

  // 小条上的字：谁在问、问的开头（或结果的开头），还排着几张
  function fillQBar(c) {
    if (c.kind === 'local') { $('#qbarLead').textContent = c.head; $('#qbarText').textContent = ''; $('#qbarMore').textContent = ''; return; }
    const who = c.label || 'Claude', more = S.cards.length - 1;
    $('#qbarLead').textContent = c.kind === 'confirm' ? `${who} 想确认字迹` : c.kind === 'result' ? `${who} 的结果：` : `${who} 问：`;
    $('#qbarText').textContent = c.kind === 'confirm' ? '' : clip(firstLine(c.kind === 'result' ? c.text : c.question), 20);
    $('#qbarMore').textContent = more > 0 ? `还有 ${more} 张` : '';
  }

  function qButton(label, id, fn, primary) {
    const b = document.createElement('button');
    b.textContent = label;
    if (id) b.id = id;
    if (primary) b.className = 'primary';
    b.addEventListener('click', fn);
    return b;
  }

  // 卡片的内容：问题（问的话、选项、手写那一小块纸）、结果（一段话、「知道了」）、字迹确认（照旧）、平板自己问的一句（撤回前）。
  // 卡片底下左边：问题卡片有「忽略」（不答了，这张消失、不算回答）；排着不止一张时另有「全部忽略（N 张）」。
  // 和右上角的「稍后」（收成小条、卡片还在）分在两头，免得点混（2026-11-14 用户在 iPad 上试过后定）
  function fillQ(c) {
    const head = $('#qcHead'), body = $('#qcBody'), foot = $('#qcFoot'), who = c.label || 'Claude';
    body.textContent = '';
    foot.textContent = '';
    body.scrollTop = 0;
    S.qPad = [];
    S.qInk = null;
    S.confirmInputs = [];
    $('#qcard').dataset.kind = c.kind;
    $('#qcLater').hidden = c.kind === 'local';
    const left = document.createElement('span'); // 底下左边：忽略、全部忽略
    left.className = 'qc-left';
    const all = qButton('', 'qcAll', ignoreAllQ);
    all.className = 'qc-ign';
    all.hidden = true;
    if (c.kind === 'question') {
      const ign = qButton('忽略', 'qcIgnore', () => ignoreQ(c));
      ign.className = 'qc-ign';
      left.appendChild(ign);
    }
    if (c.kind !== 'local') left.appendChild(all);
    foot.appendChild(left);
    if (c.kind === 'local') { // 平板自己问的一句：界面的话，照常翻译；「取消」「撤回」
      head.textContent = c.head;
      const t = document.createElement('div');
      t.className = 'qc-local';
      for (const line of String(c.text || '').split('\n')) { const d = document.createElement('div'); d.textContent = line; t.appendChild(d); }
      body.appendChild(t);
      foot.append(qButton('取消', 'qcNo', () => c.done(false)), qButton(c.yes || '好', 'qcYes', () => c.done(true), true));
      return;
    }
    if (c.kind === 'confirm') { head.textContent = `${who} 想确认字迹`; fillConfirm(c, body, foot); return; }
    if (c.kind === 'result') {
      head.textContent = `${who} 的结果`;
      const t = document.createElement('div');
      t.className = 'qc-text';
      t.setAttribute('data-lang-keep', ''); // Claude 写的，不翻译
      fillText(t, c.text);
      body.appendChild(t);
      foot.appendChild(qButton('知道了', 'qcSeen', () => answerQ(c, {}), true));
      return;
    }
    head.textContent = `${who} 问你`;
    const mine = c.origin === 'server'; // 服务自己问的（改文件前问覆盖还是另存）：界面的话，英文界面跟着翻译；Claude 写的照原文
    const q = document.createElement('div');
    q.className = 'qc-q';
    if (!mine) q.setAttribute('data-lang-keep', '');
    fillText(q, c.question);
    body.appendChild(q);
    if (c.options.length) {
      const opts = document.createElement('div');
      opts.className = 'qc-opts';
      if (!mine) opts.setAttribute('data-lang-keep', ''); // Claude 写的选项，不翻译
      for (const o of c.options) {
        const b = document.createElement('button');
        b.textContent = o;
        // 点一个就是回答：那个按钮亮一下（白底加粗边框），随即交上去、卡片消失
        b.addEventListener('click', () => { if (S.qBusy) return; b.classList.add('on'); answerQ(c, { choice: o }); });
        opts.appendChild(b);
      }
      body.appendChild(opts);
    }
    if (c.write) {
      // 手写回答：卡片里一小块纸，用笔写（黑笔红笔都行，写出来都是黑字）；交的是这块纸上笔迹的图，不经过 iPad 的手写转文字
      const hint = document.createElement('div'), pad = document.createElement('canvas');
      hint.className = 'qc-padhint';
      hint.textContent = c.options.length ? '或者用笔写在下面' : '用笔写在下面';
      pad.className = 'qc-pad';
      pad.addEventListener('pointerdown', padDown);
      pad.addEventListener('pointermove', padMove);
      for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) pad.addEventListener(t, padUp);
      pad.addEventListener('touchmove', (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
      body.append(hint, pad);
      foot.append(qButton('重写', 'qcRedo', () => { S.qPad = []; S.qInk = null; drawPad(); }), qButton('交回答', 'qcSend', sendPad, true));
      updatePadBtns();
    }
  }

  // 答了这张（点了选项、交了手写、点了「知道了」）：交给电脑，这张消失，下一张落下来。
  // 交不上（连不上电脑）卡片留着可以再交；别处已经答过了、过期了（404）就收走
  async function answerQ(c, extra) {
    if (S.qBusy) return;
    S.qBusy = true;
    let gone = true;
    try {
      await Promise.all([
        api('/api/ask-answer', { method: 'POST', body: JSON.stringify(Object.assign({ id: c.id }, extra)), headers: { 'Content-Type': 'application/json' } }),
        new Promise((r) => setTimeout(r, extra.choice !== undefined ? 220 : 0)), // 点的那个选项亮一下再走
      ]);
      if (c.kind === 'question' && !S.cards.some((x) => x.id !== c.id)) toast('已告诉 Claude', 1500); // 后面还有卡片落下来时不说（提示条会压在它上面）
    } catch (e) {
      toast(e.message, 3000);
      gone = e.status === 404;
    } finally {
      S.qBusy = false;
    }
    if (!gone) {
      document.querySelectorAll('#qcBody .qc-opts button.on').forEach((b) => b.classList.remove('on'));
      return;
    }
    dropQ(c.id);
  }

  function dropQ(id) {
    S.qDone.add(id);
    S.cards = S.cards.filter((x) => x.id !== id);
    S.qMin = false; // 下一张落下来
    renderQ();
  }

  // 缩成顶上一小条（在纸上落笔、点「稍后」）；点小条再展开。平板自己问的一句不缩
  function minQ() {
    if (!S.cards.length || S.qMin || S.qLocal) return;
    S.qMin = true;
    renderQ();
  }
  function expandQ() {
    if (!S.cards.length) return;
    S.qMin = false;
    renderQ();
  }

  // 卡片和小条的上沿：左上角那一排（全屏）、顶栏（退出全屏）、右上角的提示条、出问题时那一句、挪到屏幕上部的右下角那一条，都让开，排在它们下面；
  // 卡片最低到右下角那一条（左右和卡片有重叠时）上面为止，多了在卡片里滑。全屏时屏幕最顶上那一条归 Safari，不放东西（TOP_SAFE）
  function placeQ() {
    const box = $('#qcard'), bar = $('#qbar');
    if (box.hidden && bar.hidden) return;
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    const w = Math.min(560, vw - 32), L = (vw - w) / 2, R = L + w;
    let top = TOP_SAFE + 8, bottom = vh - 12;
    for (const sel of ['#chipRow', '#bar', '#verchip', '#trouble', '#tools']) {
      const e = $(sel);
      if (!e || e.hidden || !e.getClientRects().length) continue;
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (r.top < vh / 3) top = Math.max(top, r.bottom + 8);
      else if (r.right > L && r.left < R) bottom = Math.min(bottom, r.top - 8);
    }
    box.style.top = bar.style.top = `${Math.round(top)}px`;
    box.style.maxHeight = `${Math.max(160, Math.round(bottom - top))}px`;
    // 小条旁边的「全部忽略（N 张）」：紧挨着小条的右边，放不下就排在小条下面（不放进小条里：点小条是展开）
    const all = $('#qbarAll');
    if (!all.hidden && !bar.hidden) {
      const r = bar.getBoundingClientRect(), aw = all.offsetWidth;
      if (r.right + 8 + aw <= vw - 8) Object.assign(all.style, { left: `${Math.round(r.right + 8)}px`, top: `${Math.round(r.top + (r.height - all.offsetHeight) / 2)}px` });
      else Object.assign(all.style, { left: `${Math.round(Math.max(8, r.right - aw))}px`, top: `${Math.round(r.bottom + 6)}px` });
    }
  }

  // -- 手写回答那一小块纸：笔写（「手指也能书写」时手指也写），坐标是这块纸上的屏幕像素
  function sizePads() {
    const pad = $('#qcBody .qc-pad');
    if (!pad || !pad.clientWidth) return;
    const dpr = window.devicePixelRatio || 1, w = Math.round(pad.clientWidth * dpr), h = Math.round(pad.clientHeight * dpr);
    if (pad.width !== w || pad.height !== h) { pad.width = w; pad.height = h; }
    drawPad();
  }
  function padStrokes(x, list) {
    x.strokeStyle = INK;
    x.fillStyle = INK;
    x.lineWidth = 2.6;
    x.lineCap = 'round';
    x.lineJoin = 'round';
    for (const p of list) {
      x.beginPath();
      if (p.length === 1) { x.arc(p[0][0], p[0][1], 1.6, 0, Math.PI * 2); x.fill(); continue; }
      x.moveTo(p[0][0], p[0][1]);
      for (let i = 1; i < p.length; i++) x.lineTo(p[i][0], p[i][1]);
      x.stroke();
    }
  }
  function drawPad() {
    const pad = $('#qcBody .qc-pad');
    if (!pad) return;
    const x = pad.getContext('2d'), k = pad.width / Math.max(1, pad.clientWidth);
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.clearRect(0, 0, pad.width, pad.height);
    x.setTransform(k, 0, 0, k, 0, 0);
    padStrokes(x, S.qInk ? S.qPad.concat([S.qInk.pts]) : S.qPad);
    updatePadBtns();
  }
  function updatePadBtns() {
    for (const id of ['#qcSend', '#qcRedo']) { const b = $(id); if (b) b.disabled = !S.qPad.length; }
  }
  function padDown(e) {
    const pad = e.currentTarget;
    e.preventDefault();
    if (e.pointerType === 'touch' && !S.fingerDraw) return; // 手指（多半是搭着的手掌、手环）不写
    if (e.pointerType === 'pen') S.penAt = performance.now();
    if (S.qInk) { S.qPad.push(S.qInk.pts); S.qInk = null; } // 上一笔的抬笔没到：先收好
    sizePads();
    try { pad.setPointerCapture(e.pointerId); } catch (err) { /* 有些浏览器不支持 */ }
    const r = pad.getBoundingClientRect();
    S.qInk = { pid: e.pointerId, pts: [[r1(e.clientX - r.left), r1(e.clientY - r.top)]] };
    drawPad();
  }
  function padMove(e) {
    const st = S.qInk;
    if (!st || e.pointerId !== st.pid) return;
    const r = e.currentTarget.getBoundingClientRect(), evs = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
    for (const ev of evs.length ? evs : [e]) {
      const p = [r1(ev.clientX - r.left), r1(ev.clientY - r.top)], last = st.pts[st.pts.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= 0.5) st.pts.push(p);
    }
    drawPad();
  }
  function padUp(e) {
    const st = S.qInk;
    if (!st || e.pointerId !== st.pid) return;
    if (e.pointerType === 'pen') S.penAt = performance.now();
    S.qInk = null;
    S.qPad.push(st.pts);
    drawPad();
  }
  // 交手写回答：这块纸上的笔迹画成白底 PNG（两倍大）交上去
  function sendPad() {
    const c = S.cards[0], pad = $('#qcBody .qc-pad');
    if (!c || !pad || !S.qPad.length) return;
    const k = 2, cv = document.createElement('canvas');
    cv.width = Math.round((pad.clientWidth || 500) * k);
    cv.height = Math.round((pad.clientHeight || 140) * k);
    const x = cv.getContext('2d');
    x.fillStyle = '#fff';
    x.fillRect(0, 0, cv.width, cv.height);
    x.setTransform(k, 0, 0, k, 0, 0);
    padStrokes(x, S.qPad);
    answerQ(c, { image: cv.toDataURL('image/png') });
  }

  // 字迹确认卡片的内容（和以前一样）：哪一页（不是当前页就有「翻到那页」）、每处问的话、截图、候选、更正框（iPad 把手写转成文字）
  function fillConfirm(c, body, foot) {
    const onPage = S.nb && S.nb.id === c.nb && S.idx === c.page;
    const where = document.createElement('div');
    where.className = 'q';
    where.textContent = c.where;
    if (!onPage) {
      const go = document.createElement('button');
      go.textContent = '翻到那页';
      go.style.marginLeft = '8px';
      go.addEventListener('click', () => openNotebook(c.nb, c.page));
      where.appendChild(go);
    }
    body.appendChild(where);
    c.questions.forEach((q, k) => {
      const row = document.createElement('div');
      row.className = 'cq';
      const t = document.createElement('div');
      t.className = 'q';
      t.textContent = `${c.questions.length > 1 ? k + 1 + '. ' : ''}${q.question}`;
      row.appendChild(t);
      if (q.img) {
        const img = document.createElement('img');
        if (q.iw && q.ih) { // 先按截图的大小留好位置（最高 200）：图后到时卡片不跳高、按钮不挪
          img.style.width = `min(100%, ${Math.round(Math.min(q.iw, (200 * q.iw) / q.ih))}px)`;
          img.style.aspectRatio = `${q.iw} / ${q.ih}`;
        }
        api(`/api/confirm-img?id=${c.id}&k=${k}`).then((r) => r.blob()).then((b) => { img.src = URL.createObjectURL(b); }).catch(() => img.remove());
        row.appendChild(img);
      }
      const input = document.createElement('input');
      input.placeholder = q.options.length ? '都不对就在这里写（可以用笔直接写）' : '在这里写（可以用笔直接写）';
      input.setAttribute('autocomplete', 'off');
      if (q.options.length) {
        const opts = document.createElement('div');
        opts.className = 'opts';
        for (const o of q.options) {
          const b = document.createElement('button');
          b.textContent = o;
          b.addEventListener('click', () => {
            input.value = o;
            opts.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
            updateConfirmOk();
          });
          opts.appendChild(b);
        }
        input.addEventListener('input', () => {
          opts.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.textContent === input.value));
        });
        row.appendChild(opts);
      }
      input.addEventListener('input', updateConfirmOk);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') answerConfirm(); });
      row.appendChild(input);
      S.confirmInputs.push(input);
      body.appendChild(row);
    });
    foot.appendChild(qButton('回答', 'confirmOk', answerConfirm, true));
    updateConfirmOk();
  }

  function updateConfirmOk() {
    const any = (S.confirmInputs || []).some((i) => i.value.trim()), ok = $('#confirmOk');
    if (ok) ok.textContent = any ? '回答' : '看不清，跳过';
  }

  async function answerConfirm() {
    const c = S.cards[0];
    if (!c || c.kind !== 'confirm' || S.qBusy) return;
    const answers = S.confirmInputs.map((i) => ({ text: i.value.trim() }));
    S.qBusy = true;
    try {
      await api('/api/confirm-answer', { method: 'POST', body: JSON.stringify({ id: c.id, answers }), headers: { 'Content-Type': 'application/json' } });
      if (!S.cards.some((x) => x.id !== c.id)) toast('已告诉 Claude', 1500); // 后面还有卡片落下来时不说
    } catch (e) {
      toast(e.message, 3000);
      if (e.status !== 404) return; // 交不上（连不上电脑）：卡片留着可以再交；别处答过、过期了就收走
    } finally {
      S.qBusy = false;
    }
    dropQ(c.id);
  }

  // 字迹确认卡片问的那几处，在页面上用闪动的框标出来（卡片展开、问的就是这一页时）
  function markConfirmOnPage() {
    const old = aiRoot.querySelector('.confirm-marks');
    if (old) old.remove();
    const c = (S.cards || [])[0];
    if (!c || S.qLocal || c.kind !== 'confirm' || S.qMin || !S.nb || S.nb.id !== c.nb || S.idx !== c.page) return;
    const g = el('g', { class: 'ai-temp confirm-marks' }, aiRoot);
    for (const q of c.questions) {
      if (!q.bbox) continue;
      const b = q.bbox;
      el('rect', { x: f1(b[0] - 8), y: f1(b[1] - 8), width: f1(b[2] - b[0] + 16), height: f1(b[3] - b[1] + 16), rx: 8, class: 'confirm-mark' }, g);
    }
  }

  // ------------------------------------------------------------ 界面

  let toastTimer = null;
  function toast(msg, ms, actionLabel, action) {
    const t = $('#toast');
    t.innerHTML = '';
    t.appendChild(document.createTextNode(msg));
    if (actionLabel) {
      const b = document.createElement('button');
      b.textContent = actionLabel;
      b.addEventListener('click', () => { t.hidden = true; action(); });
      t.appendChild(b);
    }
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms || 2500);
  }

  // 记下保存状态（saveState）；出问题时顶上那一句跟着亮起、收起（见 troubleText）。这一轮到哪一步写在「AI」按钮上（见 updateCheck）
  function updateStatus(saveState) {
    if (saveState) S.saveState = saveState;
    const tr = $('#trouble'), msg = troubleText();
    const was = tr.hidden;
    tr.textContent = msg;
    tr.hidden = !msg;
    if (was !== tr.hidden) placeQ(); // 出问题时那一句出来、收起：顶上的卡片跟着让开
  }

  function setTool(t) {
    S.tool = t;
    document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
  }

  function hideMenu() { $('#menu').hidden = true; }

  function showLocked() {
    $('#locked').hidden = false;
    $('#codeInput').value = CODE || '';
  }

  function bindUI() {
    document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
    $('#undo').addEventListener('click', undo);
    // 右下角一条、左上角的本子名、顶栏上的「AI」
    $('#toolsUndo').addEventListener('click', undo);
    $('#check').addEventListener('click', () => check());
    $('#barCheck').addEventListener('click', () => check());
    $('#chipPrev').addEventListener('click', (e) => { e.stopPropagation(); if (S.idx > 0) openPage(S.idx - 1); });
    $('#chipNext').addEventListener('click', (e) => { e.stopPropagation(); if (S.nb && S.idx < S.nb.pages - 1) openPage(S.idx + 1); });
    // 连续 / 单页（每本记在电脑上）：抽屉里那组开关、左上角和顶栏上的一对图标是同一个状态；点哪个就是哪个，点已选中的不变
    const pickFlow = (e) => { const b = e.target.closest && e.target.closest('button[data-v]'); if (b && (b.dataset.v === 'flow') !== S.flow) toggleFlow(); };
    $('#chipPair').addEventListener('click', (e) => { e.stopPropagation(); pickFlow(e); });
    $('#barPair').addEventListener('click', pickFlow);
    // 加页图标（左上角、顶栏上各一个）：在这一页后面加一张同方向的空白页，翻过去
    for (const id of ['#chipAdd', '#barAdd']) $(id).addEventListener('click', (e) => { e.stopPropagation(); addPageLikeThis(); });
    // 抽屉最上面的两组开关：连续 / 单页、适配宽度 / 整页
    $('#segFlow').addEventListener('click', pickFlow);
    $('#segFit').addEventListener('click', (e) => { const v = e.target.dataset.v; if (v) { fit(v); updateSegs(); } });
    // 全屏和退出全屏各有自己的按钮（记在这台设备上）：全屏时在右下角那一条上点「退出全屏」，退出后在左侧工具栏最下面点「全屏」
    $('#toolsBars').addEventListener('click', exitFullscreen);
    $('#fsBtn').addEventListener('click', enterFullscreen);
    $('#nbChip').addEventListener('click', (e) => { e.stopPropagation(); toggleDrawer(); });
    $('#actTarget').addEventListener('click', (e) => { e.stopPropagation(); openTargetPick(); });
    $('#targetPickCancel').addEventListener('click', () => { $('#targetPick').hidden = true; });
    $('#prev').addEventListener('click', () => S.idx > 0 && openPage(S.idx - 1));
    $('#next').addEventListener('click', () => S.nb && S.idx < S.nb.pages - 1 && openPage(S.idx + 1));
    $('#drawerBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleDrawer(); });
    $('#nbTitle').addEventListener('click', (e) => { e.stopPropagation(); toggleDrawer(); });
    $('#actAddPortrait').addEventListener('click', () => addPageAfter('portrait'));
    $('#actAddLandscape').addEventListener('click', () => addPageAfter('landscape'));
    for (const [id, dir] of [['#extDown', 'down'], ['#extRight', 'right'], ['#extUp', 'up'], ['#extLeft', 'left']]) {
      // 按钮在舞台里面：拦下 pointerdown，免得同时落下一笔
      $(id).addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); extendPage(dir); });
    }
    document.addEventListener('fullscreenchange', syncFullscreen);
    document.addEventListener('webkitfullscreenchange', syncFullscreen);
    initToolsBar();
    $('#actTurnL').addEventListener('click', () => rotatePage(-1));
    $('#actTurnR').addEventListener('click', () => rotatePage(1));
    $('#actDelPage').addEventListener('click', deletePage);
    $('#actHidden').addEventListener('click', showHidden);
    $('#actNewNb').addEventListener('click', openNewNotebook);
    $('#actNewFolder').addEventListener('click', () => newFolder(null));
    $('#nameAskCancel').addEventListener('click', () => answerName(false));
    $('#nameAskOk').addEventListener('click', () => answerName(true));
    $('#nameAskInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); answerName(true); } else if (e.key === 'Escape') answerName(false);
    });
    $('#folderPickCancel').addEventListener('click', closeFolderPick);
    $('#newNbCancel').addEventListener('click', () => { $('#newNb').hidden = true; });
    $('#newNbOk').addEventListener('click', createNotebook);
    $('#menuBtn').addEventListener('click', (e) => { e.stopPropagation(); $('#menu').hidden = !$('#menu').hidden; });
    const opt = (id, key, prop, after) => {
      const c = $(id);
      c.checked = S[prop];
      c.addEventListener('change', () => { S[prop] = c.checked; store.set(key, c.checked); if (after) after(); });
    };
    opt('#optAi', 'aiv', 'aiVisible', renderAI);
    opt('#optFinger', 'finger', 'fingerDraw');
    // 顶上的卡片：「稍后」缩成顶上一小条，点小条再展开
    $('#qcLater').addEventListener('click', minQ);
    $('#qbar').addEventListener('click', expandQ);
    $('#qbarAll').addEventListener('click', ignoreAllQ); // 小条旁边的「全部忽略（N 张）」
    // 右上角的提示条：原文件改过了（点一下更新），或这一页更新时改过（对比旧版 / 回到新版）
    $('#verAct').addEventListener('click', () => {
      if ($('#verchip').dataset.kind === 'source') updateBook();
      else toggleCompare();
    });
    $('#verUndo').addEventListener('click', () => undoEdit()); // 撤回这次修改（先在顶上问一句）
    // 提示条变宽变窄（英文界面在填好字之后才换成英文、按钮多一个少一个）：重新量它放哪，顶上的卡片跟着让开
    if (window.ResizeObserver) new ResizeObserver(() => { placeVer(); placeQ(); }).observe($('#verchip'));
    $('#verClose').addEventListener('click', () => {
      S.verHidden[verKey($('#verchip').dataset.kind)] = true;
      if (S.compare) toggleCompare();
      markChanges();
      updateVerChip();
    });
    $('#actReplay').addEventListener('click', () => { hideMenu(); replay(); });
    $('#actFit').addEventListener('click', () => { hideMenu(); fit(S.fitMode === 'width' ? 'page' : 'width'); });
    $('#actClearAi').addEventListener('click', () => {
      hideMenu();
      if (!S.page || !S.page.ai.length) return;
      if (!confirm('清除本页所有 Claude 批注？（笔迹不受影响）')) return;
      S.page.ai = [];
      renderAI();
      markDirty();
    });
    $('#actUpload').addEventListener('click', openImport);
    $('#isUpload').addEventListener('click', () => { $('#importSheet').hidden = true; $('#pdfFile').click(); });
    $('#isClose').addEventListener('click', () => { $('#importSheet').hidden = true; });
    document.querySelectorAll('#importSheet .is-tabs button').forEach((b) => b.addEventListener('click', () => showImportTab(b.dataset.tab)));
    $('#zq').addEventListener('input', () => { // 停手 0.4 秒再搜
      clearTimeout(S.zqTimer);
      S.zqTimer = setTimeout(() => zoteroTo({ q: $('#zq').value.trim() }), 400);
    });
    $('#zq').addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(S.zqTimer); zoteroTo({ q: $('#zq').value.trim() }); } });
    $('#isSession').addEventListener('change', () => browseTo(''));

    $('#pdfFile').addEventListener('change', (e) => { uploadPdf(e.target.files[0]); e.target.value = ''; });
    $('#codeOk').addEventListener('click', () => {
      CODE = $('#codeInput').value.trim();
      store.set('k', CODE);
      store.set('device', ''); // 用新输入的访问码重新配对
      const u = new URL(location.href); // 地址里带着旧访问码（比如主屏幕图标的地址）：换成新的，免得刷新后又用旧的
      if (u.searchParams.has('k')) u.searchParams.set('k', CODE);
      location.replace(u.toString());
    });
    // 长回答的卡片：笔、橡皮、手指在卡片里（见 cardDown）
    const cardEl = $('#answerCard');
    cardEl.addEventListener('pointerdown', cardDown);
    cardEl.addEventListener('pointermove', cardMove);
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) cardEl.addEventListener(t, cardUp);
    cardEl.addEventListener('touchmove', (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false }); // 滑卡片由 cardMove 做，不让系统再滑页面
    document.addEventListener('pointerdown', (e) => {
      // 长回答的卡片开着，这一下落在卡片外：笔（电脑上是鼠标）落下就收起，那一笔照常写在纸上。
      // 手指落在纸上不马上收：轻点（touchUp）或挪纸、缩放（touchMove）时才收——搭在纸上不动的手掌、手环不收（用户写字的手上戴手环）。
      // 笔刚用过、笔正在卡片上写时落下的手指是手掌，哪里都不收。点工具条（换笔、橡皮、撤销、AI）不收：换了红笔、橡皮接着在卡片上用
      if (S.card && !cardEl.contains(e.target) && !$('#tools').contains(e.target) && !$('#rail').contains(e.target)) {
        const finger = e.pointerType === 'touch' && !S.fingerDraw;
        if (!finger) closeCard();
        else if (!stage.contains(e.target) && !penJustUsed() && !S.cardInk && !S.cardErase) closeCard();
      }
      // 顶上的卡片展开着，笔（电脑上是鼠标；「手指也能书写」时也算手指）落在纸上：卡片缩成顶上一小条，这一笔照常写上。
      // 挪纸的手指、搭着的手掌和手环不算
      // 平板自己问的一句（撤回前的确认）开着时在纸上落笔：当作「取消」
      if (stage.contains(e.target) && (e.pointerType !== 'touch' || S.fingerDraw)) {
        if (S.qLocal) S.qLocal.done(false);
        else if (S.cards.length && !S.qMin) minQ();
      }
      if (!$('#menu').contains(e.target) && e.target !== $('#menuBtn')) hideMenu();
      if (!$('#targetPick').hidden && !$('#targetPick').contains(e.target)) $('#targetPick').hidden = true;
      if (!$('#folderPick').hidden && !$('#folderPick').contains(e.target)) closeFolderPick();
      // 点纸面（或别处）收起抽屉（从抽屉里点开的小列表、起名字的卡片不算别处）
      if (!$('#drawer').hidden && !$('#drawer').contains(e.target)
        && e.target !== $('#drawerBtn') && e.target !== $('#nbTitle') && !$('#nbChip').contains(e.target)
        && !$('#targetPick').contains(e.target) && !$('#folderPick').contains(e.target) && !$('#nameAsk').contains(e.target)) toggleDrawer(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); } else if (e.key === 'p') setTool('pen');
      else if (e.key === 'r') setTool('red');
      else if (e.key === 'e') setTool('eraser');
      else if (e.key === 'Enter') check();
      else if (e.key === 'Escape' && S.card) closeCard();
      else if (e.key === 'Escape' && !$('#drawer').hidden) toggleDrawer(false);
    });
    window.addEventListener('resize', () => { closeCard(); resize(); }); // 转动 iPad、窗口变化：卡片收起，重新量、重新摆
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') { resetInput(); flushSave(); return; }
      processPending();
      refreshBookInfo(); // 回到前台：原文件在电脑上改过了没有（以前要重新打开这本才提示）、还能不能撤回
    });
    window.addEventListener('pagehide', flushSave);
  }

  async function init() {
    applyIcons(document);
    initLongPress();
    bindUI();
    document.body.classList.toggle('collapsed', S.collapsed);
    resize();
    fitCheckWidth(); // 「AI」按钮按最长的那几个字定宽：要在摆右下角那一条之前
    restoreRounds(); // 刷新前交的、还没走完的那一轮
    placeTools(); // 右下角那一条这时才显示出来：摆回拖到过的位置
    try { await document.fonts.load(`${NOTE_FS}px Xiaolai`); } catch (e) { /* 用系统字体 */ }
    if (!TOKEN && !CODE) { showLocked(); return; }
    if (!TOKEN) {
      try {
        const ua = navigator.userAgent, pad = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
        const name = (pad ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : '电脑浏览器')
          + (navigator.standalone || matchMedia('(display-mode: standalone)').matches ? '（主屏幕）' : '');
        const d = await (await api('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })).json();
        TOKEN = d.token;
        store.set('device', TOKEN);
        store.set('k', ''); // 访问码不留在平板上：断开这台设备后，它就进不来了
        CODE = '';
      } catch (e) {
        if (e.message !== '访问码不对') toast('连不上电脑上的服务：' + e.message, 8000);
        return;
      }
    }
    try {
      S.cfg = await (await api('/api/config')).json();
    } catch (e) {
      if (e.message !== '访问码不对') toast('连不上电脑上的服务：' + e.message, 8000);
      return;
    }
    $('#actUpload').hidden = !S.cfg.pdf;
    S.online = true;
    await refreshSessions();
    const pos = store.get('pos', { nb: 'scratch', i: 0 });
    const list = await loadNotebooks(pos.nb);
    const start = list.some((n) => n.id === pos.nb) ? pos : { nb: 'scratch', i: 0 };
    await openNotebook(start.nb, start.i);
    eventsLoop();
    setInterval(() => { if (S.saveTryAt) updateStatus(); }, 3000); // 有字一直没存上时，过几秒把提示亮出来（见 troubleText）
    loadCards();
  }

  // 方便自动化测试
  window.__ink = { S, check, send, sendAll, computeGroups, openPage, openNotebook, replay, processPending, loadCards, tapAiItem, inkStrokes, flowStrip, toggleFlow, setVerdict, undo, renderAI,
    openCard, closeCard, neighborOnScreen, loadNotebooks, cardItem };

  init();
})();
