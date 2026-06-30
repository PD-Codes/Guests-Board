/* ═══════════════════════════════════════════════════════════════
   app.js  –  Smart Home Guest UI
   Gehört zu: templates/index.html
════════════════════════════════════════════════════════════════ */

'use strict';

// ─── Konstanten ──────────────────────────────────────────────────
const POLL_INTERVAL  = 8000;
const TOAST_DURATION = 2800;

const GROUP_ICONS = [
  '💡','🛋️','🛏️','🍳','🚿','🚗','🌿','🏠','🎮','🖥️',
  '📺','🎵','❄️','🔥','🚪','🌙','⭐','🏡','🧺','🪴',
];

// ─── State ───────────────────────────────────────────────────────
const state = {
  groups:          [],
  isAdmin:         false,
  allEntities:     [],
  pollTimer:       null,
  firstRender:     true,   // erstes Laden → komplett aufbauen
  editingGroup:    null,
  editingItems:    [],
  selectedIcon:    '💡',
  pickerSelected:  new Set(),
  editingSubgroup: null,
  subSelected:     new Set(),
};

// ─── DOM-Shortcuts ────────────────────────────────────────────────
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
//   LADEN & PATCH-STRATEGIE
//   Erster Aufruf → komplett aufbauen.
//   Folge-Polls  → nur geänderte Werte im DOM aktualisieren,
//                  Karten bleiben stabil (kein Flackern).
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

// ── Vollständiges Rendern (einmalig beim ersten Laden) ──────────
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

// ── In-Place Patch (bei jedem Poll danach) ─────────────────────
function patchGroups(newGroups) {
  const oldIds = state.groups.map(g => g.id).join('|');
  const newIds = newGroups.map(g => g.id).join('|');

  if (oldIds !== newIds) {
    // Gruppen-Liste hat sich strukturell geändert → neu aufbauen
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
      // Items geändert → diese eine Karte austauschen
      const newCard = buildGroupCard(newGroup);
      el.groupsGrid.replaceChild(newCard, card);
    } else {
      // Nur Zustände geändert → minimal patchen
      patchCard(card, newGroup);
    }
  });

  state.groups = newGroups;
}

