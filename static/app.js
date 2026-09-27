/* ═══════════════════════════════════════════════════════════════
   app.js  –  Smart Home Guest UI
   Belongs to: templates/index.html
════════════════════════════════════════════════════════════════ */

'use strict';

// ─── Constants ───────────────────────────────────────────────────
const POLL_INTERVAL  = 8000;
const TOAST_DURATION = 2800;

const GROUP_ICONS = [
  '💡','🛋️','🛏️','🍳','🚿','🚗','🌿','🏠','🎮','🖥️',
  '📺','🎵','❄️','🔥','🚪','🌙','⭐','🏡','🧺','🪴',
];

// Display metadata for Home Assistant HVAC modes.
const HVAC_META = {
  off:       { label: 'Aus',           icon: '⏻'  },
  cool:      { label: 'Kühlen',        icon: '❄️' },
  heat:      { label: 'Heizen',        icon: '🔥' },
  auto:      { label: 'Automatik',     icon: '🔄' },
  heat_cool: { label: 'Heizen/Kühlen', icon: '🔄' },
  dry:       { label: 'Entfeuchten',   icon: '💧' },
  fan_only:  { label: 'Lüften',        icon: '🌀' },
};

// Fan speeds and swing positions, as Home Assistant spells them.
const MODE_LABELS = {
  off: 'Aus', on: 'An', auto: 'Automatik',
  low: 'Niedrig', medium: 'Mittel', mid: 'Mittel', middle: 'Mitte', high: 'Hoch',
  quiet: 'Leise', silent: 'Leise', focus: 'Fokus', diffuse: 'Diffus',
  vertical: 'Vertikal', horizontal: 'Horizontal', both: 'Beides',
  top: 'Oben', bottom: 'Unten', swing: 'Schwenken',
};

// How long a manual temperature change shields the readout from poll updates.
const CLIMATE_HOLD = 2500;

// ─── State ───────────────────────────────────────────────────────
const state = {
  groups:          [],
  isAdmin:         false,
  allEntities:     [],
  allSensors:      [],
  pollTimer:       null,
  firstRender:     true,   // first load → full rebuild
  editingGroup:    null,
  editingItems:    [],
  selectedIcon:    '💡',
  pickerSelected:  new Set(),
  editingSubgroup: null,
  subSelected:     new Set(),
  editingSensorIdx: null,
  sensorSelected:   null,
};

// ─── DOM shortcuts ────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const el = {
  groupsGrid:         $('groupsGrid'),
  emptyState:         $('emptyState'),
  skeletonState:      $('skeletonState'),
  connectionDot:      $('connectionDot'),
  adminBtn:           $('adminBtn'),
  adminPanel:         $('adminPanel'),
  adminCloseBtn:      $('adminCloseBtn'),
  logoutBtn:          $('logoutBtn'),
  adminGroupList:     $('adminGroupList'),
  addGroupBtn:        $('addGroupBtn'),
  groupEditor:        $('groupEditor'),
  editorBackBtn:      $('editorBackBtn'),
  editorTitle:        $('editorTitle'),
  editorSaveBtn:      $('editorSaveBtn'),
  groupNameInput:     $('groupNameInput'),
  iconPicker:         $('iconPicker'),
  editorItemsList:    $('editorItemsList'),
  addDeviceBtn:       $('addDeviceBtn'),
  addSubgroupBtn:     $('addSubgroupBtn'),
  devicePicker:       $('devicePicker'),
  devicePickerBack:   $('devicePickerBack'),
  devicePickerAdd:    $('devicePickerAdd'),
  devicePickerSearch: $('devicePickerSearch'),
  devicePickerList:   $('devicePickerList'),
  subgroupModal:      $('subgroupModal'),
  subgroupCancel:     $('subgroupCancel'),
  subgroupSave:       $('subgroupSave'),
  subgroupTitle:      $('subgroupTitle'),
  subgroupNameInput:  $('subgroupNameInput'),
  subgroupSearch:     $('subgroupSearch'),
  subgroupEntityList: $('subgroupEntityList'),
  sensorModal:        $('sensorModal'),
  sensorCancel:       $('sensorCancel'),
  sensorSave:         $('sensorSave'),
  sensorHint:         $('sensorHint'),
  sensorSearch:       $('sensorSearch'),
  sensorList:         $('sensorList'),
  loginModal:         $('loginModal'),
  closeLoginModal:    $('closeLoginModal'),
  loginForm:          $('loginForm'),
  passwordInput:      $('passwordInput'),
  loginError:         $('loginError'),
  loginBtnText:       $('loginBtnText'),
  loginSpinner:       $('loginSpinner'),
  backdrop:           $('backdrop'),
  toastContainer:     $('toastContainer'),
};

// ─── API ─────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}
const get  = path         => api(path);
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });

// ─── Init ─────────────────────────────────────────────────────────
async function init() {
  bindEvents();
  buildIconPicker();
  try {
    const auth = await get('/api/auth-status');
    state.isAdmin = auth.admin;
    updateAdminBtn();
  } catch (_) {}
  await loadGroups();
  startPolling();
}

// ══════════════════════════════════════════════════════════════════
//   LOAD & PATCH STRATEGY
//   First call  → full rebuild.
//   Subsequent polls → only update changed values in the DOM,
//                      cards stay stable (no flicker).
// ══════════════════════════════════════════════════════════════════

async function loadGroups() {
  try {
    const data      = await get('/api/groups');
    const newGroups = data.groups || [];
    setConnection(true);

    if (state.firstRender) {
      state.groups    = newGroups;
      state.firstRender = false;
      renderGroups();
    } else {
      patchGroups(newGroups);
    }
  } catch (_) {
    setConnection(false);
  }
}

// ── Full render (once on first load) ───────────────────────────
function renderGroups() {
  el.skeletonState.classList.add('hidden');
  if (state.groups.length === 0) {
    el.groupsGrid.innerHTML = '';
    el.emptyState.classList.remove('hidden');
    return;
  }
  el.emptyState.classList.add('hidden');
  el.groupsGrid.innerHTML = '';
  state.groups.forEach(group => el.groupsGrid.appendChild(buildGroupCard(group)));
}

