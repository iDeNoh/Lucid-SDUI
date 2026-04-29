'use strict';

// ===== Logger =====

const Log = (() => {
  const entries = [];
  let errCount  = 0;

  const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

  function add(level, category, message, detail) {
    const ts  = new Date();
    const pad = n => String(n).padStart(2, '0');
    const time = `${pad(ts.getHours())}:${pad(ts.getMinutes())}:${pad(ts.getSeconds())}.${String(ts.getMilliseconds()).padStart(3,'0')}`;
    const entry = { time, level, category, message, detail: detail ?? null };
    entries.push(entry);
    if (level === 'error' || level === 'warn') {
      errCount++;
      _updateBadge();
    }
    _appendToDOM(entry);
  }

  function _updateBadge() {
    const badge = document.getElementById('log-err-count');
    if (!badge) return;
    badge.textContent = errCount;
    badge.style.display = errCount > 0 ? 'inline' : 'none';
  }

  function _appendToDOM(entry) {
    const container = document.getElementById('log-entries');
    if (!container) return;
    const row = document.createElement('div');
    row.className = `log-row log-${entry.level}`;
    row.innerHTML = `<span class="log-time">${entry.time}</span>` +
                    `<span class="log-level">${entry.level.toUpperCase()}</span>` +
                    `<span class="log-cat">[${entry.category}]</span>` +
                    `<span class="log-msg">${escHtml(entry.message)}</span>` +
                    (entry.detail ? `<div class="log-detail">${escHtml(String(entry.detail))}</div>` : '');
    container.appendChild(row);
    container.scrollTop = container.scrollHeight;
  }

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function download() {
    const lines = entries.map(e =>
      `${e.time} ${e.level.toUpperCase().padEnd(5)} [${e.category}] ${e.message}` +
      (e.detail ? `\n       ${e.detail}` : '')
    );
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = `sdnext-ui-${new Date().toISOString().replace(/[:.]/g,'-').slice(0,19)}.log`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function clear() {
    entries.length = 0;
    errCount = 0;
    _updateBadge();
    const c = document.getElementById('log-entries');
    if (c) c.innerHTML = '';
  }

  function rebuild() {
    const c = document.getElementById('log-entries');
    if (!c) return;
    c.innerHTML = '';
    entries.forEach(e => _appendToDOM(e));
  }

  return {
    debug: (cat, msg, detail) => add('debug', cat, msg, detail),
    info:  (cat, msg, detail) => add('info',  cat, msg, detail),
    warn:  (cat, msg, detail) => add('warn',  cat, msg, detail),
    error: (cat, msg, detail) => add('error', cat, msg, detail),
    download,
    clear,
    rebuild,
    get count() { return entries.length; },
  };
})();

// Capture unhandled JS errors
window.addEventListener('error', e => {
  Log.error('JS', e.message, `${e.filename}:${e.lineno}`);
});
window.addEventListener('unhandledrejection', e => {
  Log.error('Promise', String(e.reason));
});

// ===== API client =====

// When served via any HTTP server (including LAN access), use relative URLs
// so the proxy on serve.py handles forwarding to SDNext — no CORS issues.
// Only fall back to a direct URL when opened as a local file (file://).
function resolveBase(_url) {
  return window.location.protocol === 'file:' ? 'http://localhost:7860' : '';
}

class SDNextAPI {
  constructor(base = 'http://localhost:7860') {
    this.base = resolveBase(base);
  }

  setBase(url) { this.base = resolveBase(url); }

  async _fetch(method, path, body, signal) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    if (signal) opts.signal = signal;
    const t0  = performance.now();
    const url = this.base + path;
    Log.debug('API', `${method} ${path}`);
    let res;
    try {
      res = await fetch(url, opts);
    } catch (netErr) {
      if (netErr.name === 'AbortError') throw netErr;  // propagate silently
      Log.error('API', `${method} ${path} — network error`, netErr.message);
      throw netErr;
    }
    const ms = Math.round(performance.now() - t0);
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      const msg = `${method} ${path} → ${res.status} (${ms}ms)`;
      Log.error('API', msg, txt.slice(0, 300));
      throw new Error(`${msg}${txt ? ': ' + txt.slice(0, 200) : ''}`);
    }
    if (!signal || res.status !== 200) Log.info('API', `${method} ${path} → ${res.status} (${ms}ms)`);
    return res.json();
  }

  get(path)          { return this._fetch('GET',  path); }
  post(path, body)   { return this._fetch('POST', path, body); }

  getModels()    { return this.get('/sdapi/v1/sd-models'); }
  getSamplers()  { return this.get('/sdapi/v1/samplers'); }
  getVAEs()      { return this.get('/sdapi/v1/sd-vae'); }
  getLoras()     { return this.get('/sdapi/v1/loras'); }
  getOptions()   { return this.get('/sdapi/v1/options'); }
  getProgress(signal) { return this._fetch('GET', '/sdapi/v1/progress?skip_current_image=false', undefined, signal); }
  getUpscalers()  { return this.get('/sdapi/v1/upscalers'); }
  getDetailers()  { return this.get('/sdapi/v1/detailers'); }

  setOptions(opts)      { return this.post('/sdapi/v1/options', opts); }
  setCheckpoint(name)   { return this.post(`/sdapi/v1/checkpoint?sd_model_checkpoint=${encodeURIComponent(name)}`); }
  interrupt()           { return this.post('/sdapi/v1/interrupt', {}); }
  skip()                { return this.post('/sdapi/v1/skip', {}); }
  txt2img(p)            { return this.post('/sdapi/v1/txt2img', p); }
  img2img(p)            { return this.post('/sdapi/v1/img2img', p); }
  pngInfo(b64)          { return this.post('/sdapi/v1/png-info', { image: b64 }); }
  extraSingle(p)        { return this.post('/sdapi/v1/extra-single-image', p); }
  enhancePrompt(prompt, type = 'text') { return this.post('/sdapi/v1/prompt-enhance', { prompt, type }); }
  caption(b64)          { return this.post('/sdapi/v1/openclip', { image: b64 }); }
  tagImage(b64, model)  { return this.post('/sdapi/v1/tagger', { image: b64, model: model || '' }); }
  getTaggerModels()     { return this.get('/sdapi/v1/tagger/models'); }

  async ping() {
    const r = await fetch(this.base + '/sdapi/v1/status');
    return r.ok;
  }
}

// ===== State =====

const api = new SDNextAPI();

const state = {
  connected:    false,
  generating:   false,
  lastSeed:     -1,
  lastInfo:     {},
  progressTimer:  null,
  progressAbort:  null,
  currentTab:   'txt2img',
  initImages: { i2i: null, vid: null, upscale: null, caption: null },
  allLoras:   [],
  animTimer:  null,
  animFrames: [],
  animIdx:    0,
  genHistory: [],
  mediaData:    {},
  mediaFilter:  'all',
  mediaEntries: [],
  mediaIndex:   0,
  lightboxB64:  null,
  looping:      false,
};

// ===== Modal zoom/pan state =====
let modalZoom      = 1;
let modalPan       = { x: 0, y: 0 };
let modalDragging  = false;
let modalDragOrig  = null;   // { x: clientX - pan.x, y: clientY - pan.y }
let modalTouchStart = null;  // { x, y } at single-touch start
let modalPan0      = null;   // pan snapshot at touch/drag start
let modalTouchMoved = false;
let modalPinchDist0 = 0;
let modalZoom0     = 1;

// ===== Generation History =====

const HISTORY_KEY  = 'sdnext-ui-history';
const HISTORY_MAX  = 30;
const SAVE_KEY     = 'sdnext-ui-save';