function patchCard(card, group) {
  const items  = group.items || [];
  const onCount = items.filter(i => i.state === 'on').length;

  // Zähler-Badge
  const badge = card.querySelector('.group-on-count');
  if (badge) badge.textContent = `${onCount}/${items.length}`;

  // Hauptschalter
  const masterCb = card.querySelector('.master-toggle input');
  if (masterCb && document.activeElement !== masterCb) {
    masterCb.checked = group.master_state === 'on';
  }

  // Item-Zeilen (device-row und subgroup-row)
  const rows = card.querySelectorAll('.device-row, .subgroup-row');
  items.forEach((item, idx) => {
    const row = rows[idx];
    if (!row) return;

    // Toggle
    const cb = row.querySelector('input[type=checkbox]');
    if (cb && document.activeElement !== cb) {
      cb.checked  = item.state === 'on';
      cb.disabled = item.state === 'unavailable';
    }

    // State-Label
    const sl = row.querySelector('.device-state-label, .subgroup-state-label');
    if (sl) sl.textContent = stateLabel(item.state);

    // Helligkeit-Slider
    const slider = row.querySelector('.slider');
    if (slider && document.activeElement !== slider) {
      const bri = item.attributes?.brightness;
      if (bri != null) slider.value = Math.round(bri);
      slider.disabled = item.state !== 'on';
    }

    // Farb-Picker
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
//   KARTEN BAUEN
// ══════════════════════════════════════════════════════════════════

function buildGroupCard(group) {
  const items    = group.items || [];
  const onCount  = items.filter(i => i.state === 'on').length;
  const total    = items.length;
  const masterOn = group.master_state === 'on';

  const card = mk('div', 'group-card');

  // ── Header ──────────────────────────────────────────────────
  const header = mk('div', 'group-card-header');
  header.innerHTML = `
    <span class="group-icon">${esc(group.icon)}</span>
    <span class="group-name">${esc(group.name)}</span>
    <span class="group-on-count">${onCount}/${total}</span>
    <label class="toggle master-toggle" title="Alle an/aus">
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
        '.device-row input[type=checkbox], .subgroup-row input[type=checkbox]'
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
    body.appendChild(
      item.type === 'subgroup'
        ? buildSubgroupRow(item, masterCb, countBadge, total)
        : buildDeviceRow(item, masterCb, countBadge, total)
    );
  });
  card.appendChild(body);
  return card;
}

// ── Einzelgerät-Zeile ────────────────────────────────────────────
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

  // Helligkeit
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

  // Farbe
  if (hasCol) {
    const rgb = attrs.rgb_color || [255, 255, 255];
    row.appendChild(buildColorRow([device.entity_id], rgb));
  }

  return row;
}

// ── Untergruppen-Zeile ────────────────────────────────────────────
function buildSubgroupRow(item, masterCb, countBadge, total) {
  const isOn     = item.state === 'on';
  const attrs    = item.attributes || {};
  const devs     = item.devices || [];
  const devCount = devs.length;

  // Hat die Untergruppe Lampen → Helligkeit/Farbe zeigen
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

  // Helligkeit – immer zeigen wenn Lampen vorhanden
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
        // Beim ersten Bewegen einschalten falls noch aus
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

  // Farbe – immer zeigen wenn Farbmodus vorhanden
  if (hasCol) {
    const onDev = devs.find(d => d.state === 'on' && d.attributes?.rgb_color);
    const rgb   = onDev?.attributes?.rgb_color || [255, 200, 100];
    const colorRow = buildColorRow(item.entity_ids, rgb, cb, sl, slider);
    row.appendChild(colorRow);
  }

  return row;
}

// ── Farb-Picker (wiederverwendbar) ────────────────────────────────
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
      // Einschalten falls aus
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

// ─── Zähler-Badge sync ────────────────────────────────────────────
function syncCountBadge(getCard, masterCb, countBadge, total) {
  if (!countBadge) return;
  // Zähle alle gecheckte Toggles in der Karte
  const card = countBadge.closest('.group-card');
  if (!card) return;
  const cbs    = [...card.querySelectorAll('.device-row input[type=checkbox], .subgroup-row input[type=checkbox]')];
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
      Noch keine Gruppen. Füge eine hinzu!</p>`;
    return;
  }
  state.groups.forEach(group => {
    const cnt  = (group.items || []).length;
    const item = mk('div', 'admin-group-item');
    item.innerHTML = `
      <span class="admin-group-icon">${esc(group.icon)}</span>
      <div class="admin-group-info">
        <div class="admin-group-name">${esc(group.name)}</div>
        <div class="admin-group-meta">${cnt} Eintrag${cnt !== 1 ? 'e' : ''}</div>
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
  if (!confirm('Gruppe wirklich löschen?')) return;
  state.groups = state.groups.filter(g => g.id !== groupId);
  await saveGroupsToServer();
  renderAdminGroupList();
  // Karten neu aufbauen
  state.firstRender = true;
  renderGroups();
}

// ══════════════════════════════════════════════════════════════════
//   GRUPPEN-EDITOR
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
    const isSub = item.type === 'subgroup';
    const row   = mk('div', `editor-item${isSub ? ' editor-item--sub' : ''}`);
    const name  = isSub ? (item.name || 'Untergruppe') : friendlyNameOf(item.entity_id);
    const meta  = isSub
      ? `${(item.devices||[]).length} Gerät${(item.devices||[]).length !== 1 ? 'e' : ''}`
      : (item.entity_id || '');
    row.innerHTML = `
      <span class="editor-item-icon">${isSub ? '📦' : '💡'}</span>
      <div class="editor-item-info">
        <div class="editor-item-name">${esc(name)}</div>
        <div class="editor-item-meta">${esc(meta)}</div>
      </div>
      <div class="editor-item-actions">
        ${isSub ? `<button class="editor-item-edit" title="Bearbeiten">✏️</button>` : ''}
        <button class="editor-item-del" title="Entfernen">✕</button>
      </div>
    `;
    if (isSub) row.querySelector('.editor-item-edit').onclick = () => openSubgroupModal(item, idx);
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
        ? { id: item.id, type: 'device', entity_id: item.entity_id }
        : { id: item.id, type: 'subgroup', name: item.name, devices: item.devices || item.entity_ids || [] }
    ),
  }));
  await post('/api/admin/config', { groups: clean });
}

// ══════════════════════════════════════════════════════════════════
//   GERÄTE-PICKER
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
  // Nicht mehr ausgewählte device-Items entfernen
  state.editingItems = state.editingItems.filter(
    i => i.type !== 'device' || state.pickerSelected.has(i.entity_id)
  );
  // Neue hinzufügen
  state.pickerSelected.forEach(eid => {
    if (!state.editingItems.find(i => i.type === 'device' && i.entity_id === eid)) {
      state.editingItems.push({ id: genId(), type: 'device', entity_id: eid });
    }
  });
  closeDevicePicker();
  renderEditorItems();
}

// ══════════════════════════════════════════════════════════════════
//   UNTERGRUPPEN-MODAL
// ══════════════════════════════════════════════════════════════════

function openSubgroupModal(subgroup = null, editIdx = null) {
  state.editingSubgroup = subgroup ? { ...subgroup, editIdx } : null;
  el.subgroupTitle.textContent = subgroup ? 'Untergruppe bearbeiten' : 'Neue Untergruppe';
  el.subgroupNameInput.value   = subgroup?.name || '';
  state.subSelected            = new Set(subgroup?.devices || subgroup?.entity_ids || []);
  el.subgroupSearch.value      = '';
  renderSubgroupEntityList(state.allEntities);
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
  if (!name)                   { el.subgroupNameInput.focus(); showToast('Bitte einen Namen eingeben', 'error'); return; }
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

// ─── Entity-Zeile (wiederverwendbar) ─────────────────────────────
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

// ─── Entities laden ───────────────────────────────────────────────
async function loadEntities() {
  try {
    const data = await get('/api/admin/entities');
    state.allEntities = data.entities || [];
    if (!el.devicePicker.classList.contains('hidden'))  renderPickerList(state.allEntities);
    if (!el.subgroupModal.classList.contains('hidden')) renderSubgroupEntityList(state.allEntities);
  } catch (e) {
    console.error('Entities laden fehlgeschlagen:', e);
  }
}

// ─── Icon-Picker ──────────────────────────────────────────────────
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
  el.adminBtn.title = state.isAdmin ? 'Admin öffnen' : 'Admin-Login';
}

// ══════════════════════════════════════════════════════════════════
//   HILFSFUNKTIONEN
// ══════════════════════════════════════════════════════════════════

function stateLabel(s) {
  return s === 'on' ? 'An' : s === 'unavailable' ? 'N/A' : 'Aus';
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
//   EVENT-BINDING
// ══════════════════════════════════════════════════════════════════

function bindEvents() {
  el.adminBtn.addEventListener('click', () => {
    if (state.isAdmin) openAdminPanel(); else showLoginModal();
  });

  // Admin Panel
  el.adminCloseBtn.addEventListener('click', closeAdminPanel);
  el.logoutBtn.addEventListener('click', doLogout);
  el.addGroupBtn.addEventListener('click', () => openGroupEditor(null));

  // Gruppen-Editor
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

  // Device-Picker
  el.devicePickerBack.addEventListener('click', closeDevicePicker);
  el.devicePickerAdd.addEventListener('click', confirmDevicePicker);
  el.devicePickerSearch.addEventListener('input', () => {
    const q = el.devicePickerSearch.value.toLowerCase();
    renderPickerList(q
      ? state.allEntities.filter(e => e.friendly_name.toLowerCase().includes(q) || e.entity_id.toLowerCase().includes(q))
      : state.allEntities
    );
  });

  // Untergruppen-Modal
  el.subgroupCancel.addEventListener('click', closeSubgroupModal);
  el.subgroupSave.addEventListener('click', saveSubgroup);
  el.subgroupNameInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); saveSubgroup(); } });
  el.subgroupSearch.addEventListener('input', () => {
    const q = el.subgroupSearch.value.toLowerCase();
    renderSubgroupEntityList(q
      ? state.allEntities.filter(e => e.friendly_name.toLowerCase().includes(q) || e.entity_id.toLowerCase().includes(q))
      : state.allEntities
    );
  });

  // Login
  el.closeLoginModal.addEventListener('click', hideLoginModal);
  el.loginForm.addEventListener('submit', doLogin);
  el.passwordInput.addEventListener('keydown', e => { if (e.key === 'Escape') hideLoginModal(); });

  // Backdrop
  el.backdrop.addEventListener('click', () => {
    if (!el.subgroupModal.classList.contains('hidden')) { closeSubgroupModal(); return; }
    if (!el.devicePicker.classList.contains('hidden'))  { return; } // Picker hat eigenen Back-Button
    if (!el.groupEditor.classList.contains('hidden'))   { return; }
    if (!el.loginModal.classList.contains('hidden'))    { hideLoginModal(); return; }
    closeAdminPanel();
  });

  // Escape
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!el.subgroupModal.classList.contains('hidden')) { closeSubgroupModal(); return; }
    if (!el.devicePicker.classList.contains('hidden'))  { closeDevicePicker(); return; }
    if (!el.groupEditor.classList.contains('hidden'))   { closeGroupEditor(); return; }
    if (!el.loginModal.classList.contains('hidden'))    { hideLoginModal(); return; }
    if (!el.adminPanel.classList.contains('hidden'))    { closeAdminPanel(); return; }
  });

  // Tab-Wechsel → Polling pausieren
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopPolling();
    else { loadGroups(); startPolling(); }
  });
}

// ─── Start ───────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