// ── In-place patch (on every subsequent poll) ──────────────────
function patchGroups(newGroups) {
  const oldIds = state.groups.map(g => g.id).join('|');
  const newIds = newGroups.map(g => g.id).join('|');

  if (oldIds !== newIds) {
    // Group list changed structurally → full rebuild
    state.groups = newGroups;
    renderGroups();
    return;
  }

  newGroups.forEach((newGroup, gi) => {
    const card = el.groupsGrid.children[gi];
    if (!card) return;

    const oldGroup  = state.groups[gi];
    const oldItemId = (oldGroup.items  || []).map(i => i.id).join('|');
    const newItemId = (newGroup.items  || []).map(i => i.id).join('|');

    if (oldItemId !== newItemId) {
      // Items changed → replace this one card
      const newCard = buildGroupCard(newGroup);
      el.groupsGrid.replaceChild(newCard, card);
    } else {
      // Only states changed → minimal patch
      patchCard(card, newGroup);
    }
  });

  state.groups = newGroups;
}

function patchCard(card, group) {
  const items   = group.items || [];
  const total   = group.toggle_total ?? items.length;
  const onCount = group.on_count ?? items.filter(i => i.state === 'on').length;

  // Count badge
  const badge = card.querySelector('.group-on-count');
  if (badge) badge.textContent = `${onCount}/${total}`;

  // Master switch
  const masterCb = card.querySelector('.master-toggle input');
  if (masterCb && document.activeElement !== masterCb) {
    masterCb.checked = group.master_state === 'on';
  }

  // Item rows (device-row and subgroup-row)
  const rows = card.querySelectorAll('.device-row, .subgroup-row');
  items.forEach((item, idx) => {
    const row = rows[idx];
    if (!row) return;

    if (row.classList.contains('climate-row')) {
      patchClimateRow(row, item);
      return;
    }

    // Toggle
    const cb = row.querySelector('input[type=checkbox]');
    if (cb && document.activeElement !== cb) {
      cb.checked  = item.state === 'on';
      cb.disabled = item.state === 'unavailable';
    }

    // State label
    const sl = row.querySelector('.device-state-label, .subgroup-state-label');
    if (sl) sl.textContent = stateLabel(item.state);

    // Brightness slider
    const slider = row.querySelector('.slider');
    if (slider && document.activeElement !== slider) {
      const bri = item.attributes?.brightness;
      if (bri != null) slider.value = Math.round(bri);
      slider.disabled = item.state !== 'on';
    }

    // Color picker
    const cinp = row.querySelector('input[type=color]');
    if (cinp && document.activeElement !== cinp) {
      const rgb = item.attributes?.rgb_color
        || item.devices?.find(d => d.state === 'on')?.attributes?.rgb_color;
      if (rgb) {
        const hex = toHex(...rgb);
        cinp.value = hex;
        const btn = cinp.closest('.color-input-btn');
        if (btn) btn.style.background = hex;
      }
    }
  });
}

// ─── Polling ─────────────────────────────────────────────────────
function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(loadGroups, POLL_INTERVAL);
}
function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
}

// ══════════════════════════════════════════════════════════════════
//   BUILD CARDS
// ══════════════════════════════════════════════════════════════════

function buildGroupCard(group) {
  const items    = group.items || [];
  // Climate entities are standalone — the server leaves them out of the counts.
  const onCount  = group.on_count ?? items.filter(i => i.state === 'on').length;
  const total    = group.toggle_total ?? items.length;
  const masterOn = group.master_state === 'on';

  const card = mk('div', 'group-card');

  // ── Header ──────────────────────────────────────────────────
  const header = mk('div', 'group-card-header');
  header.innerHTML = `
    <span class="group-icon">${esc(group.icon)}</span>
    <span class="group-name">${esc(group.name)}</span>
    <span class="group-on-count">${onCount}/${total}</span>
    <label class="toggle master-toggle" title="Alle ein/aus">
      <input type="checkbox" ${masterOn ? 'checked' : ''} />
      <span class="toggle-slider"></span>
    </label>
  `;

  const masterCb   = header.querySelector('.master-toggle input');
  const countBadge = header.querySelector('.group-on-count');

  masterCb.addEventListener('change', async () => {
    const action = masterCb.checked ? 'turn_on' : 'turn_off';
    masterCb.disabled = true;
    try {
      await post('/api/control', { entity_ids: group.all_eids, action });
      const on = masterCb.checked;
      countBadge.textContent = on ? `${total}/${total}` : `0/${total}`;
      card.querySelectorAll(
        '.device-row:not(.climate-row) input[type=checkbox], .subgroup-row input[type=checkbox]'
      ).forEach(cb => { cb.checked = on; });
      card.querySelectorAll(
        '.device-state-label, .subgroup-state-label'
      ).forEach(sl => { sl.textContent = on ? 'An' : 'Aus'; });
    } catch (e) {
      masterCb.checked = !masterCb.checked;
      showToast('Fehler: ' + e.message, 'error');
    } finally {
      masterCb.disabled = false;
    }
  });

  card.appendChild(header);

  // ── Items ────────────────────────────────────────────────────
  const body = mk('div', 'group-devices');
  items.forEach(item => {
    let row;
    if (item.type === 'subgroup')      row = buildSubgroupRow(item, masterCb, countBadge, total);
    else if (item.domain === 'climate') row = buildClimateRow(item);
    else                                row = buildDeviceRow(item, masterCb, countBadge, total);
    body.appendChild(row);
  });
  card.appendChild(body);
  return card;
}