function loadHistory() {
  try { state.genHistory = JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; }
  catch { state.genHistory = []; }
}

function saveHistory(entry) {
  state.genHistory.unshift(entry);
  if (state.genHistory.length > HISTORY_MAX) state.genHistory.length = HISTORY_MAX;
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(state.genHistory)); } catch {}
}

function recordGenHistory(tab, params, result) {
  const images = result.images || [];
  if (!images.length) return;
  const info = parseInfo(result.info);
  const entry = {
    id:     Date.now(),
    ts:     new Date().toLocaleString(),
    tab,
    params: { ...params, init_images: undefined },  // strip base64
    thumb:  images[0],
    seed:   info.seed ?? -1,
  };
  delete entry.params.init_images;
  saveHistory(entry);
}

// ===== Save to disk =====

async function saveImageToDisk(b64, type) {
  try {
    await fetch('/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, image: b64 }),
    });
  } catch (e) {
    Log.warn('Save', 'Could not save image to disk', e.message);
  }
}

// ===== DOM helpers =====

const $  = id  => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

function setStatus(connected, label) {
  state.connected = connected;
  const dot  = $('status-dot');
  const text = $('status-text');
  dot.className  = 'status-dot ' + (connected ? 'connected' : 'disconnected');
  dot.title      = label || (connected ? 'Connected' : 'Disconnected');
  text.textContent = label || (connected ? 'Connected' : 'Disconnected');
}

function setBusy(label) {
  const dot  = $('status-dot');
  const text = $('status-text');
  dot.className    = 'status-dot busy';
  text.textContent = label || 'Busy…';
}

let toastTimer;
function toast(msg, type = 'info') {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = `toast toast-${type} visible`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), 3200);
}

// ===== Connection =====

async function connect() {
  const url = $('api-url').value.trim();
  if (!url) return;
  api.setBase(url);
  const proxyMode = api.base === '';
  const badge = $('proxy-badge');
  if (badge) badge.style.display = proxyMode ? 'inline' : 'none';
  Log.info('Connect', proxyMode
    ? `Proxy mode — requests route through ${window.location.origin} → SDNext`
    : `Direct mode — connecting to ${api.base}`);
  setBusy('Connecting…');
  try {
    await loadAll();
    setStatus(true);
    Log.info('Connect', 'Connected successfully');
    toast('Connected to SDNext', 'success');
  } catch (e) {
    setStatus(false, 'Connection failed');
    Log.error('Connect', 'Connection failed', e.message);
    toast('Connection failed: ' + e.message, 'error');
  }
}

async function loadAll() {
  const [models, samplers, vaes, options, upscalers, detailers] = await Promise.allSettled([
    api.getModels(),
    api.getSamplers(),
    api.getVAEs(),
    api.getOptions(),
    api.getUpscalers(),
    api.getDetailers(),
  ]);

  if (models.status === 'fulfilled')    populateModels(models.value, options.value?.sd_model_checkpoint);
  if (samplers.status === 'fulfilled')  populateSamplers(samplers.value, options.value?.sampler_name);
  if (vaes.status === 'fulfilled')      populateVAEs(vaes.value, options.value?.sd_vae);
  if (upscalers.status === 'fulfilled') populateUpscalers(upscalers.value);
  if (detailers.status === 'fulfilled') populateDetailers(detailers.value);
  else Log.warn('API', 'Could not fetch detailers', detailers.reason?.message);

  if (options.status === 'fulfilled') ensureLivePreviews(options.value);

  loadLoras();
}

async function ensureLivePreviews(opts) {
  const needsUpdate = {};
  // SDNext uses show_progress_type ("None" disables previews; "TAESD" is fast approximate)
  if (opts.show_progress_type !== 'Approximate') needsUpdate.show_progress_type = 'Approximate';
  if ((opts.live_preview_refresh_period ?? 1000) > 500) needsUpdate.live_preview_refresh_period = 500;
  if (Object.keys(needsUpdate).length === 0) return;
  try {
    await api.setOptions(needsUpdate);
    Log.info('Connect', `Live previews enabled (show_progress_type=TAESD)`);
  } catch (e) {
    Log.error('Connect', 'Could not enable live previews', e.message);
  }
}

// ===== Populate selects =====

function populateModels(models, current) {
  const sel = $('sel-model');
  sel.innerHTML = '';
  models.forEach(m => {
    const o = new Option(m.title, m.title);
    if (m.title === current) o.selected = true;
    sel.add(o);
  });
}

function populateSamplers(samplers, current) {
  const sel = $('sel-sampler');
  sel.innerHTML = '';
  samplers.forEach(s => {
    const o = new Option(s.name, s.name);
    if (s.name === current) o.selected = true;
    sel.add(o);
  });
  if (!sel.value) {
    const euler = Array.from(sel.options).find(o => o.value === 'Euler');
    if (euler) euler.selected = true;
  }
}

function populateVAEs(vaes, current) {
  const sel = $('sel-vae');
  while (sel.options.length > 1) sel.remove(1);
  vaes.forEach(v => {
    const o = new Option(v.model_name, v.model_name);
    if (v.model_name === current) o.selected = true;
    sel.add(o);
  });
}

function populateDetailers(detailers) {
  const sel = $('sel-detailer-model');
  if (!sel) return;
  sel.innerHTML = '';
  (detailers || []).forEach(d => {
    const name = typeof d === 'string' ? d : (d.name || String(d));
    sel.add(new Option(name, name));
  });
}

function populateUpscalers(upscalers) {
  [$('sel-upscaler1'), $('sel-hires-upscaler')].forEach(sel => {
    sel.innerHTML = '';
    upscalers.forEach(u => sel.add(new Option(u.name, u.name)));
  });
}

async function loadLoras() {
  try {
    const loras = await api.getLoras();
    state.allLoras = loras;
    renderLoras(loras);
  } catch { /* LoRAs unavailable */ }
}

function renderLoras(loras) {
  const list = $('lora-list');
  list.innerHTML = '';
  loras.forEach(lora => {
    const item = document.createElement('div');
    item.className = 'lora-item';
    item.dataset.name = lora.name.toLowerCase();
    item.innerHTML = `
      <span class="lora-name" title="${lora.path || lora.name}">${lora.name}</span>
      <div class="lora-controls">
        <input type="range" class="lora-weight" min="-2" max="2" step="0.05" value="0.8">
        <span class="lora-weight-val">0.80</span>
        <button class="btn-icon btn-lora-add" title="Inject into prompt" style="
          width:20px;height:20px;font-size:13px;
          background:var(--accent-dim);border:1px solid var(--accent);color:var(--accent);
        ">+</button>
      </div>`;
    const slider = item.querySelector('.lora-weight');
    const val    = item.querySelector('.lora-weight-val');
    slider.addEventListener('input', () => { val.textContent = (+slider.value).toFixed(2); });
    item.querySelector('.btn-lora-add').addEventListener('click', () => {
      injectLora(lora.name, +slider.value);
    });
    list.appendChild(item);
  });
}

function injectLora(name, weight) {
  const el = activePromptEl();
  if (!el) return;
  const tag = `<lora:${name}:${weight.toFixed(2)}>`;
  const pos = el.selectionStart;
  const v   = el.value;
  const pre = pos > 0 && v[pos - 1] !== ' ' ? ' ' : '';
  const suf = v[pos] && v[pos] !== ' ' ? ' ' : '';
  el.value = v.slice(0, pos) + pre + tag + suf + v.slice(pos);
  el.setSelectionRange(pos + pre.length + tag.length, pos + pre.length + tag.length);
  el.focus();
  toast(`Injected: ${name}`, 'info');
}