// ── Single device row ────────────────────────────────────────────
function buildDeviceRow(device, masterCb, countBadge, total) {
  const isOn   = device.state === 'on';
  const attrs  = device.attributes || {};
  const hasBri = device.domain === 'light';
  const hasCol = hasBri && (attrs.supported_color_modes || []).some(
    m => ['rgb','hs','xy','rgbw','rgbww'].includes(m)
  );

  const row = mk('div', 'device-row');

  const top = mk('div', 'device-top');
  top.innerHTML = `
    <span class="device-name" title="${esc(device.entity_id)}">${esc(device.friendly_name)}</span>
    <span class="device-state-label">${stateLabel(device.state)}</span>
    <label class="toggle toggle-wrap">
      <input type="checkbox" ${isOn ? 'checked' : ''} ${device.state === 'unavailable' ? 'disabled' : ''} />
      <span class="toggle-slider"></span>
    </label>
  `;
  row.appendChild(top);

  const cb = top.querySelector('input');
  const sl = top.querySelector('.device-state-label');

  cb.addEventListener('change', async () => {
    sl.textContent = cb.checked ? 'An' : 'Aus';
    syncCountBadge(card => card.querySelector('.group-on-count'), masterCb, countBadge, total);
    cb.disabled = true;
    try {
      await post('/api/control', {
        entity_id: device.entity_id,
        action: cb.checked ? 'turn_on' : 'turn_off',
      });
    } catch (e) {
      cb.checked = !cb.checked;
      sl.textContent = stateLabel(cb.checked ? 'on' : 'off');
      showToast('Fehler: ' + e.message, 'error');
    } finally {
      cb.disabled = false;
    }
  });

  // Brightness
  if (hasBri) {
    const bri    = attrs.brightness ?? 255;
    const briRow = mk('div', 'brightness-row');
    briRow.innerHTML = `
      <span class="brightness-icon">🔆</span>
      <input type="range" class="slider" min="1" max="255" value="${Math.round(bri)}" ${!isOn ? 'disabled' : ''} />
    `;
    const slider = briRow.querySelector('.slider');
    cb.addEventListener('change', () => { slider.disabled = !cb.checked; });
    let t = null;
    slider.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        try {
          await post('/api/control', {
            entity_id: device.entity_id, action: 'turn_on', brightness: +slider.value,
          });
        } catch (e) { showToast('Fehler: ' + e.message, 'error'); }
      }, 200);
    });
    row.appendChild(briRow);
  }

  // Color
  if (hasCol) {
    const rgb = attrs.rgb_color || [255, 255, 255];
    row.appendChild(buildColorRow([device.entity_id], rgb));
  }

  return row;
}

// ── Subgroup row ─────────────────────────────────────────────────
function buildSubgroupRow(item, masterCb, countBadge, total) {
  const isOn     = item.state === 'on';
  const attrs    = item.attributes || {};
  const devs     = item.devices || [];
  const devCount = devs.length;

  // Show brightness/color if the subgroup contains lights
  const colorModes = attrs.supported_color_modes || [];
  const hasBri     = devs.some(d => d.domain === 'light');
  const hasCol     = colorModes.some(m => ['rgb','hs','xy','rgbw','rgbww'].includes(m));

  const row = mk('div', 'subgroup-row');

  const top = mk('div', 'subgroup-top');
  top.innerHTML = `
    <span class="subgroup-icon">📦</span>
    <span class="subgroup-label">${esc(item.name)}</span>
    <span class="subgroup-count">${devCount}</span>
    <span class="subgroup-state-label">${stateLabel(item.state)}</span>
    <label class="toggle toggle-wrap">
      <input type="checkbox" ${isOn ? 'checked' : ''} ${item.state === 'unavailable' ? 'disabled' : ''} />
      <span class="toggle-slider"></span>
    </label>
  `;
  row.appendChild(top);

  const cb = top.querySelector('input');
  const sl = top.querySelector('.subgroup-state-label');

  cb.addEventListener('change', async () => {
    const action = cb.checked ? 'turn_on' : 'turn_off';
    sl.textContent = cb.checked ? 'An' : 'Aus';
    if (slider) slider.disabled = !cb.checked;
    cb.disabled = true;
    try {
      await post('/api/control', { entity_ids: item.entity_ids, action });
    } catch (e) {
      cb.checked = !cb.checked;
      sl.textContent = stateLabel(cb.checked ? 'on' : 'off');
      if (slider) slider.disabled = !cb.checked;
      showToast('Fehler: ' + e.message, 'error');
    } finally {
      cb.disabled = false;
    }
  });

  // Brightness — always show when lights are present
  let slider = null;
  if (hasBri) {
    const bri    = attrs.brightness ?? 255;
    const briRow = mk('div', 'brightness-row');
    briRow.innerHTML = `
      <span class="brightness-icon">🔆</span>
      <input type="range" class="slider" min="1" max="255" value="${Math.round(bri)}" ${!isOn ? 'disabled' : ''} />
    `;
    slider = briRow.querySelector('.slider');
    let t = null;
    slider.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        // Turn on when sliding from off state
        if (!cb.checked) {
          cb.checked = true;
          sl.textContent = 'An';
          slider.disabled = false;
        }
        try {
          await post('/api/control', {
            entity_ids: item.entity_ids, action: 'turn_on', brightness: +slider.value,
          });
        } catch (e) { showToast('Fehler: ' + e.message, 'error'); }
      }, 200);
    });
    row.appendChild(briRow);
  }

  // Color — always show when a color mode is present
  if (hasCol) {
    const onDev = devs.find(d => d.state === 'on' && d.attributes?.rgb_color);
    const rgb   = onDev?.attributes?.rgb_color || [255, 200, 100];
    const colorRow = buildColorRow(item.entity_ids, rgb, cb, sl, slider);
    row.appendChild(colorRow);
  }

  return row;
}

// ── Climate row ──────────────────────────────────────────────────
function buildClimateRow(device) {
  const c     = device.climate || {};
  const isOn  = device.state === 'on';
  const avail = device.state !== 'unavailable';

  const row = mk('div', `device-row climate-row${isOn ? '' : ' climate-off'}`);
  row.dataset.entityId = device.entity_id;
  // Remembered so the toggle can restore the mode the unit last ran in.
  row._lastMode  = (c.hvac_mode && c.hvac_mode !== 'off')
    ? c.hvac_mode
    : (c.hvac_modes || [])[0] || 'cool';
  row._targetTemp = c.target_temp;
  row._holdUntil  = 0;

  // ── Header ────────────────────────────────────────────────────
  const top = mk('div', 'device-top');
  top.innerHTML = `
    <span class="climate-icon">❄️</span>
    <span class="device-name" title="${esc(device.entity_id)}">${esc(device.friendly_name)}</span>
    <span class="climate-state-label">${esc(climateLabel(device))}</span>
    <label class="toggle toggle-wrap">
      <input type="checkbox" ${isOn ? 'checked' : ''} ${avail ? '' : 'disabled'} />
      <span class="toggle-slider"></span>
    </label>
  `;
  row.appendChild(top);

  const cb = top.querySelector('input');
  cb.addEventListener('change', async () => {
    const mode = cb.checked ? row._lastMode : 'off';
    setClimateOn(row, cb.checked, mode);
    cb.disabled = true;
    try {
      await post('/api/climate', { entity_id: device.entity_id, hvac_mode: mode });
    } catch (e) {
      cb.checked = !cb.checked;
      setClimateOn(row, cb.checked, cb.checked ? row._lastMode : 'off');
      showToast('Fehler: ' + e.message, 'error');
    } finally {
      cb.disabled = false;
    }
  });

  // ── Current temperature + target stepper ──────────────────────
  const tempRow = mk('div', 'climate-temp-row');
  tempRow.innerHTML = `
    <div class="climate-current" title="${esc(c.temp_source ? 'Sensor: ' + c.temp_source : device.entity_id)}">
      <span class="climate-current-value">${esc(tempText(c.current_temp))}</span>
      <span class="climate-current-label">Aktuell</span>
    </div>
    <div class="climate-stepper">
      <button type="button" class="step-btn" data-step="-1" aria-label="Zieltemperatur senken">−</button>
      <span class="climate-target">${esc(tempText(c.target_temp))}</span>
      <button type="button" class="step-btn" data-step="1" aria-label="Zieltemperatur erhöhen">+</button>
    </div>
  `;
  const targetEl = tempRow.querySelector('.climate-target');
  let tempTimer  = null;

  tempRow.querySelectorAll('.step-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const step = c.temp_step || 0.5;
      const min  = c.min_temp ?? 7;
      const max  = c.max_temp ?? 35;
      const base = row._targetTemp ?? c.current_temp ?? 22;
      const next = base + (+btn.dataset.step) * step;

      row._targetTemp = Math.min(max, Math.max(min, Math.round(next / step) * step));
      row._holdUntil  = Infinity;   // freeze the readout until the call settles
      targetEl.textContent = tempText(row._targetTemp);

      clearTimeout(tempTimer);
      tempTimer = setTimeout(async () => {
        await sendClimate(row, { temperature: row._targetTemp });
        row._holdUntil = Date.now() + CLIMATE_HOLD;
      }, 350);
    });
  });
  row.appendChild(tempRow);

  // ── HVAC modes ────────────────────────────────────────────────
  if ((c.hvac_modes || []).length) {
    row.appendChild(buildChipRow(
      'mode', 'Modus', c.hvac_modes, isOn ? c.hvac_mode : null,
      m => `${HVAC_META[m]?.icon || ''} ${HVAC_META[m]?.label || prettyMode(m)}`.trim(),
      (m, btn) => {
        row._lastMode = m;
        markChipActive(btn);
        setClimateOn(row, true, m);
        sendClimate(row, { hvac_mode: m });
      }
    ));
  }

  // ── Fan speed ─────────────────────────────────────────────────
  if ((c.fan_modes || []).length) {
    row.appendChild(buildChipRow(
      'fan', 'Lüfter', c.fan_modes, c.fan_mode, prettyMode,
      (m, btn) => { markChipActive(btn); sendClimate(row, { fan_mode: m }); }
    ));
  }

  // ── Oscillation (swing) ───────────────────────────────────────
  if ((c.swing_modes || []).length) {
    row.appendChild(buildChipRow(
      'swing', 'Oszillation', c.swing_modes, c.swing_mode, prettyMode,
      (m, btn) => { markChipActive(btn); sendClimate(row, { swing_mode: m }); }
    ));
  }

  return row;
}

// Send a climate command; any adjustment made while off also switches it on.
async function sendClimate(row, payload) {
  const body = { entity_id: row.dataset.entityId, ...payload };
  const cb   = row.querySelector('.toggle input');

  if (cb && !cb.checked && !('hvac_mode' in body)) {
    body.hvac_mode = row._lastMode;
    cb.checked = true;
    setClimateOn(row, true, row._lastMode);
    syncChips(row, 'mode', row._lastMode);
  }

  try {
    await post('/api/climate', body);
  } catch (e) {
    showToast('Fehler: ' + e.message, 'error');
  }
}

function patchClimateRow(row, item) {
  const c    = item.climate || {};
  const isOn = item.state === 'on';

  const cb = row.querySelector('.toggle input');
  if (cb && document.activeElement !== cb) {
    cb.checked  = isOn;
    cb.disabled = item.state === 'unavailable';
  }
  row.classList.toggle('climate-off', !isOn);

  const sl = row.querySelector('.climate-state-label');
  if (sl) sl.textContent = climateLabel(item);

  if (isOn && c.hvac_mode && c.hvac_mode !== 'off') row._lastMode = c.hvac_mode;

  const cur = row.querySelector('.climate-current-value');
  if (cur) cur.textContent = tempText(c.current_temp);

  // Don't overwrite a target the user just nudged.
  if (Date.now() >= (row._holdUntil || 0)) {
    row._targetTemp = c.target_temp;
    const tgt = row.querySelector('.climate-target');
    if (tgt) tgt.textContent = tempText(c.target_temp);
  }

  syncChips(row, 'mode',  isOn ? c.hvac_mode : null);
  syncChips(row, 'fan',   c.fan_mode);
  syncChips(row, 'swing', c.swing_mode);
}

// ── Chip row (reusable: modes, fan speeds, oscillation) ──────────
function buildChipRow(kind, label, modes, current, fmt, onPick) {
  const wrap = mk('div', 'chip-row');
  wrap.dataset.kind = kind;

  const lbl = mk('span', 'chip-row-label');
  lbl.textContent = label;
  wrap.appendChild(lbl);

  const chips = mk('div', 'chips');
  modes.forEach(m => {
    const btn = mk('button', `chip${m === current ? ' chip-active' : ''}`);
    btn.type         = 'button';
    btn.dataset.mode = m;
    btn.textContent  = fmt ? fmt(m) : prettyMode(m);
    btn.addEventListener('click', () => onPick(m, btn));
    chips.appendChild(btn);
  });
  wrap.appendChild(chips);
  return wrap;
}

function markChipActive(btn) {
  btn.parentElement.querySelectorAll('.chip')
     .forEach(c => c.classList.remove('chip-active'));
  btn.classList.add('chip-active');
}

function syncChips(row, kind, current) {
  const wrap = row.querySelector(`.chip-row[data-kind="${kind}"]`);
  if (!wrap) return;
  wrap.querySelectorAll('.chip').forEach(btn =>
    btn.classList.toggle('chip-active', btn.dataset.mode === current)
  );
}