function activePromptEl() {
  return { txt2img: $('t2i-prompt'), img2img: $('i2i-prompt'), video: $('vid-prompt') }[state.currentTab] || null;
}

// ===== Generation params =====

function commonParams() {
  const vae = $('sel-vae').value;
  return {
    sampler_name:      $('sel-sampler').value,
    steps:             +$('range-steps').value,
    cfg_scale:         +$('range-cfg').value,
    width:             +$('inp-width').value,
    height:            +$('inp-height').value,
    seed:              +$('inp-seed').value,
    batch_size:        +$('inp-batch-size').value,
    n_iter:            +$('inp-batch-count').value,
    save_images:       true,
    send_images:       true,
    ...(vae ? { override_settings: { sd_vae: vae }, override_settings_restore_afterwards: false } : {}),
  };
}

// Strip data-URL prefix to get raw base64
function rawB64(dataUrl) {
  return dataUrl ? dataUrl.replace(/^data:[^;]+;base64,/, '') : null;
}

// ===== Generate =====

async function generate() {
  if (state.generating) return;

  const tab = state.currentTab;
  let params, method;

  if (tab === 'txt2img') {
    params = {
      ...commonParams(),
      prompt:          $('t2i-prompt').value,
      negative_prompt: $('t2i-negative').value,
    };
    if ($('t2i-hires').checked) {
      params.enable_hr               = true;
      params.hr_scale                = +$('range-hires-scale').value;
      params.hr_denoising_strength   = +$('range-hires-denoise').value;
      params.hr_upscaler             = $('sel-hires-upscaler').value;
      params.hr_second_pass_steps    = +$('inp-hires-steps').value;
    }
    if ($('t2i-detailer').checked && $('sel-detailer-model').value) {
      params.detailer_enabled    = true;
      params.detailer_models     = [$('sel-detailer-model').value];
      params.detailer_strength   = +$('range-detailer-strength').value;
      params.detailer_conf       = +$('range-detailer-conf').value;
      params.detailer_steps      = +$('inp-detailer-steps').value;
      params.detailer_resolution = +$('inp-detailer-res').value;
    }
    method = 'txt2img';

  } else if (tab === 'img2img') {
    if (!state.initImages.i2i) { toast('Upload an init image first', 'error'); return; }
    params = {
      ...commonParams(),
      prompt:              $('i2i-prompt').value,
      negative_prompt:     $('i2i-negative').value,
      init_images:         [rawB64(state.initImages.i2i)],
      denoising_strength:  +$('range-denoise').value,
      resize_mode:         +$('sel-resize-mode').value,
    };
    if ($('t2i-detailer').checked && $('sel-detailer-model').value) {
      params.detailer_enabled    = true;
      params.detailer_models     = [$('sel-detailer-model').value];
      params.detailer_strength   = +$('range-detailer-strength').value;
      params.detailer_conf       = +$('range-detailer-conf').value;
      params.detailer_steps      = +$('inp-detailer-steps').value;
      params.detailer_resolution = +$('inp-detailer-res').value;
    }
    method = 'img2img';

  } else if (tab === 'video') {
    const useInit = $('vid-use-init').checked;
    params = {
      ...commonParams(),
      prompt:          $('vid-prompt').value,
      negative_prompt: $('vid-negative').value,
      num_frames:      +$('range-frames').value,
      task_args:       { num_frames: +$('range-frames').value },
    };
    if (useInit && state.initImages.vid) {
      params.init_images        = [rawB64(state.initImages.vid)];
      params.denoising_strength = 0.75;
      method = 'img2img';
    } else {
      method = 'txt2img';
    }

  } else {
    return;
  }

  const logParams = { ...params };
  delete logParams.init_images;  // don't bloat log with base64
  Log.info('Generate', `${method} — model: ${$('sel-model').value.split('/').pop()}`, JSON.stringify(logParams));
  startGen();
  const t0 = performance.now();
  let succeeded = false;
  try {
    const result = await api[method](params);
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    const count   = result.images?.length ?? 0;
    Log.info('Generate', `Done — ${count} image(s) in ${elapsed}s`);
    handleResult(result, tab === 'video' ? +$('range-fps').value : 0, tab);
    recordGenHistory(tab, params, result);
    succeeded = true;
  } catch (e) {
    Log.error('Generate', 'Generation failed', e.message);
    toast('Generation failed: ' + e.message, 'error');
    state.looping = false;
    updateLoopBtn();
  } finally {
    stopGen();
  }
  if (succeeded && state.looping) generate();
}

function updateLoopBtn() {
  $('btn-loop').classList.toggle('active', state.looping);
  $('btn-loop').title = state.looping ? 'Looping — click to stop after this generation' : 'Generate continuously until stopped';
}

function startGen() {
  state.generating    = true;
  state.progressAbort = new AbortController();
  $('btn-generate').disabled   = true;
  $('btn-generate').textContent = 'Generating…';
  $('btn-interrupt').style.display = 'inline-flex';
  $('btn-skip').style.display      = 'inline-flex';
  $('progress-area').style.display = 'block';
  $('progress-fill').style.width   = '0%';
  $('progress-text').textContent   = 'Starting…';
  $('progress-eta').textContent    = '';
  // Show live preview panel with spinner
  $('live-preview').style.display        = 'flex';
  $('live-preview-placeholder').style.display = 'flex';
  $('live-preview-img').style.display    = 'none';
  $('live-preview-img').src              = '';
  setBusy('Generating…');
  // Use self-scheduling loop instead of setInterval — one request at a time,
  // next poll only fires after the previous response returns.
  state.progressTimer = setTimeout(pollProgress, 300);
}

function stopGen() {
  state.generating = false;
  clearTimeout(state.progressTimer);
  state.progressTimer = null;
  if (state.progressAbort) { state.progressAbort.abort(); state.progressAbort = null; }

  $('btn-generate').disabled   = false;
  $('btn-generate').textContent = 'Generate ';
  const hint = document.createElement('span');
  hint.className = 'key-hint';
  hint.textContent = 'Ctrl+Enter';
  $('btn-generate').appendChild(hint);

  $('btn-interrupt').style.display = 'none';
  $('btn-skip').style.display      = 'none';
  $('progress-fill').style.width   = '100%';

  setStatus(true);
  setTimeout(() => {
    $('progress-area').style.display = 'none';
    $('live-preview').style.display  = 'none';
    $('progress-fill').style.width   = '0%';
    $('live-preview-img').src        = '';
  }, 700);
}

async function pollProgress() {
  if (!state.generating) return;
  const signal = state.progressAbort?.signal;
  try {
    const p = await api.getProgress(signal);
    if (!state.generating) return;  // aborted while waiting

    const pct   = Math.round((p.progress || 0) * 100);
    const step  = p.state?.sampling_step  || 0;
    const steps = p.state?.sampling_steps || 0;
    console.log(`[poll] ${pct}% step=${step}/${steps} img=${p.current_image ? 'yes' : 'null'}`);

    $('progress-fill').style.width = pct + '%';
    $('progress-text').textContent = steps > 0 ? `${pct}% — step ${step}/${steps}` : `${pct}%`;
    if (p.eta_relative > 0) $('progress-eta').textContent = `ETA: ${p.eta_relative.toFixed(1)}s`;

    if (p.current_image) {
      $('live-preview-placeholder').style.display = 'none';
      const img = $('live-preview-img');
      img.style.display = 'block';
      img.src = 'data:image/jpeg;base64,' + p.current_image;
    }
  } catch (e) {
    if (e.name !== 'AbortError') console.warn('[poll error]', e.message);
  }
  // Schedule next poll only after this one completes — prevents flooding SDNext
  if (state.generating) state.progressTimer = setTimeout(pollProgress, 500);
}