// ── Color picker (reusable) ───────────────────────────────────────
function buildColorRow(entityIds, rgb, toggleCb, stateLabel, briSlider) {
  const hex      = toHex(...rgb);
  const colorRow = mk('div', 'color-row');
  colorRow.innerHTML = `
    <span class="color-label">Farbe</span>
    <button class="color-input-btn" style="background:${hex}" title="Farbe wählen">
      <input type="color" value="${hex}" />
    </button>
  `;
  const btn  = colorRow.querySelector('.color-input-btn');
  const cinp = colorRow.querySelector('input[type=color]');
  let ct = null;
  cinp.addEventListener('input', () => {
    btn.style.background = cinp.value;
    clearTimeout(ct);
    ct = setTimeout(async () => {
      // Turn on if currently off
      if (toggleCb && !toggleCb.checked) {
        toggleCb.checked = true;
        if (stateLabel) stateLabel.textContent = 'An';
        if (briSlider)  briSlider.disabled = false;
      }
      try {
        await post('/api/control', {
          entity_ids: entityIds, action: 'turn_on', rgb_color: fromHex(cinp.value),
        });
      } catch (e) { showToast('Fehler: ' + e.message, 'error'); }
    }, 300);
  });
  return colorRow;
}

// ─── Count badge sync ─────────────────────────────────────────────
function syncCountBadge(getCard, masterCb, countBadge, total) {
  if (!countBadge) return;
  const card = countBadge.closest('.group-card');
  if (!card) return;
  const cbs    = [...card.querySelectorAll('.device-row:not(.climate-row) input[type=checkbox], .subgroup-row input[type=checkbox]')];
  const onNow  = cbs.filter(c => c.checked).length;
  countBadge.textContent = `${onNow}/${total}`;
  if (masterCb && document.activeElement !== masterCb) masterCb.checked = onNow > 0;
}

// ══════════════════════════════════════════════════════════════════
//   ADMIN PANEL
// ══════════════════════════════════════════════════════════════════

function openAdminPanel() {
  el.adminPanel.classList.remove('hidden');
  requestAnimationFrame(() => el.adminPanel.classList.add('panel-open'));
  showBackdrop();
  renderAdminGroupList();
}

function closeAdminPanel() {
  el.adminPanel.classList.remove('panel-open');
  setTimeout(() => el.adminPanel.classList.add('hidden'), 350);
  hideBackdrop();
}

function renderAdminGroupList() {
  el.adminGroupList.innerHTML = '';
  if (state.groups.length === 0) {
    el.adminGroupList.innerHTML = `<p style="color:var(--text3);font-size:14px;text-align:center;padding:20px 0">
      Noch keine Gruppen vorhanden.</p>`;
    return;
  }
  state.groups.forEach(group => {
    const cnt  = (group.items || []).length;
    const item = mk('div', 'admin-group-item');
    item.innerHTML = `
      <span class="admin-group-icon">${esc(group.icon)}</span>
      <div class="admin-group-info">
        <div class="admin-group-name">${esc(group.name)}</div>
        <div class="admin-group-meta">${cnt} Element${cnt !== 1 ? 'e' : ''}</div>
      </div>
      <div class="admin-group-actions">
        <button class="edit-btn" title="Bearbeiten">✏️</button>
        <button class="del-btn"  title="Löschen">🗑️</button>
      </div>
    `;
    item.querySelector('.edit-btn').onclick = () => openGroupEditor(group);
    item.querySelector('.del-btn').onclick  = () => deleteGroup(group.id);
    el.adminGroupList.appendChild(item);
  });
}

async function deleteGroup(groupId) {
  if (!confirm('Diese Gruppe wirklich löschen?')) return;
  state.groups = state.groups.filter(g => g.id !== groupId);
  await saveGroupsToServer();
  renderAdminGroupList();
  state.firstRender = true;
  renderGroups();
}

// ══════════════════════════════════════════════════════════════════
//   GROUP EDITOR
// ══════════════════════════════════════════════════════════════════

function openGroupEditor(group = null) {
  state.editingGroup = group;
  state.editingItems = group ? JSON.parse(JSON.stringify(group.items || [])) : [];
  state.selectedIcon = group?.icon || '💡';

  el.editorTitle.textContent = group ? 'Gruppe bearbeiten' : 'Neue Gruppe';
  el.groupNameInput.value    = group?.name || '';
  updateIconPickerSelection();
  renderEditorItems();

  el.groupEditor.classList.remove('hidden');
  requestAnimationFrame(() => el.groupEditor.classList.add('panel-open'));

  if (state.allEntities.length === 0) loadEntities();
}

function closeGroupEditor() {
  el.groupEditor.classList.remove('panel-open');
  setTimeout(() => el.groupEditor.classList.add('hidden'), 350);
}

function renderEditorItems() {
  el.editorItemsList.innerHTML = '';
  if (state.editingItems.length === 0) {
    el.editorItemsList.innerHTML = `<p class="editor-empty-hint">Noch keine Geräte oder Untergruppen.</p>`;
    return;
  }
  state.editingItems.forEach((item, idx) => {
    const isSub     = item.type === 'subgroup';
    const isClimate = !isSub && String(item.entity_id || '').startsWith('climate.');
    const row       = mk('div', `editor-item${isSub ? ' editor-item--sub' : ''}`);
    const name      = isSub ? (item.name || 'Untergruppe') : friendlyNameOf(item.entity_id);

    let meta;
    if (isSub) {
      const n = (item.devices || []).length;
      meta = `${n} Gerät${n !== 1 ? 'e' : ''}`;
    } else if (isClimate && item.temp_sensor) {
      meta = `🌡️ ${sensorNameOf(item.temp_sensor)}`;
    } else {
      meta = item.entity_id || '';
    }

    const icon    = isSub ? '📦' : (isClimate ? '❄️' : '💡');
    const editBtn = isSub
      ? '<button class="editor-item-edit" title="Bearbeiten">✏️</button>'
      : (isClimate
          ? '<button class="editor-item-edit" title="Temperatursensor wählen">🌡️</button>'
          : '');

    row.innerHTML = `
      <span class="editor-item-icon">${icon}</span>
      <div class="editor-item-info">
        <div class="editor-item-name">${esc(name)}</div>
        <div class="editor-item-meta">${esc(meta)}</div>
      </div>
      <div class="editor-item-actions">
        ${editBtn}
        <button class="editor-item-del" title="Entfernen">✕</button>
      </div>
    `;
    if (isSub)          row.querySelector('.editor-item-edit').onclick = () => openSubgroupModal(item, idx);
    else if (isClimate) row.querySelector('.editor-item-edit').onclick = () => openSensorModal(item, idx);
    row.querySelector('.editor-item-del').onclick = () => {
      state.editingItems.splice(idx, 1);
      renderEditorItems();
    };
    el.editorItemsList.appendChild(row);
  });
}

function friendlyNameOf(entityId) {
  if (!entityId) return '?';
  return state.allEntities.find(e => e.entity_id === entityId)?.friendly_name || entityId;
}