// ===== Result handling =====

function handleResult(result, fps = 0, type = 'txt2img') {
  const images = result.images || [];
  if (!images.length) { toast('No images returned', 'warn'); return; }

  const info = parseInfo(result.info);
  state.lastInfo = info;
  if (info.seed != null && info.seed >= 0) state.lastSeed = info.seed;

  const infoStr = result.info || '';
  const saving  = $('save-to-disk')?.checked;

  if (fps > 0 && images.length > 1) {
    addVideoToGallery(images, infoStr, fps);
    if (saving) images.forEach(img => saveImageToDisk(img, 'video'));
    toast(`Generated ${images.length} frames`, 'success');
  } else {
    images.forEach(img => {
      addImageToGallery(img, infoStr);
      if (saving) saveImageToDisk(img, type);
    });
    toast(`Generated ${images.length} image(s) — seed ${info.seed ?? '?'}`, 'success');
  }

  updateGalleryCount();
}

function parseInfo(infoStr) {
  if (!infoStr) return {};
  try { return JSON.parse(infoStr); } catch { /* text format */ }
  const seed = infoStr.match(/Seed:\s*(\d+)/)?.[1];
  return seed ? { seed: +seed } : {};
}

// ===== Gallery =====

function addImageToGallery(b64, infoStr) {
  const gallery = $('gallery');
  const item    = document.createElement('div');
  item.className = 'gallery-item';

  const img = document.createElement('img');
  img.src     = 'data:image/png;base64,' + b64;
  img.loading = 'lazy';

  const actions = makeGalleryActions(b64, infoStr);
  item.appendChild(img);
  item.appendChild(actions);
  item.addEventListener('click', () => openModal(b64, infoStr));
  gallery.insertBefore(item, gallery.firstChild);
}

function addVideoToGallery(frames, infoStr, fps) {
  const gallery = $('gallery');
  const item    = document.createElement('div');
  item.className = 'gallery-item';

  const img = document.createElement('img');
  img.src = 'data:image/png;base64,' + frames[0];
  img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';

  const badge = document.createElement('div');
  badge.style.cssText = `
    position:absolute;top:5px;left:5px;
    background:rgba(0,0,0,0.7);color:#fff;
    font-size:10px;padding:2px 5px;border-radius:3px;`;
  badge.textContent = `▶ ${frames.length}f`;

  // Animate on hover
  let timer;
  let idx = 0;
  item.addEventListener('mouseenter', () => {
    timer = setInterval(() => {
      idx = (idx + 1) % frames.length;
      img.src = 'data:image/png;base64,' + frames[idx];
    }, 1000 / fps);
  });
  item.addEventListener('mouseleave', () => {
    clearInterval(timer);
    idx = 0;
    img.src = 'data:image/png;base64,' + frames[0];
  });

  const actions = makeGalleryActions(frames[0], infoStr, true);
  item.appendChild(img);
  item.appendChild(badge);
  item.appendChild(actions);
  item.addEventListener('click', () => openModal(frames[0], infoStr, frames, fps));
  gallery.insertBefore(item, gallery.firstChild);
}

function makeGalleryActions(b64, infoStr, isVideo = false) {
  const div = document.createElement('div');
  div.className = 'gallery-item-actions';

  const dl = document.createElement('button');
  dl.className = 'btn-icon';
  dl.title     = 'Download';
  dl.textContent = '⬇';
  dl.onclick = e => { e.stopPropagation(); downloadImage(b64); };

  const send = document.createElement('button');
  send.className = 'btn-icon';
  send.title     = 'Send to img2img';
  send.textContent = '→';
  send.onclick = e => { e.stopPropagation(); sendToImg2img(b64); };

  div.appendChild(dl);
  div.appendChild(send);
  return div;
}

function updateGalleryCount() {
  const n = $('gallery').children.length;
  $('gallery-count').textContent = n > 0 ? `${n} image${n !== 1 ? 's' : ''}` : '';
}

function downloadImage(b64, name) {
  const a    = document.createElement('a');
  a.href     = 'data:image/png;base64,' + b64;
  a.download = name || `sdnext_${Date.now()}.png`;
  a.click();
}

function sendToImg2img(b64) {
  const dataUrl = 'data:image/png;base64,' + b64;
  state.initImages.i2i = dataUrl;
  showInitPreview('i2i', dataUrl);
  switchTab('img2img');
  toast('Sent to img2img', 'success');
}

function sendToVideo(b64) {
  const dataUrl = 'data:image/png;base64,' + b64;
  state.initImages.vid = dataUrl;
  showInitPreview('vid', dataUrl);
  $('vid-use-init').checked = true;
  $('vid-init-area').style.display = 'block';
  switchTab('video');
  toast('Sent to img2vid', 'success');
}

function sendToTxtVid() {
  $('vid-use-init').checked = false;
  $('vid-init-area').style.display = 'none';
  switchTab('video');
  toast('Switched to txt2vid', 'success');
}

function sendParamsToTxt2img(infoStr) {
  const raw = formatInfo(infoStr);
  const promptMatch  = raw.match(/^([\s\S]+?)(?:\nNegative prompt:|\nSteps:)/);
  const negMatch     = raw.match(/Negative prompt:\s*([\s\S]+?)(?:\nSteps:|$)/);
  const seedMatch    = raw.match(/Seed:\s*(\d+)/);
  const sizeMatch    = raw.match(/Size:\s*(\d+)x(\d+)/);
  const samplerMatch = raw.match(/Sampler:\s*([^,\n]+)/);
  if (promptMatch)  $('t2i-prompt').value   = promptMatch[1].trim();
  if (negMatch)     $('t2i-negative').value  = negMatch[1].trim();
  if (seedMatch)    $('inp-seed').value      = seedMatch[1];
  if (sizeMatch)    { $('inp-width').value = sizeMatch[1]; $('inp-height').value = sizeMatch[2]; }
  if (samplerMatch) {
    const name = samplerMatch[1].trim();
    if (Array.from($('sel-sampler').options).some(o => o.value === name)) $('sel-sampler').value = name;
  }
  switchTab('txt2img');
  toast('Parameters applied to txt2img', 'success');
}

// ===== Modal =====

function applyModalTransform() {
  $('modal-fs-img').style.transform = `translate(${modalPan.x}px, ${modalPan.y}px) scale(${modalZoom})`;
  $('modal-viewport').style.cursor = modalZoom > 1 ? (modalDragging ? 'grabbing' : 'grab') : 'default';
}

function resetModalZoom() {
  modalZoom = 1;
  modalPan  = { x: 0, y: 0 };
  applyModalTransform();
}

function initModalZoom() {
  const vp = $('modal-viewport');

  // Mouse wheel — zoom toward cursor
  vp.addEventListener('wheel', e => {
    e.preventDefault();
    const rect  = vp.getBoundingClientRect();
    const mx    = e.clientX - rect.left - rect.width  / 2;
    const my    = e.clientY - rect.top  - rect.height / 2;
    const prev  = modalZoom;
    modalZoom   = Math.max(1, Math.min(8, modalZoom * (e.deltaY < 0 ? 1.25 : 1 / 1.25)));
    if (modalZoom === 1) {
      modalPan = { x: 0, y: 0 };
    } else if (modalZoom !== prev) {
      const r   = modalZoom / prev;
      modalPan.x = mx - r * (mx - modalPan.x);
      modalPan.y = my - r * (my - modalPan.y);
    }
    applyModalTransform();
  }, { passive: false });

  // Mouse drag
  vp.addEventListener('mousedown', e => {
    if (modalZoom <= 1) return;
    modalDragging = true;
    modalDragOrig = { x: e.clientX - modalPan.x, y: e.clientY - modalPan.y };
    applyModalTransform();
  });
  document.addEventListener('mousemove', e => {
    if (!modalDragging) return;
    modalPan.x = e.clientX - modalDragOrig.x;
    modalPan.y = e.clientY - modalDragOrig.y;
    applyModalTransform();
  });
  document.addEventListener('mouseup', () => {
    if (!modalDragging) return;
    modalDragging = false;
    applyModalTransform();
  });

  // Touch — pinch zoom + pan + tap-to-close
  vp.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
      e.preventDefault();
      modalPinchDist0  = touchDist(e.touches);
      modalZoom0       = modalZoom;
      modalPan0        = { ...modalPan };
      modalTouchMoved  = true;
    } else {
      modalTouchStart  = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      modalPan0        = { ...modalPan };
      modalTouchMoved  = false;
    }
  }, { passive: false });

  vp.addEventListener('touchmove', e => {
    e.preventDefault();
    if (e.touches.length === 2 && modalPinchDist0) {
      const ratio = touchDist(e.touches) / modalPinchDist0;
      modalZoom = Math.max(1, Math.min(8, modalZoom0 * ratio));
      if (modalZoom === 1) modalPan = { x: 0, y: 0 };
      applyModalTransform();
    } else if (e.touches.length === 1 && modalTouchStart) {
      const dx = e.touches[0].clientX - modalTouchStart.x;
      const dy = e.touches[0].clientY - modalTouchStart.y;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) modalTouchMoved = true;
      if (modalZoom > 1) {
        modalPan.x = modalPan0.x + dx;
        modalPan.y = modalPan0.y + dy;
        applyModalTransform();
      }
    }
  }, { passive: false });

  vp.addEventListener('touchend', e => {
    if (e.touches.length === 0) {
      if (!modalTouchMoved && modalZoom <= 1) { closeFullscreen(); return; }
      modalPinchDist0 = 0;
      modalTouchStart = null;
    } else if (e.touches.length === 1) {
      modalPinchDist0 = 0;
      modalTouchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      modalPan0       = { ...modalPan };
      modalTouchMoved = true;
    }
  });
}

function touchDist(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

function openModal(b64, infoStr, frames, fps) {
  state.currentModalB64 = b64;
  $('modal-img').src = 'data:image/png;base64,' + b64;

  if (frames && frames.length > 1) {
    clearInterval(state.animTimer);
    state.animFrames = frames;
    state.animIdx    = 0;
    state.animTimer  = setInterval(() => {
      state.animIdx = (state.animIdx + 1) % state.animFrames.length;
      $('modal-img').src = 'data:image/png;base64,' + state.animFrames[state.animIdx];
    }, 1000 / (fps || 8));
  } else {
    clearInterval(state.animTimer);
    state.animTimer = null;
  }

  $('modal-info').textContent = formatInfo(infoStr);
  $('modal-fullscreen').onclick = () => openFullscreen(b64);
  $('modal-download').onclick   = () => downloadImage(b64);
  $('modal-use-seed').onclick   = () => {
    const info = parseInfo(infoStr);
    if (info.seed != null) { $('inp-seed').value = info.seed; toast('Seed applied: ' + info.seed, 'info'); }
  };
  $('modal-send-t2i').onclick = () => { sendParamsToTxt2img(infoStr); closeModal(); };
  $('modal-send-i2i').onclick = () => { sendToImg2img(b64); closeModal(); };
  $('modal-send-t2v').onclick = () => { sendToTxtVid();     closeModal(); };
  $('modal-send-i2v').onclick = () => { sendToVideo(b64);   closeModal(); };

  $('modal').style.display = 'flex';
}

function closeModal() {
  $('modal').style.display = 'none';
  clearInterval(state.animTimer);
  state.animTimer = null;
}

function openFullscreen(b64) {
  resetModalZoom();
  $('modal-fs-img').src = 'data:image/png;base64,' + b64;
  $('modal-fs').style.display = 'block';
}

function closeFullscreen() {
  $('modal-fs').style.display = 'none';
  resetModalZoom();
}

// ===== Media Browser =====

function openMediaBrowser() {
  $('media-browser').style.display = 'flex';
  showMediaGridView();
  $('media-grid').innerHTML = '<div class="media-empty">Loading…</div>';
  fetch('/outputs')
    .then(r => r.json())
    .then(data => { state.mediaData = data; renderMedia(state.mediaFilter); })
    .catch(() => { $('media-grid').innerHTML = '<div class="media-empty">No saved images found.</div>'; });
}

function closeMediaBrowser() {
  $('media-browser').style.display = 'none';
  showMediaGridView();
}

function showMediaGridView() {
  $('media-grid-view').style.display = 'flex';
  $('media-lightbox').style.display = 'none';
}

function renderMedia(filter) {
  state.mediaFilter = filter;
  $$('.media-filter').forEach(b => b.classList.toggle('active', b.dataset.filter === filter));
  const grid = $('media-grid');
  grid.innerHTML = '';

  const entries = [];
  for (const [type, files] of Object.entries(state.mediaData || {})) {
    if (filter !== 'all' && type !== filter) continue;
    files.forEach(fname => entries.push({ type, fname }));
  }
  entries.sort((a, b) => b.fname.localeCompare(a.fname));
  state.mediaEntries = entries;

  if (!entries.length) {
    grid.innerHTML = '<div class="media-empty">No images.</div>';
    return;
  }

  entries.forEach(({ type, fname }, idx) => {
    const item = document.createElement('div');
    item.className = 'media-item';
    const img = document.createElement('img');
    img.src     = `/outputs/${type}/${fname}`;
    img.loading = 'lazy';
    item.appendChild(img);
    item.addEventListener('click', () => openMediaLightbox(idx));
    grid.appendChild(item);
  });
}

function openMediaLightbox(index) {
  $('media-grid-view').style.display = 'none';
  $('media-lightbox').style.display = 'flex';
  showMediaAt(index);
}

async function showMediaAt(index) {
  const n = state.mediaEntries.length;
  if (!n) return;
  index = ((index % n) + n) % n;
  state.mediaIndex  = index;
  state.lightboxB64 = null;

  const { type, fname } = state.mediaEntries[index];
  $('media-lb-img').src             = `/outputs/${type}/${fname}`;
  $('media-lb-counter').textContent = `${index + 1} / ${n}`;
  $('media-lb-info').textContent    = '…';

  const [b64Result, metaResult] = await Promise.allSettled([
    fetch(`/outputs/${type}/${fname}`).then(r => r.blob()).then(blob =>
      new Promise(res => {
        const reader = new FileReader();
        reader.onload = () => res(reader.result.split(',')[1]);
        reader.readAsDataURL(blob);
      })
    ),
    fetch(`/outputs/meta?path=${encodeURIComponent(type + '/' + fname)}`).then(r => r.json()),
  ]);

  if (b64Result.status === 'fulfilled') state.lightboxB64 = b64Result.value;

  if (metaResult.status === 'fulfilled') {
    $('media-lb-info').textContent = metaResult.value.parameters || '(no parameters stored)';
  } else {
    Log.warn('media', 'meta fetch failed', metaResult.reason);
    $('media-lb-info').textContent = '(meta fetch failed)';
  }
}

function mediaPrev() { showMediaAt(state.mediaIndex - 1); }
function mediaNext() { showMediaAt(state.mediaIndex + 1); }

function openMediaFullscreen() {
  if (!state.lightboxB64) { toast('Image still loading', 'info'); return; }
  openFullscreen(state.lightboxB64);
}

function normalizeParams(str) {
  // EXIF strings store newlines as literal \n sequences — convert to real newlines
  return str.replace(/\\n/g, '\n');
}

function formatInfo(infoStr) {
  if (!infoStr) return '';
  try {
    const obj = JSON.parse(infoStr);
    return Object.entries(obj)
      .filter(([, v]) => v != null && v !== '' && v !== false)
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join('\n');
  } catch {
    return normalizeParams(infoStr);
  }
}

// ===== Tab switching =====

function switchTab(tab) {
  state.currentTab = tab;
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `panel-${tab}`));
}