function sensorNameOf(entityId) {
  if (!entityId) return '';
  return state.allSensors.find(s => s.entity_id === entityId)?.friendly_name || entityId;
}

async function saveGroup() {
  const name = el.groupNameInput.value.trim();
  if (!name) { el.groupNameInput.focus(); showToast('Bitte einen Namen eingeben', 'error'); return; }

  const groupData = {
    id:    state.editingGroup?.id || genId(),
    name,
    icon:  state.selectedIcon,
    items: state.editingItems,
  };

  if (state.editingGroup) {
    const idx = state.groups.findIndex(g => g.id === state.editingGroup.id);
    if (idx !== -1) state.groups[idx] = groupData; else state.groups.push(groupData);
  } else {
    state.groups.push(groupData);
  }

  try {
    await saveGroupsToServer();
    showToast('Gruppe gespeichert ✓', 'success');
    closeGroupEditor();
    renderAdminGroupList();
    state.firstRender = true;
    await loadGroups();
  } catch (e) {
    showToast('Fehler: ' + e.message, 'error');
  }
}

async function saveGroupsToServer() {
  const clean = state.groups.map(g => ({
    id: g.id, name: g.name, icon: g.icon,
    items: (g.items || []).map(item =>
      item.type === 'device'
        ? { id: item.id, type: 'device', entity_id: item.entity_id,
            temp_sensor: item.temp_sensor || null }
        : { id: item.id, type: 'subgroup', name: item.name,
            devices: deviceIds(item.devices || item.entity_ids) }
    ),
  }));
  await post('/api/admin/config', { groups: clean });
}

/*
 * /api/groups returns a subgroup's devices as full HA state objects, while the
 * admin config stores plain entity IDs. Accept either shape.
 */
function deviceIds(list) {
  return (list || [])
    .map(d => (typeof d === 'string' ? d : d?.entity_id))
    .filter(Boolean);
}

// ══════════════════════════════════════════════════════════════════
//   DEVICE PICKER
// ══════════════════════════════════════════════════════════════════

function openDevicePicker() {
  state.pickerSelected = new Set(
    state.editingItems.filter(i => i.type === 'device').map(i => i.entity_id)
  );
  el.devicePickerSearch.value = '';
  renderPickerList(state.allEntities);
  el.devicePicker.classList.remove('hidden');
  requestAnimationFrame(() => el.devicePicker.classList.add('panel-open'));
}

function closeDevicePicker() {
  el.devicePicker.classList.remove('panel-open');
  setTimeout(() => el.devicePicker.classList.add('hidden'), 350);
}

function renderPickerList(entities) {
  el.devicePickerList.innerHTML = '';
  if (!entities.length) {
    el.devicePickerList.innerHTML = '<div class="entity-loading">Keine Geräte gefunden.</div>';
    return;
  }
  entities.forEach(entity => {
    const row = buildEntityRow(entity, state.pickerSelected.has(entity.entity_id));
    row.addEventListener('click', () => {
      if (state.pickerSelected.has(entity.entity_id)) {
        state.pickerSelected.delete(entity.entity_id);
        row.classList.remove('selected');
      } else {
        state.pickerSelected.add(entity.entity_id);
        row.classList.add('selected');
      }
    });
    el.devicePickerList.appendChild(row);
  });
}

function confirmDevicePicker() {
  // Remove deselected device items
  state.editingItems = state.editingItems.filter(
    i => i.type !== 'device' || state.pickerSelected.has(i.entity_id)
  );
  // Add newly selected ones
  state.pickerSelected.forEach(eid => {
    if (!state.editingItems.find(i => i.type === 'device' && i.entity_id === eid)) {
      state.editingItems.push({ id: genId(), type: 'device', entity_id: eid });
    }
  });
  closeDevicePicker();
  renderEditorItems();
}

// ══════════════════════════════════════════════════════════════════
//   SUBGROUP MODAL
// ══════════════════════════════════════════════════════════════════

function openSubgroupModal(subgroup = null, editIdx = null) {
  state.editingSubgroup = subgroup ? { ...subgroup, editIdx } : null;
  el.subgroupTitle.textContent = subgroup ? 'Untergruppe bearbeiten' : 'Neue Untergruppe';
  el.subgroupNameInput.value   = subgroup?.name || '';
  state.subSelected            = new Set(deviceIds(subgroup?.devices || subgroup?.entity_ids));
  el.subgroupSearch.value      = '';
  renderSubgroupEntityList(toggleableEntities());
  el.subgroupModal.classList.remove('hidden');
  showBackdrop();
  setTimeout(() => el.subgroupNameInput.focus(), 150);
}

function closeSubgroupModal() {
  el.subgroupModal.classList.add('hidden');
  hideBackdrop();
}

function renderSubgroupEntityList(entities) {
  el.subgroupEntityList.innerHTML = '';
  if (!entities.length) {
    el.subgroupEntityList.innerHTML = '<div class="entity-loading">Keine Geräte gefunden.</div>';
    return;
  }
  entities.forEach(entity => {
    const row = buildEntityRow(entity, state.subSelected.has(entity.entity_id));
    row.addEventListener('click', () => {
      if (state.subSelected.has(entity.entity_id)) {
        state.subSelected.delete(entity.entity_id);
        row.classList.remove('selected');
      } else {
        state.subSelected.add(entity.entity_id);
        row.classList.add('selected');
      }
    });
    el.subgroupEntityList.appendChild(row);
  });
}

function saveSubgroup() {
  const name = el.subgroupNameInput.value.trim();
  if (!name)                        { el.subgroupNameInput.focus(); showToast('Bitte einen Namen eingeben', 'error'); return; }
  if (state.subSelected.size === 0) { showToast('Mindestens ein Gerät auswählen', 'error'); return; }

  const sg = {
    id:      state.editingSubgroup?.id || genId(),
    type:    'subgroup',
    name,
    devices: [...state.subSelected],
  };

  if (state.editingSubgroup?.editIdx != null) {
    state.editingItems[state.editingSubgroup.editIdx] = sg;
  } else {
    state.editingItems.push(sg);
  }
  closeSubgroupModal();
  renderEditorItems();
}

// ══════════════════════════════════════════════════════════════════
//   TEMPERATURE SENSOR MODAL
//   Lets a climate entity read its room temperature from a separate
//   sensor, because the reading built into an AC is often off.
// ══════════════════════════════════════════════════════════════════