// ===== Init image handling =====

function setupDropzone(dzId, fiId, key, handler) {
  const dz = $(dzId);
  const fi = $(fiId);
  if (!dz || !fi) return;

  dz.addEventListener('click', () => fi.click());
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
  dz.addEventListener('dragleave', ()  => dz.classList.remove('drag-over'));
  dz.addEventListener('drop', e => {
    e.preventDefault();
    dz.classList.remove('drag-over');
    const f = e.dataTransfer.files[0];
    if (f) (handler || loadInitImage)(f, key);
  });
  fi.addEventListener('change', () => {
    if (fi.files[0]) (handler || loadInitImage)(fi.files[0], key);
    fi.value = '';
  });
}

function loadInitImage(file, key) {
  const reader = new FileReader();
  reader.onload = e => {
    state.initImages[key] = e.target.result;
    showInitPreview(key, e.target.result);
  };
  reader.readAsDataURL(file);
}

function showInitPreview(key, dataUrl) {
  $(`${key}-preview`).style.display  = 'block';
  $(`${key}-preview-img`).src        = dataUrl;
  $(`${key}-dropzone`).style.display = 'none';
}

function clearInitImage(key) {
  state.initImages[key]              = null;
  $(`${key}-preview`).style.display  = 'none';
  $(`${key}-dropzone`).style.display = 'flex';
}

// ===== Model loading =====

async function loadModel() {
  const model = $('sel-model').value;
  if (!model) return;
  const btn = $('btn-load-model');
  const sta = $('model-load-status');

  btn.disabled      = true;
  btn.textContent   = 'Loading…';
  sta.textContent   = 'Loading model…';
  sta.className     = 'model-status loading';
  sta.style.display = 'block';
  setBusy('Loading model…');

  try {
    await api.setCheckpoint(model);
    sta.textContent = '✓ Loaded';
    sta.className   = 'model-status ok';
    toast('Model loaded: ' + model.split('/').pop().slice(0, 40), 'success');
    setStatus(true);
    setTimeout(() => { sta.style.display = 'none'; }, 4000);
  } catch (e) {
    sta.textContent = '✗ ' + e.message.slice(0, 60);
    sta.className   = 'model-status err';
    toast('Model load failed', 'error');
    setStatus(true);
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Load Model';
  }
}

// ===== PNG Info =====

async function handlePNGInfo(file) {
  const reader = new FileReader();
  reader.onload = async e => {
    const b64 = rawB64(e.target.result);
    try {
      const r = await api.pngInfo(b64);
      const info = r.info || 'No metadata found.';
      $('pnginfo-text').textContent = info;
      $('pnginfo-result').style.display = 'block';
      $('pnginfo-result').dataset.raw   = info;
    } catch (err) {
      toast('PNG info failed: ' + err.message, 'error');
    }
  };
  reader.readAsDataURL(file);
}

function sendPNGInfoToT2i() {
  const raw = normalizeParams($('pnginfo-result').dataset.raw || '');
  const promptMatch = raw.match(/^([\s\S]*?)(?:\nNegative prompt:|\nSteps:)/);
  const negMatch    = raw.match(/Negative prompt:\s*([\s\S]*?)(?:\nSteps:|\n\n)/);
  const stepsMatch  = raw.match(/Steps:\s*(\d+)/);
  const cfgMatch    = raw.match(/CFG scale:\s*([\d.]+)/);
  const seedMatch   = raw.match(/Seed:\s*(\d+)/);
  const sizeMatch   = raw.match(/Size:\s*(\d+)x(\d+)/);
  const samplerMatch= raw.match(/Sampler:\s*([^,\n]+)/);

  if (promptMatch) $('t2i-prompt').value   = promptMatch[1].trim();
  if (negMatch)    $('t2i-negative').value = negMatch[1].trim();
  if (stepsMatch)  { $('range-steps').value = stepsMatch[1];  $('val-steps').textContent = stepsMatch[1]; }
  if (cfgMatch)    { $('range-cfg').value   = cfgMatch[1];    $('val-cfg').textContent = (+cfgMatch[1]).toFixed(1); }
  if (seedMatch)   $('inp-seed').value      = seedMatch[1];
  if (sizeMatch)   { $('inp-width').value = sizeMatch[1]; $('inp-height').value = sizeMatch[2]; }
  if (samplerMatch) {
    const name = samplerMatch[1].trim();
    const opt  = Array.from($('sel-sampler').options).find(o => o.value === name);
    if (opt) $('sel-sampler').value = name;
  }
  switchTab('txt2img');
  toast('Parameters applied to txt2img', 'success');
}

// ===== Caption / Tag =====

async function runCaption() {
  if (!state.initImages.caption) { toast('Upload an image first', 'error'); return; }
  const b64 = rawB64(state.initImages.caption);
  $('btn-caption').disabled = true;
  $('btn-caption').textContent = 'Captioning…';
  try {
    const r = await api.caption(b64);
    const text = r.caption || r.text || JSON.stringify(r);
    $('caption-text').textContent = text;
    $('caption-result').style.display = 'block';
    $('btn-send-caption-prompt').style.display = 'inline-flex';
    $('btn-send-caption-prompt').dataset.text = text;
    toast('Caption ready', 'success');
  } catch (e) {
    toast('Caption failed: ' + e.message, 'error');
  } finally {
    $('btn-caption').disabled = false;
    $('btn-caption').textContent = 'Caption (CLIP)';
  }
}

async function runTag() {
  if (!state.initImages.caption) { toast('Upload an image first', 'error'); return; }
  const b64 = rawB64(state.initImages.caption);
  $('btn-tag').disabled = true;
  $('btn-tag').textContent = 'Tagging…';
  try {
    const r = await api.tagImage(b64);
    const tags = r.caption || r.tags || (r.results ? Object.entries(r.results).sort((a,b) => b[1]-a[1]).map(([t,s]) => `${t} (${s.toFixed(2)})`).join(', ') : JSON.stringify(r));
    $('caption-text').textContent = tags;
    $('caption-result').style.display = 'block';
    $('btn-send-caption-prompt').style.display = 'inline-flex';
    $('btn-send-caption-prompt').dataset.text = typeof tags === 'string' ? tags.split(' (')[0].replace(/, \([^)]+\)/g, '') : tags;
    toast('Tags ready', 'success');
  } catch (e) {
    toast('Tagging failed: ' + e.message, 'error');
  } finally {
    $('btn-tag').disabled = false;
    $('btn-tag').textContent = 'Tag (Tagger)';
  }
}

// ===== Upscale =====