function openSensorModal(item, idx) {
  state.editingSensorIdx = idx;
  state.sensorSelected   = item.temp_sensor || null;
  el.sensorHint.textContent =
    `Für „${friendlyNameOf(item.entity_id)}“: ersetzt den eingebauten Messwert der Klimaanlage.`;
  el.sensorSearch.value = '';
  renderSensorList(state.allSensors);
  el.sensorModal.classList.remove('hidden');
  showBackdrop();
}

function closeSensorModal() {
  el.sensorModal.classList.add('hidden');
  hideBackdrop();
}

function renderSensorList(sensors) {
  el.sensorList.innerHTML = '';

  // First entry always falls back to the unit's own reading.
  const none = mk('div', `entity-item${state.sensorSelected ? '' : ' selected'}`);
  none.innerHTML = `
    <div class="entity-check"><span class="entity-check-mark">✓</span></div>
    <div class="entity-info">
      <div class="entity-fname">Sensor der Klimaanlage</div>
      <div class="entity-id">Eingebauter Messwert des Geräts</div>
    </div>
  `;
  none.addEventListener('click', () => { state.sensorSelected = null; markSensor(null); });
  el.sensorList.appendChild(none);

  if (!sensors.length) {
    const empty = mk('div', 'entity-loading');
    empty.textContent = 'Keine Temperatursensoren gefunden.';
    el.sensorList.appendChild(empty);
    return;
  }

  sensors.forEach(s => {
    const row = mk('div', `entity-item${state.sensorSelected === s.entity_id ? ' selected' : ''}`);
    row.dataset.sensor = s.entity_id;
    row.innerHTML = `
      <div class="entity-check"><span class="entity-check-mark">✓</span></div>
      <div class="entity-info">
        <div class="entity-fname">${esc(s.friendly_name)}</div>
        <div class="entity-id">${esc(s.entity_id)}</div>
      </div>
      <span class="entity-domain-badge sensor">${esc(sensorReading(s))}</span>
    `;
    row.addEventListener('click', () => { state.sensorSelected = s.entity_id; markSensor(s.entity_id); });
    el.sensorList.appendChild(row);
  });
}

function markSensor(entityId) {
  el.sensorList.querySelectorAll('.entity-item').forEach(row =>
    row.classList.toggle('selected', (row.dataset.sensor || null) === entityId)
  );
}

function sensorReading(sensor) {
  const v = Number(sensor.state);
  if (Number.isNaN(v)) return '–';
  return tempText(v).slice(0, -1) + ' ' + (sensor.unit || '°C');
}

function saveSensor() {
  const idx  = state.editingSensorIdx;
  const item = idx != null ? state.editingItems[idx] : null;
  if (item) item.temp_sensor = state.sensorSelected || null;
  closeSensorModal();
  renderEditorItems();
}

// ─── Entity row (reusable) ────────────────────────────────────────
function buildEntityRow(entity, isSelected) {
  const row = mk('div', `entity-item${isSelected ? ' selected' : ''}`);
  row.innerHTML = `
    <div class="entity-check"><span class="entity-check-mark">✓</span></div>
    <div class="entity-info">
      <div class="entity-fname">${esc(entity.friendly_name)}</div>
      <div class="entity-id">${esc(entity.entity_id)}</div>
    </div>
    <span class="entity-domain-badge ${entity.domain}">${entity.domain}</span>
  `;
  return row;
}

// ─── Load entities ────────────────────────────────────────────────
async function loadEntities() {
  try {
    const data = await get('/api/admin/entities');
    state.allEntities = data.entities || [];
    state.allSensors  = data.sensors  || [];
    if (!el.devicePicker.classList.contains('hidden'))  renderPickerList(state.allEntities);
    if (!el.subgroupModal.classList.contains('hidden')) renderSubgroupEntityList(toggleableEntities());
    if (!el.sensorModal.classList.contains('hidden'))   renderSensorList(state.allSensors);
  } catch (e) {
    console.error('Failed to load entities:', e);
  }
}

// ─── Icon picker ──────────────────────────────────────────────────
function buildIconPicker() {
  GROUP_ICONS.forEach(icon => {
    const btn       = mk('button', 'icon-option');
    btn.type        = 'button';
    btn.textContent = icon;
    btn.dataset.icon = icon;
    btn.onclick = () => { state.selectedIcon = icon; updateIconPickerSelection(); };
    el.iconPicker.appendChild(btn);
  });
}

function updateIconPickerSelection() {
  el.iconPicker.querySelectorAll('.icon-option').forEach(btn =>
    btn.classList.toggle('selected', btn.dataset.icon === state.selectedIcon)
  );
}

// ══════════════════════════════════════════════════════════════════
//   LOGIN
// ══════════════════════════════════════════════════════════════════

function showLoginModal() {
  el.loginModal.classList.remove('hidden');
  showBackdrop();
  el.loginError.classList.add('hidden');
  el.passwordInput.value = '';
  setTimeout(() => el.passwordInput.focus(), 100);
}

function hideLoginModal() {
  el.loginModal.classList.add('hidden');
  hideBackdrop();
}

async function doLogin(e) {
  e.preventDefault();
  const pw = el.passwordInput.value;
  if (!pw) return;
  el.loginBtnText.textContent = 'Anmelden…';
  el.loginSpinner.classList.remove('hidden');
  el.loginError.classList.add('hidden');
  try {
    await post('/api/login', { password: pw });
    state.isAdmin = true;
    updateAdminBtn();
    hideLoginModal();
    openAdminPanel();
    loadEntities();
  } catch (_) {
    el.loginError.classList.remove('hidden');
    el.passwordInput.select();
  } finally {
    el.loginBtnText.textContent = 'Anmelden';
    el.loginSpinner.classList.add('hidden');
  }
}

async function doLogout() {
  await post('/api/logout', {});
  state.isAdmin = false;
  updateAdminBtn();
  closeAdminPanel();
  showToast('Abgemeldet', 'success');
}

function updateAdminBtn() {
  el.adminBtn.classList.toggle('admin-active', state.isAdmin);
  el.adminBtn.title = state.isAdmin ? 'Admin öffnen' : 'Admin-Anmeldung';
}

// ══════════════════════════════════════════════════════════════════
//   HELPERS
// ══════════════════════════════════════════════════════════════════

function stateLabel(s) {
  return s === 'on' ? 'An' : s === 'unavailable' ? 'N/V' : 'Aus';
}