async function runUpscale() {
  if (!state.initImages.upscale) { toast('Upload an image to upscale', 'error'); return; }
  const b64 = rawB64(state.initImages.upscale);
  const params = {
    image:          b64,
    upscaling_resize: +$('range-upscale').value,
    upscaler_1:     $('sel-upscaler1').value,
  };
  $('btn-upscale').disabled   = true;
  $('btn-upscale').textContent = 'Upscaling…';
  try {
    const r = await api.extraSingle(params);
    if (r.image) {
      addImageToGallery(r.image, '');
      if ($('save-to-disk')?.checked) saveImageToDisk(r.image, 'upscale');
      updateGalleryCount();
      toast('Upscale complete', 'success');
    }
  } catch (e) {
    toast('Upscale failed: ' + e.message, 'error');
  } finally {
    $('btn-upscale').disabled    = false;
    $('btn-upscale').textContent = 'Upscale';
  }
}

// ===== Prompt enhance =====

async function enhancePrompt() {
  const el = $('t2i-prompt');
  if (!el.value.trim()) return;
  $('t2i-enhance').textContent = '…';
  $('t2i-enhance').disabled    = true;
  try {
    const r = await api.enhancePrompt(el.value);
    if (r.prompt) { el.value = r.prompt; toast('Prompt enhanced', 'success'); }
    else toast('No enhanced prompt returned', 'warn');
  } catch {
    toast('Enhance not available for this model', 'warn');
  } finally {
    $('t2i-enhance').textContent = '✨ Enhance';
    $('t2i-enhance').disabled    = false;
  }
}

// ===== Event listeners =====

// ===== Mobile sidebar toggle =====

function sidebarOpen()  {
  $('sidebar').classList.add('open');
  $('sidebar-backdrop').classList.add('visible');
}
function sidebarClose() {
  $('sidebar').classList.remove('open');
  $('sidebar-backdrop').classList.remove('visible');
}
function toggleSidebar() {
  $('sidebar').classList.contains('open') ? sidebarClose() : sidebarOpen();
}

function initMobile() {
  $('btn-sidebar-toggle').addEventListener('click', toggleSidebar);
  $('sidebar-backdrop').addEventListener('click', sidebarClose);

  // Close sidebar when any tab is tapped on mobile
  $$('.tab').forEach(t => t.addEventListener('click', () => {
    if (window.matchMedia('(max-width: 900px)').matches) sidebarClose();
  }));
}

function initEvents() {
  // Connection
  $('btn-connect').addEventListener('click', connect);
  $('api-url').addEventListener('keydown', e => { if (e.key === 'Enter') connect(); });

  // Refresh
  $('btn-refresh').addEventListener('click', async () => {
    toast('Refreshing…', 'info');
    try { await loadAll(); toast('Refreshed', 'success'); }
    catch (e) { toast('Refresh failed: ' + e.message, 'error'); }
  });

  // Tabs
  $$('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  // Sliders — bind label display
  const sliderDefs = [
    ['range-steps',        'val-steps',        v => String(Math.round(v))],
    ['range-cfg',          'val-cfg',          v => (+v).toFixed(1)],
    ['range-denoise',      'val-denoise',      v => (+v).toFixed(2)],
    ['range-frames',       'val-frames',       v => String(Math.round(v))],
    ['range-fps',          'val-fps',          v => String(Math.round(v))],
    ['range-hires-scale',  'val-hires-scale',  v => (+v).toFixed(1)],
    ['range-hires-denoise',     'val-hires-denoise',     v => (+v).toFixed(2)],
    ['range-upscale',           'val-upscale',           v => (+v).toFixed(1)],
    ['range-detailer-strength', 'val-detailer-strength', v => (+v).toFixed(2)],
    ['range-detailer-conf',     'val-detailer-conf',     v => (+v).toFixed(2)],
  ];
  sliderDefs.forEach(([id, vid, fmt]) => {
    const el = $(id);
    if (el) el.addEventListener('input', () => $(vid).textContent = fmt(el.value));
  });

  // Dimension presets
  $$('.btn-preset').forEach(b => b.addEventListener('click', () => {
    $('inp-width').value  = b.dataset.w;
    $('inp-height').value = b.dataset.h;
  }));

  // Swap dims
  $('btn-swap-dims').addEventListener('click', () => {
    const w = $('inp-width').value;
    $('inp-width').value  = $('inp-height').value;
    $('inp-height').value = w;
  });

  // Seed buttons
  $('btn-rand-seed').addEventListener('click', () => {
    $('inp-seed').value = Math.floor(Math.random() * 0xFFFFFFFF);
  });
  $('btn-last-seed').addEventListener('click', () => {
    if (state.lastSeed >= 0) { $('inp-seed').value = state.lastSeed; toast('Seed: ' + state.lastSeed, 'info'); }
  });

  // Hi-res toggle
  $('t2i-hires').addEventListener('change', function () {
    $('hires-params').style.display = this.checked ? 'flex' : 'none';
  });

  // Detailer toggle
  $('t2i-detailer').addEventListener('change', function () {
    $('detailer-params').style.display = this.checked ? 'flex' : 'none';
  });

  // Generate / interrupt / skip / loop
  $('btn-generate').addEventListener('click', generate);
  $('btn-loop').addEventListener('click', () => {
    state.looping = !state.looping;
    updateLoopBtn();
    if (state.looping && !state.generating) generate();
  });
  $('btn-interrupt').addEventListener('click', async () => {
    state.looping = false;
    updateLoopBtn();
    await api.interrupt();
    toast('Interrupted', 'warn');
  });
  $('btn-skip').addEventListener('click', () => api.skip());

  // Prompt enhance
  $('t2i-enhance').addEventListener('click', enhancePrompt);

  // Init image dropzones
  setupDropzone('i2i-dropzone',    'i2i-file',    'i2i');
  setupDropzone('vid-dropzone',    'vid-file',    'vid');
  setupDropzone('upscale-dropzone','upscale-file','upscale');

  // Clear init images
  $('i2i-clear').addEventListener('click',    () => clearInitImage('i2i'));
  $('vid-clear').addEventListener('click',    () => clearInitImage('vid'));
  $('upscale-clear').addEventListener('click',() => clearInitImage('upscale'));

  // Video init toggle
  $('vid-use-init').addEventListener('change', function () {
    $('vid-init-area').style.display = this.checked ? 'block' : 'none';
  });

  // Model load
  $('btn-load-model').addEventListener('click', loadModel);

  // LoRA refresh + search
  $('btn-refresh-loras').addEventListener('click', () => { toast('Refreshing LoRAs…', 'info'); loadLoras(); });
  $('lora-search').addEventListener('input', function () {
    const q = this.value.toLowerCase();
    $$('#lora-list .lora-item').forEach(item => {
      item.style.display = item.dataset.name.includes(q) ? '' : 'none';
    });
  });

  // PNG info dropzone
  setupDropzone('pnginfo-dropzone', 'pnginfo-file', null, (f) => handlePNGInfo(f));
  $('btn-send-t2i').addEventListener('click', sendPNGInfoToT2i);
  $('btn-copy-info').addEventListener('click', () => {
    navigator.clipboard.writeText($('pnginfo-text').textContent).then(() => toast('Copied', 'info'));
  });

  // Caption / Tag
  setupDropzone('caption-dropzone', 'caption-file', 'caption');
  $('caption-clear').addEventListener('click', () => clearInitImage('caption'));
  $('btn-caption').addEventListener('click', runCaption);
  $('btn-tag').addEventListener('click', runTag);
  $('btn-send-caption-prompt').addEventListener('click', function () {
    const text = this.dataset.text || '';
    if (text) { $('t2i-prompt').value = text; switchTab('txt2img'); toast('Sent to prompt', 'success'); }
  });

  // Upscale
  $('btn-upscale').addEventListener('click', runUpscale);

  // Modal
  $('modal-close').addEventListener('click', closeModal);
  $('modal-overlay').addEventListener('click', closeModal);
  $('modal-fs-close').addEventListener('click', closeFullscreen);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if ($('modal-fs').style.display  !== 'none') { closeFullscreen();    return; }
      if ($('modal').style.display     !== 'none') { closeModal();         return; }
      if ($('media-lightbox').style.display !== 'none') { showMediaGridView(); return; }
      closeMediaBrowser();
    }
    if ($('media-lightbox').style.display !== 'none') {
      if (e.key === 'ArrowLeft')  mediaPrev();
      if (e.key === 'ArrowRight') mediaNext();
    }
  });

  // Gallery clear
  $('btn-clear-gallery').addEventListener('click', () => {
    $('gallery').innerHTML = '';
    updateGalleryCount();
  });

  // History panel
  $('btn-history').addEventListener('click', openHistoryPanel);
  $('history-close').addEventListener('click', closeHistoryPanel);
  $('history-panel').addEventListener('click', e => { if (e.target === $('history-panel')) closeHistoryPanel(); });

  // Media browser — grid view
  $('btn-media').addEventListener('click', openMediaBrowser);
  $('media-close').addEventListener('click', closeMediaBrowser);
  $('media-browser').addEventListener('click', e => { if (e.target === $('media-browser')) closeMediaBrowser(); });
  $$('.media-filter').forEach(btn => btn.addEventListener('click', () => renderMedia(btn.dataset.filter)));

  // Media browser — lightbox navigation
  $('media-lb-back').addEventListener('click', showMediaGridView);
  $('media-lb-close').addEventListener('click', closeMediaBrowser);
  $('media-lb-prev').addEventListener('click', mediaPrev);
  $('media-lb-next').addEventListener('click', mediaNext);
  $('media-lb-fullscreen').addEventListener('click', openMediaFullscreen);

  // Media browser — lightbox actions
  $('media-lb-download').addEventListener('click', () => {
    if (state.lightboxB64) downloadImage(state.lightboxB64);
  });
  $('media-lb-use-seed').addEventListener('click', () => {
    const match = $('media-lb-info').textContent.match(/Seed:\s*(\d+)/);
    if (match) { $('inp-seed').value = match[1]; toast('Seed applied: ' + match[1], 'info'); }
    else toast('No seed found in parameters', 'warn');
  });
  $('media-lb-send-t2i').addEventListener('click', () => {
    sendParamsToTxt2img($('media-lb-info').textContent);
    closeMediaBrowser();
  });
  $('media-lb-send-i2i').addEventListener('click', () => {
    if (!state.lightboxB64) return;
    sendToImg2img(state.lightboxB64); closeMediaBrowser();
  });
  $('media-lb-send-t2v').addEventListener('click', () => {
    sendToTxtVid(); closeMediaBrowser();
  });
  $('media-lb-send-i2v').addEventListener('click', () => {
    if (!state.lightboxB64) return;
    sendToVideo(state.lightboxB64); closeMediaBrowser();
  });

  // Lightbox swipe (mobile)
  let lbSwipeX = null;
  $('media-lb-stage').addEventListener('touchstart', e => { lbSwipeX = e.touches[0].clientX; }, { passive: true });
  $('media-lb-stage').addEventListener('touchend', e => {
    if (lbSwipeX === null) return;
    const dx = e.changedTouches[0].clientX - lbSwipeX;
    if (Math.abs(dx) > 48) dx > 0 ? mediaPrev() : mediaNext();
    lbSwipeX = null;
  });

  // Log panel
  $('btn-log-panel').addEventListener('click', () => {
    const panel = $('log-panel');
    const open  = panel.style.display === 'none' || panel.style.display === '';
    panel.style.display = open ? 'flex' : 'none';
    if (open) Log.rebuild();
  });
  $('btn-log-download').addEventListener('click', () => Log.download());
  $('btn-log-clear').addEventListener('click', () => Log.clear());
  $('btn-log-close').addEventListener('click', () => { $('log-panel').style.display = 'none'; });

  // Ctrl+Enter to generate
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); generate(); }
  });
}