function climateLabel(item) {
  if (item.state === 'unavailable') return 'N/V';
  if (item.state !== 'on')          return 'Aus';
  const mode = item.climate?.hvac_mode;
  return HVAC_META[mode]?.label || prettyMode(mode);
}

// Reflect an on/off change on a climate row without waiting for the next poll.
function setClimateOn(row, on, mode) {
  row.classList.toggle('climate-off', !on);
  const cb = row.querySelector('.toggle input');
  if (cb) cb.checked = on;
  const sl = row.querySelector('.climate-state-label');
  if (sl) sl.textContent = on ? (HVAC_META[mode]?.label || prettyMode(mode)) : 'Aus';
}

function tempText(v) {
  if (v == null || Number.isNaN(Number(v))) return '–';
  const n = Math.round(Number(v) * 10) / 10;
  // German decimal comma.
  return (Number.isInteger(n) ? String(n) : n.toFixed(1).replace('.', ',')) + '°';
}

function prettyMode(m) {
  const key = String(m ?? '').toLowerCase();
  if (MODE_LABELS[key]) return MODE_LABELS[key];
  return String(m ?? '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, ch => ch.toUpperCase());
}

// Subgroups and the master switch cover lights and switches only.
function toggleableEntities() {
  return state.allEntities.filter(e => e.domain !== 'climate');
}

function setConnection(ok) {
  el.connectionDot.className = `conn-dot ${ok ? 'conn-ok' : 'conn-error'}`;
  el.connectionDot.title     = ok ? 'Verbunden' : 'Verbindungsfehler';
}

function showBackdrop() { el.backdrop.classList.remove('hidden'); }
function hideBackdrop()  { el.backdrop.classList.add('hidden'); }

function showToast(msg, type = '') {
  const t = mk('div', `toast${type ? ' toast-' + type : ''}`);
  t.textContent = msg;
  el.toastContainer.appendChild(t);
  setTimeout(() => {
    t.classList.add('toast-out');
    setTimeout(() => t.remove(), 300);
  }, TOAST_DURATION);
}

function mk(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function genId() {
  return 'i_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function toHex(r, g, b) {
  return '#' + [r,g,b].map(v => Math.max(0,Math.min(255,v)).toString(16).padStart(2,'0')).join('');
}

function fromHex(hex) {
  const m = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  return m ? [parseInt(m[1],16), parseInt(m[2],16), parseInt(m[3],16)] : [255,255,255];
}

// ══════════════════════════════════════════════════════════════════
//   EVENT BINDING
// ══════════════════════════════════════════════════════════════════

function bindEvents() {
  el.adminBtn.addEventListener('click', () => {
    if (state.isAdmin) openAdminPanel(); else showLoginModal();
  });

  // Admin panel
  el.adminCloseBtn.addEventListener('click', closeAdminPanel);
  el.logoutBtn.addEventListener('click', doLogout);
  el.addGroupBtn.addEventListener('click', () => openGroupEditor(null));

  // Group editor
  el.editorBackBtn.addEventListener('click', closeGroupEditor);
  el.editorSaveBtn.addEventListener('click', saveGroup);
  el.addDeviceBtn.addEventListener('click', () => {
    if (state.allEntities.length === 0) loadEntities().then(openDevicePicker);
    else openDevicePicker();
  });
  el.addSubgroupBtn.addEventListener('click', () => {
    if (state.allEntities.length === 0) loadEntities().then(() => openSubgroupModal());
    else openSubgroupModal();
  });

  // Device picker
  el.devicePickerBack.addEventListener('click', closeDevicePicker);
  el.devicePickerAdd.addEventListener('click', confirmDevicePicker);
  el.devicePickerSearch.addEventListener('input', () => {
    const q = el.devicePickerSearch.value.toLowerCase();
    renderPickerList(q
      ? state.allEntities.filter(e => e.friendly_name.toLowerCase().includes(q) || e.entity_id.toLowerCase().includes(q))
      : state.allEntities
    );
  });

  // Subgroup modal
  el.subgroupCancel.addEventListener('click', closeSubgroupModal);
  el.subgroupSave.addEventListener('click', saveSubgroup);
  el.subgroupNameInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); saveSubgroup(); } });
  el.subgroupSearch.addEventListener('input', () => {
    const q    = el.subgroupSearch.value.toLowerCase();
    const pool = toggleableEntities();
    renderSubgroupEntityList(q
      ? pool.filter(e => e.friendly_name.toLowerCase().includes(q) || e.entity_id.toLowerCase().includes(q))
      : pool
    );
  });

  // Sensor modal
  el.sensorCancel.addEventListener('click', closeSensorModal);
  el.sensorSave.addEventListener('click', saveSensor);
  el.sensorSearch.addEventListener('input', () => {
    const q = el.sensorSearch.value.toLowerCase();
    renderSensorList(q
      ? state.allSensors.filter(s => s.friendly_name.toLowerCase().includes(q) || s.entity_id.toLowerCase().includes(q))
      : state.allSensors
    );
  });

  // Login
  el.closeLoginModal.addEventListener('click', hideLoginModal);
  el.loginForm.addEventListener('submit', doLogin);
  el.passwordInput.addEventListener('keydown', e => { if (e.key === 'Escape') hideLoginModal(); });

  // Backdrop
  el.backdrop.addEventListener('click', () => {
    if (!el.sensorModal.classList.contains('hidden'))   { closeSensorModal(); return; }
    if (!el.subgroupModal.classList.contains('hidden')) { closeSubgroupModal(); return; }
    if (!el.devicePicker.classList.contains('hidden'))  { return; } // picker has its own back button
    if (!el.groupEditor.classList.contains('hidden'))   { return; }
    if (!el.loginModal.classList.contains('hidden'))    { hideLoginModal(); return; }
    closeAdminPanel();
  });

  // Escape key
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!el.sensorModal.classList.contains('hidden'))   { closeSensorModal(); return; }
    if (!el.subgroupModal.classList.contains('hidden')) { closeSubgroupModal(); return; }
    if (!el.devicePicker.classList.contains('hidden'))  { closeDevicePicker(); return; }
    if (!el.groupEditor.classList.contains('hidden'))   { closeGroupEditor(); return; }
    if (!el.loginModal.classList.contains('hidden'))    { hideLoginModal(); return; }
    if (!el.adminPanel.classList.contains('hidden'))    { closeAdminPanel(); return; }
  });

  // Pause polling when tab is hidden
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopPolling();
    else { loadGroups(); startPolling(); }
  });
}

// ─── Start ───────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