// ===== Generation History Panel =====

function openHistoryPanel() {
  const panel = $('history-panel');
  const list  = $('history-list');
  list.innerHTML = '';

  if (!state.genHistory.length) {
    list.innerHTML = '<div class="history-empty">No previous generations</div>';
  } else {
    state.genHistory.forEach(entry => {
      const item = document.createElement('div');
      item.className = 'history-item';
      item.innerHTML = `
        <img class="history-thumb" src="${/^[A-Za-z0-9+/]+=*$/.test(entry.thumb || '') ? 'data:image/png;base64,' + entry.thumb : ''}" alt="">
        <div class="history-meta">
          <div class="history-prompt">${escapeHtml((entry.params.prompt || '').slice(0, 120))}</div>
          <div class="history-details">
            ${entry.tab} &bull;
            ${entry.params.width}×${entry.params.height} &bull;
            ${entry.params.sampler_name || ''} &bull;
            seed ${entry.seed >= 0 ? entry.seed : 'random'}
          </div>
          <div class="history-ts">${entry.ts}</div>
        </div>
        <button class="btn-sm history-restore" title="Restore params">Restore</button>
      `;
      item.querySelector('.history-restore').addEventListener('click', () => {
        restoreFromHistory(entry);
        closeHistoryPanel();
      });
      list.appendChild(item);
    });
  }
  panel.style.display = 'flex';
}

function closeHistoryPanel() {
  $('history-panel').style.display = 'none';
}

function restoreFromHistory(entry) {
  const p = entry.params;

  // Switch to the right tab
  switchTab(entry.tab === 'img2img' ? 'img2img' : entry.tab === 'video' ? 'video' : 'txt2img');

  // Common sidebar params
  if (p.sampler_name) $('sel-sampler').value = p.sampler_name;
  if (p.steps)        { $('range-steps').value = p.steps; $('val-steps').textContent = p.steps; }
  if (p.cfg_scale)    { $('range-cfg').value = p.cfg_scale; $('val-cfg').textContent = p.cfg_scale; }
  if (p.width)        $('inp-width').value  = p.width;
  if (p.height)       $('inp-height').value = p.height;
  if (p.seed != null) $('inp-seed').value   = p.seed >= 0 ? p.seed : -1;
  if (p.batch_size)   $('inp-batch-size').value  = p.batch_size;
  if (p.n_iter)       $('inp-batch-count').value = p.n_iter;

  // Prompt fields per tab
  if (entry.tab === 'txt2img') {
    if (p.prompt)          $('t2i-prompt').value    = p.prompt;
    if (p.negative_prompt !== undefined) $('t2i-negative').value  = p.negative_prompt;
  } else if (entry.tab === 'img2img') {
    if (p.prompt)          $('i2i-prompt').value    = p.prompt;
    if (p.negative_prompt !== undefined) $('i2i-negative').value  = p.negative_prompt;
  } else if (entry.tab === 'video') {
    if (p.prompt)          $('vid-prompt').value    = p.prompt;
    if (p.negative_prompt !== undefined) $('vid-negative').value  = p.negative_prompt;
    if (p.num_frames)      { $('range-frames').value = p.num_frames; $('val-frames').textContent = p.num_frames; }
  }

  toast('Parameters restored', 'success');
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ===== Boot =====

document.addEventListener('DOMContentLoaded', () => {
  loadHistory();
  initModalZoom();
  const saveCb = $('save-to-disk');
  if (saveCb) {
    saveCb.checked = localStorage.getItem(SAVE_KEY) === '1';
    saveCb.addEventListener('change', () => localStorage.setItem(SAVE_KEY, saveCb.checked ? '1' : '0'));
  }
  initMobile();
  initEvents();
  connect();
});
