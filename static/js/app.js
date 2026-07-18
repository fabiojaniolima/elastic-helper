'use strict';

// ─── State ───────────────────────────────────────────────
let dashboardData = null;
let currentSort = { col: null, dir: 'asc' };
let currentRows = [];
let currentMetric = null;
const detailNavStack = [];
let tasksList = [];
let selectedActions = new Set();
let expandedTasks = new Set();   // ids de tarefas-pai com as sub-tarefas (slices) expandidas
let clusterHealthFilters = new Set();

// ─── Utilities ───────────────────────────────────────────
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + units[i];
}

function parseSizeStr(str) {
  if (!str || str === '-') return 0;
  const units = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };
  const m = String(str).toLowerCase().match(/^([\d.]+)\s*([a-z]+)$/);
  if (!m) return parseFloat(str) || 0;
  return parseFloat(m[1]) * (units[m[2]] || 1);
}

function fmtNum(n) {
  if (n == null || n === '') return '-';
  return Number(n).toLocaleString('pt-BR');
}

function fmtMillisDate(ms) {
  if (!ms) return '-';
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} às ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtNanosToSecs(ns) {
  const totalSecs = ns / 1e9;
  if (totalSecs < 60) return totalSecs.toFixed(1) + 's';
  const totalMins = totalSecs / 60;
  if (totalMins < 60) return totalMins.toFixed(1) + 'm';
  return (totalMins / 60).toFixed(1) + 'h';
}

function fmtDuration(ms) {
  if (!ms || ms <= 0) return '0s';
  if (ms < 1000) return Math.round(ms) + 'ms';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const totalM = Math.floor(s / 60);
  if (totalM < 60) return totalM + 'm';
  const h = Math.floor(totalM / 60);
  const m = totalM % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function pctColor(pct) {
  if (pct >= 80) return 'red';
  if (pct >= 65) return 'yellow';
  return 'green';
}

function healthColor(status) {
  return { green: 'green', yellow: 'yellow', red: 'red' }[status] || 'gray';
}

// `topic` (opcional) torna o "?" clicável: o hover continua mostrando o resumo,
// mas o clique leva à página de Ajuda, direto na explicação detalhada do card.
function tooltip(text, topic) {
  if (topic) {
    return `<div class="tooltip-wrap">
    <div class="tooltip-btn tooltip-btn-link" onclick="event.stopPropagation();goToHelp('${topic}')">?</div>
    <div class="tooltip-box">${text}<div class="tooltip-help-hint"><i class="fas fa-circle-question"></i> Clique no <strong>?</strong> para abrir a ajuda detalhada</div></div>
  </div>`;
  }
  return `<div class="tooltip-wrap">
    <div class="tooltip-btn">?</div>
    <div class="tooltip-box">${text}</div>
  </div>`;
}

// ─── Connection ───────────────────────────────────────────
// Conexão atualmente em edição (null = nova/ad-hoc)
let editingConnId = null;

// Faz o parse de um Host colado com protocolo e/ou porta embutidos
// ("https://localhost:9200") separando protocolo (→ HTTPS), endereço e porta.
// Parser puro (não toca no DOM). `port`/`ssl` vêm null quando ausentes no texto.
function parseHostInput(raw) {
  let v = (raw || '').trim();
  if (!v) return { host: '', port: null, ssl: null };
  let ssl = null;
  const proto = v.match(/^(https?):\/\//i);
  if (proto) {
    ssl = proto[1].toLowerCase() === 'https';
    v = v.slice(proto[0].length);
  }
  // Descarta path/query/hash após o host:porta
  v = v.replace(/[/?#].*$/, '');
  // Extrai :porta numérica ao final (host:porta)
  let port = null;
  const pm = v.match(/^(.*?):(\d+)$/);
  if (pm) {
    v = pm[1];
    port = pm[2];
  }
  return { host: v.trim(), port, ssl };
}

// Normaliza o campo Host in-place: extrai protocolo→esSsl e porta→esPort,
// deixando em esHost só o endereço. Idempotente. Chamada no blur e em cada submit.
function normalizeHostField() {
  const hostEl = document.getElementById('esHost');
  const parsed = parseHostInput(hostEl.value);
  if (parsed.host !== hostEl.value.trim()) hostEl.value = parsed.host;
  if (parsed.port !== null) document.getElementById('esPort').value = parsed.port;
  if (parsed.ssl !== null) document.getElementById('esSsl').checked = parsed.ssl;
}

function formPayload() {
  return {
    host: document.getElementById('esHost').value,
    port: document.getElementById('esPort').value,
    username: document.getElementById('esUser').value,
    password: document.getElementById('esPassword').value,
    use_ssl: document.getElementById('esSsl').checked,
  };
}

// Exibe uma mensagem (type: 'error' | 'success') em um elemento .error-msg
function showMsg(el, text, type) {
  if (el._dismissTimer) { clearTimeout(el._dismissTimer); el._dismissTimer = null; }
  el.textContent = text;
  el.classList.toggle('success', type === 'success');
  el.style.display = 'block';
}

// Como showMsg, mas some sozinha após `ms`
function showTempMsg(el, text, type, ms = 3000) {
  showMsg(el, text, type);
  el._dismissTimer = setTimeout(() => {
    el.style.display = 'none';
    el._dismissTimer = null;
  }, ms);
}

// Host, Porta e Usuário são obrigatórios. Mostra erro em `errEl` e retorna false se faltar algo.
function validateForm(errEl) {
  const missing = [];
  if (!document.getElementById('esHost').value.trim()) missing.push('Host');
  if (!document.getElementById('esPort').value.trim()) missing.push('Porta');
  if (!document.getElementById('esUser').value.trim()) missing.push('Usuário');
  if (missing.length) {
    showMsg(errEl, 'Preencha os campos obrigatórios: ' + missing.join(', ') + '.', 'error');
    return false;
  }
  errEl.style.display = 'none';
  return true;
}

// Executa POST /api/connect e gerencia a UI de loading/erro/sucesso.
async function doConnect(payload, btn) {
  const errEl = document.getElementById('connectError');
  errEl.style.display = 'none';

  const original = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Conectando...';
  }

  try {
    const res = await fetch('/api/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();

    if (data.success) {
      document.getElementById('connectModal').style.display = 'none';
      document.getElementById('app').style.display = 'flex';
      setClusterInfo(data);
      loadDashboard();
      showPage(pageFromHash());
      return true;
    }
    showMsg(errEl, data.error || 'Falha na conexão.', 'error');
  } catch (e) {
    showMsg(errEl, 'Erro de rede: ' + e.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = original;
    }
  }
  return false;
}

async function connect() {
  normalizeHostField();
  if (!validateForm(document.getElementById('connectError'))) return;
  await doConnect(formPayload(), document.getElementById('connectBtn'));
}

// Testa as credenciais sem entrar no dashboard
async function testConnection() {
  normalizeHostField();
  const errEl = document.getElementById('connectError');
  if (!validateForm(errEl)) return;

  const editing = editingConnId !== null;
  const btn = document.getElementById(editing ? 'testEditBtn' : 'testBtn');
  const payload = formPayload();
  // Em edição, usa a senha salva quando o campo não foi alterado
  if (editing) payload.connection_id = editingConnId;

  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Testando...';

  try {
    const res = await fetch('/api/test_connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.success) {
      showMsg(errEl, `Conexão bem-sucedida — ${data.cluster_name} (v${data.version})`, 'success');
    } else {
      showMsg(errEl, data.error || 'Falha na conexão.', 'error');
    }
  } catch (e) {
    showMsg(errEl, 'Erro de rede: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

// ─── Conexões salvas ──────────────────────────────────────
async function loadConnections() {
  try {
    const res = await fetch('/api/connections');
    const conns = await res.json();
    renderConnList(Array.isArray(conns) ? conns : []);
  } catch (e) { /* lista vazia em caso de erro */ }
}

function renderConnList(conns) {
  const wrap = document.getElementById('connSaved');
  const list = document.getElementById('connList');
  const card = document.querySelector('.connect-card');
  if (!conns.length) {
    wrap.style.display = 'none';
    list.innerHTML = '';
    card.classList.remove('has-saved');
    return;
  }
  wrap.style.display = 'flex';
  card.classList.add('has-saved');
  list.innerHTML = conns.map(c => `
    <div class="conn-item" onclick="selectConnection(${c.id})">
      <div class="conn-item-info">
        <span class="conn-item-alias">${escHtml(c.alias)}</span>
      </div>
      <button class="conn-item-gear" title="Configurar"
        onclick="event.stopPropagation(); editConnection(${c.id})">
        <i class="fas fa-gear"></i>
      </button>
    </div>
  `).join('');
}

// Busca a lista de conexões salvas (usada ao selecionar/editar/checar duplicidade)
async function fetchConnections() {
  const res = await fetch('/api/connections');
  return res.json();
}

function fillForm(c) {
  document.getElementById('esHost').value = c.host || '';
  document.getElementById('esPort').value = c.port || 9200;
  document.getElementById('esUser').value = c.username || '';
  document.getElementById('esSsl').checked = !!c.use_ssl;
  const pwd = document.getElementById('esPassword');
  pwd.value = '';
  pwd.placeholder = '••••••••';
}

// Em edição de conexão com senha salva, o campo fica oculto atrás do botão
// "Alterar senha"; só revelamos (e enviamos) ao clicar. `locked=false` deixa
// o campo de senha visível normalmente (nova conexão / troca de senha).
function setPasswordEditMode(locked) {
  document.getElementById('esPassword').style.display = locked ? 'none' : '';
  document.getElementById('changePasswordBtn').style.display = locked ? 'block' : 'none';
}

function enablePasswordChange() {
  setPasswordEditMode(false);
  const pwd = document.getElementById('esPassword');
  pwd.value = '';
  pwd.placeholder = 'Digite a nova senha';
  pwd.focus();
}

async function selectConnection(id) {
  const conns = await fetchConnections();
  const c = conns.find(x => x.id === id);
  if (!c) return;
  fillForm(c);
  setPasswordEditMode(false);
  if (c.has_password) {
    // Conecta direto usando a senha armazenada no backend
    await doConnect({ connection_id: id }, document.getElementById('connectBtn'));
  } else {
    document.getElementById('esPassword').focus();
  }
}

async function editConnection(id) {
  const conns = await fetchConnections();
  const c = conns.find(x => x.id === id);
  if (!c) return;
  editingConnId = id;
  fillForm(c);
  // Se há senha salva, oculta o campo atrás do botão "Alterar senha"
  setPasswordEditMode(c.has_password);
  document.getElementById('editHeader').style.display = 'flex';
  document.getElementById('esAlias').value = c.alias;
  document.getElementById('aliasGroup').style.display = 'block';
  document.getElementById('defaultActions').style.display = 'none';
  document.getElementById('editActions').style.display = 'block';
  document.getElementById('connectError').style.display = 'none';
  document.getElementById('esAlias').focus();
}

function startNewConnection() {
  editingConnId = null;
  document.getElementById('esAlias').value = '';
  document.getElementById('aliasGroup').style.display = 'none';
  document.getElementById('editHeader').style.display = 'none';
  document.getElementById('defaultActions').style.display = 'block';
  document.getElementById('editActions').style.display = 'none';
  document.getElementById('connectError').style.display = 'none';
  document.getElementById('esHost').value = '';
  document.getElementById('esPort').value = '';
  document.getElementById('esUser').value = '';
  document.getElementById('esSsl').checked = true;
  const pwd = document.getElementById('esPassword');
  pwd.value = '';
  pwd.placeholder = '••••••••';
  setPasswordEditMode(false);
  document.getElementById('esHost').focus();
}

// ─── Modal de confirmação (tema do app) ──────────────────
let _confirmResolve = null;

function showConfirm({ title = 'Confirmar', message = '', confirmLabel = 'Confirmar', danger = false }) {
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmMessage').textContent = message;
  const okBtn = document.getElementById('confirmOkBtn');
  okBtn.textContent = confirmLabel;
  okBtn.className = 'btn ' + (danger ? 'btn-danger-solid' : 'btn-primary');
  document.getElementById('confirmModal').style.display = 'flex';
  return new Promise(resolve => { _confirmResolve = resolve; });
}

function closeConfirmModal(result = false) {
  document.getElementById('confirmModal').style.display = 'none';
  if (_confirmResolve) { _confirmResolve(result); _confirmResolve = null; }
}

async function deleteConnection(id, alias) {
  const ok = await showConfirm({
    title: 'Excluir conexão',
    message: `Tem certeza que deseja excluir a conexão "${alias}"?`,
    confirmLabel: 'Excluir',
    danger: true,
  });
  if (!ok) return;
  await fetch('/api/connections/' + id, { method: 'DELETE' });
  if (editingConnId === id) startNewConnection();
  loadConnections();
}

// Exclui a conexão atualmente em edição (botão na tela de edição)
function deleteCurrentConnection() {
  if (editingConnId === null) return;
  deleteConnection(editingConnId, document.getElementById('esAlias').value);
}

// Retorna o alias de uma conexão já cadastrada com mesmo host+porta+usuário, ou null.
// `excludeId` ignora a própria conexão (edição).
async function duplicateAlias(excludeId) {
  const host = document.getElementById('esHost').value.trim();
  const port = document.getElementById('esPort').value.trim();
  const user = document.getElementById('esUser').value.trim();
  const conns = await fetchConnections();
  const dup = conns.find(c =>
    c.host === host &&
    String(c.port) === String(port) &&
    (c.username || '') === user &&
    c.id !== excludeId
  );
  return dup ? dup.alias : null;
}

// Fluxo de NOVA conexão: valida, checa duplicidade e abre o modal de alias
async function saveConnection() {
  normalizeHostField();
  const errEl = document.getElementById('connectError');
  if (!validateForm(errEl)) return;
  const dup = await duplicateAlias(editingConnId);
  if (dup) {
    showMsg(errEl, `Já existe uma conexão ("${dup}") cadastrada para esse host, porta e usuário.`, 'error');
    return;
  }
  const input = document.getElementById('aliasModalInput');
  input.value = '';
  document.getElementById('aliasModalError').style.display = 'none';
  document.getElementById('aliasModal').style.display = 'flex';
  setTimeout(() => input.focus(), 50);
}

function closeAliasModal() {
  document.getElementById('aliasModal').style.display = 'none';
}

// Confirma o alias do modal → apenas salva a conexão (não conecta)
async function confirmAlias() {
  const input = document.getElementById('aliasModalInput');
  const errEl = document.getElementById('aliasModalError');
  const alias = input.value.trim();
  if (!alias) {
    showMsg(errEl, 'Informe um alias/nome para a conexão.', 'error');
    input.focus();
    return;
  }
  errEl.style.display = 'none';
  const ok = await persistConnection(alias, document.getElementById('aliasModalConfirm'), errEl);
  if (ok) {
    closeAliasModal();
    showTempMsg(document.getElementById('connectError'), 'Conexão salva com sucesso.', 'success');
  }
}

// Fluxo de EDIÇÃO: usa o campo alias inline do formulário
async function saveEdit() {
  normalizeHostField();
  const errEl = document.getElementById('connectError');
  if (!validateForm(errEl)) return;
  const aliasInput = document.getElementById('esAlias');
  const alias = aliasInput.value.trim();
  if (!alias) {
    showMsg(errEl, 'Informe um alias/nome para a conexão.', 'error');
    aliasInput.focus();
    return;
  }
  const dup = await duplicateAlias(editingConnId);
  if (dup) {
    showMsg(errEl, `Já existe uma conexão ("${dup}") cadastrada para esse host, porta e usuário.`, 'error');
    return;
  }
  errEl.style.display = 'none';
  const ok = await persistConnection(alias, document.getElementById('saveEditBtn'), errEl);
  if (ok) {
    startNewConnection();
    showTempMsg(document.getElementById('connectError'), 'Conexão salva com sucesso.', 'success');
  }
}

// POST/PUT da conexão (apenas salva — não conecta). `errEl` recebe erros de salvamento.
// Retorna true se a conexão foi salva.
async function persistConnection(alias, btn, errEl) {
  const payload = { alias, ...formPayload() };
  // Só envia a senha quando digitada; em edição, vazio preserva a salva
  if (!payload.password) delete payload.password;

  const editing = editingConnId !== null;
  const url = editing ? '/api/connections/' + editingConnId : '/api/connections';
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Salvando...';

  try {
    const res = await fetch(url, {
      method: editing ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.success) {
      showMsg(errEl, data.error || 'Falha ao salvar a conexão.', 'error');
      return false;
    }
  } catch (e) {
    showMsg(errEl, 'Erro de rede: ' + e.message, 'error');
    return false;
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }

  editingConnId = null;
  await loadConnections();
  return true;
}

async function disconnect() {
  await fetch('/api/disconnect', { method: 'POST' });
  location.reload();
}

function setClusterInfo(info) {
  const el = document.getElementById('sidebarCluster');
  if (!el) return;
  const deployment = info.cluster_name || info.host;
  // Mostra o ALIAS cadastrado como nome principal; sem alias (conexão ad-hoc),
  // cai no nome do deployment. O tooltip sempre revela o deployment/cluster name.
  const name = info.alias || deployment;
  const tooltip = `Clique para copiar · Cluster: ${deployment}`;
  el.innerHTML = `
    <div class="sidebar-cluster-name-row">
      <span class="sidebar-cluster-dot"></span>
      <span class="sidebar-cluster-name" title="${escHtml(tooltip)}" data-alias="${escHtml(name)}" data-cluster="${escHtml(deployment)}" onclick="copyAlias(this)">${escHtml(name)}</span>
    </div>`;
}

function copyAlias(el) {
  const alias = el.dataset.alias;
  const cluster = el.dataset.cluster;
  if (!alias) return;
  const text = `Alias: ${alias}\nCluster Name: ${cluster}`;
  navigator.clipboard.writeText(text).then(() => {
    if (el.classList.contains('sidebar-cluster-name--copied')) return;
    const original = el.innerHTML;
    const originalTitle = el.title;
    el.innerHTML = '<i class="fas fa-check"></i> Copiado!';
    el.title = 'Copiado!';
    el.classList.add('sidebar-cluster-name--copied');
    setTimeout(() => {
      el.innerHTML = original;
      el.title = originalTitle;
      el.classList.remove('sidebar-cluster-name--copied');
    }, 3000);
  });
}

// ─── Navegação entre páginas / sidebar ────────────────────
let currentPage = 'overview';
// O id 'overview' é mantido por compatibilidade (hash #overview, page-overview,
// sectionCardsHealth, refreshSection('health')…); o rótulo é "Sinais Vitais".
const PAGE_META = {
  overview: { title: 'Sinais Vitais do Cluster', subtitle: 'Está tudo funcionando agora? Saúde, recursos e disponibilidade ao vivo' },
  capacity: { title: 'Inventário', subtitle: 'Nós, volume de dados e higiene de configuração dos índices' },
  insights: { title: 'Diagnóstico', subtitle: 'Leitura interpretada dos dados do cluster — o que merece atenção' },
  config:   { title: 'Configuração', subtitle: 'Integrações e preferências desta conexão' },
  help:     { title: 'Ajuda', subtitle: 'O que cada métrica significa e como agir' },
};

const PAGES = ['overview', 'capacity', 'insights', 'config', 'help'];
// Páginas com dados ao vivo: ganham timestamp e botão de refresh na topbar.
const REFRESHABLE_PAGES = new Set(['overview', 'capacity']);

function showPage(page) {
  if (!PAGE_META[page]) return;
  currentPage = page;
  for (const p of PAGES) {
    const sec = document.getElementById('page-' + p);
    if (sec) sec.hidden = p !== page;
    const nav = document.getElementById('nav-' + p);
    if (nav) nav.classList.toggle('active', p === page);
  }
  document.getElementById('topbarTitle').textContent = PAGE_META[page].title;
  document.getElementById('topbarSubtitle').textContent = PAGE_META[page].subtitle;
  // O timestamp / refresh só fazem sentido onde há dado ao vivo para recarregar.
  document.getElementById('topbarActions').style.visibility =
    REFRESHABLE_PAGES.has(page) ? 'visible' : 'hidden';
  // Diagnóstico reaproveita o que já foi carregado (dashboardData), sem
  // requisição nova. O Inventário faz o mesmo, e só busca por conta própria se
  // ainda não houver dado nenhum e nada estiver em voo (entrada direta por #capacity).
  if (page === 'insights') renderInsights();
  if (page === 'capacity') {
    if (dashboardData) renderCapacity();
    else if (!dashboardInFlight.size) loadCapacity();
  }
  // Reflete a página na URL (hash) para preservar no refresh e permitir compartilhar o link.
  if (location.hash.slice(1) !== page) {
    history.replaceState(null, '', '#' + page);
  }
}

// Página inicial a partir do hash da URL (#insights, #help…); default Sinais Vitais (overview).
function pageFromHash() {
  const page = location.hash.slice(1);
  return PAGE_META[page] ? page : 'overview';
}

// Navegação pelo histórico do navegador (voltar/avançar) também troca de página.
window.addEventListener('hashchange', () => {
  const page = pageFromHash();
  if (page !== currentPage) showPage(page);
});

function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  const collapsed = sb.classList.toggle('collapsed');
  document.getElementById('collapseIcon').className =
    collapsed ? 'fas fa-chevron-right' : 'fas fa-chevron-left';
}

function goToTasks() {
  showPage('overview');
  requestAnimationFrame(() => {
    const el = document.getElementById('tasksBody');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

// ─── Dashboard ────────────────────────────────────────────
// Não há cache: toda carga e todo refresh consultam o cluster de novo. O que
// varia é o ESCOPO — o refresh global pede o dashboard inteiro e o de uma seção
// pede só aquela seção (?sections=), que o backend traduz nas chamadas ao ES
// estritamente necessárias (ver DASHBOARD_SECTIONS em es_service.py).
// A única coalescência é de requisições EM VOO: duas chamadas idênticas
// simultâneas dividem a mesma promise em vez de coletar duas vezes.
const dashboardInFlight = new Map();

// sections: array de ids de seção, ou omitido para o dashboard completo.
// Uma resposta parcial é MESCLADA sobre o dashboardData atual, para as seções
// não pedidas continuarem renderizáveis a partir do mesmo objeto.
async function fetchDashboard(sections) {
  const key = sections ? [...sections].sort().join(',') : '';
  if (dashboardInFlight.has(key)) return dashboardInFlight.get(key);

  const promise = (async () => {
    const url = key ? `/api/dashboard?sections=${encodeURIComponent(key)}` : '/api/dashboard';
    const res = await fetch(url);
    if (res.status === 401) { location.reload(); throw new Error('unauthorized'); }
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    dashboardData = key ? { ...(dashboardData || {}), ...data } : data;
    return dashboardData;
  })();

  dashboardInFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    dashboardInFlight.delete(key);
  }
}

async function loadDashboard() {
  const grid = document.getElementById('metricsGrid');
  const icon = document.getElementById('refreshIcon');
  icon.classList.add('spin');

  grid.innerHTML = `<div class="loading-state">
    <i class="fas fa-circle-notch fa-spin"></i>
    <span>Carregando métricas...</span>
  </div>`;

  // Atualiza as tarefas em paralelo, para a animação de load aparecer
  // junto com a das métricas (e não só depois que o dashboard renderiza).
  loadTasks();

  try {
    // Refresh global: coleta completa, que também realimenta Inventário e Diagnóstico.
    const data = await fetchDashboard();
    renderCards(data);
    // Mantém a página Diagnóstico e o badge da nav em sincronia a cada atualização
    // (a seção fica oculta nos Sinais Vitais, mas o badge reflete os riscos atuais).
    renderInsights();
    // Capacidade compartilha o mesmo dashboardData — re-renderiza quando ativa.
    if (currentPage === 'capacity') renderCapacity(data);

    document.getElementById('lastUpdated').textContent =
      'Atualizado: ' + new Date().toLocaleTimeString('pt-BR');
  } catch (e) {
    if (e.message === 'unauthorized') return;  // página já está recarregando
    grid.innerHTML = `<div class="error-state">
      <i class="fas fa-triangle-exclamation"></i>
      <p>${e.message}</p>
    </div>`;
  } finally {
    icon.classList.remove('spin');
  }
}

// Página "Inventário": mesma fonte do dashboard, pedindo só as seções dela.
async function loadCapacity() {
  const grid = document.getElementById('capacityGrid');
  const icon = document.getElementById('refreshIcon');
  if (!grid) return;
  if (icon) icon.classList.add('spin');

  grid.innerHTML = `<div class="loading-state">
    <i class="fas fa-circle-notch fa-spin"></i>
    <span>Carregando métricas...</span>
  </div>`;

  try {
    const data = await fetchDashboard(CAPACITY_SECTIONS);
    renderCapacity(data);
    // O badge do Diagnóstico sai do mesmo dashboardData — segue o dado novo.
    renderInsights();
    document.getElementById('lastUpdated').textContent =
      'Atualizado: ' + new Date().toLocaleTimeString('pt-BR');
  } catch (e) {
    if (e.message === 'unauthorized') return;  // página já está recarregando
    grid.innerHTML = `<div class="error-state">
      <i class="fas fa-triangle-exclamation"></i>
      <p>${escHtml(e.message)}</p>
    </div>`;
  } finally {
    if (icon) icon.classList.remove('spin');
  }
}

// Refresh da topbar e do atalho R: cada página recarrega a sua própria fonte.
function refreshCurrentPage() {
  if (currentPage === 'capacity') return loadCapacity();
  return loadDashboard();
}

// ─── Card Definitions ─────────────────────────────────────
function section(label, sectionId) {
  const refreshBtn = sectionId
    ? `<button class="btn-icon" onclick="refreshSection('${sectionId}')" title="Atualizar seção"><i class="fas fa-rotate-right" id="sectionRefreshIcon-${sectionId}"></i></button>`
    : '';
  return `<div class="grid-section">
    <span class="grid-section-label">${label}</span>
    <span class="grid-section-line"></span>
    ${refreshBtn}
  </div>`;
}

function sectionCardsHealth(d) {
  const h = d.cluster_health;
  const totalShards = d.total_shards || 0;
  return [
    cardHealth(h, d.es_version, d.license),
    cardStat('openShardsDetail()', 'Total de Shards', 'fa-cubes', fmtNum(totalShards), 'shards (primários + réplicas)', 'blue',
      'Número total de shards configurados (primários + réplicas). Muitos shards por nó pressionam a memória do master; a regra prática é manter abaixo de ~20 shards por GB de heap.',
      [
        // % de shards ativos só aparece quando < 100% (cluster com shards não
        // alocados/em movimento); mesma convenção de cor/formato do modal openShardsDetail.
        ...((h.active_shards_percent ?? 100) < 100 ? [{
          label: 'Ativos',
          val: `${Math.min(99.9, Math.round((h.active_shards_percent ?? 100) * 10) / 10)}%`,
          color: (h.active_shards_percent ?? 100) >= 90 ? 'yellow' : 'red',
        }] : []),
        { label: 'Não Alocados',  val: fmtNum(h.unassigned_shards),   color: h.unassigned_shards > 0   ? 'red'    : null },
        ...(h.delayed_unassigned_shards > 0 ? [{ label: 'Atraso (timeout)', val: fmtNum(h.delayed_unassigned_shards), color: 'yellow' }] : []),
        { label: 'Realocando',    val: fmtNum(h.relocating_shards),   color: h.relocating_shards > 0   ? 'yellow' : null },
        { label: 'Inicializando', val: fmtNum(h.initializing_shards), color: h.initializing_shards > 0 ? 'yellow' : null },
      ],
      'help-total-shards'),
  ].join('');
}

// Faixa de sinais binários de saúde: pressão no master, falhas de ILM e
// disparos de circuit breaker — cada um é um card horizontal clicável que
// abre o detalhe correspondente.
function sectionCardsSignals(d) {
  return cardAlertSignals(d, d.cluster_health);
}

function cardAlertSignals(d, h) {
  const pending = h.number_of_pending_tasks || 0;
  const wait = h.task_max_waiting_in_queue_millis || 0;
  const pendColor = pending > 0 ? (wait >= 200 ? 'red' : 'yellow') : 'green';
  const pendSub = pending > 0 ? `Espera máx ${fmtDuration(wait)}` : 'sem fila no master';
  const pendTip = 'Tarefas de atualização do <strong>cluster state</strong> (criação de índices, alterações de mapping, alocação de shards) enfileiradas aguardando o nó <strong>master</strong>.<br><br>' +
    'Valores persistentemente acima de zero — e principalmente uma <strong>espera máxima</strong> alta — indicam um master sobrecarregado, causa comum de lentidão generalizada no cluster.';

  const ilm = d.ilm_errors || 0;
  const ilmColor = ilm > 0 ? 'red' : 'green';
  const ilmSub = ilm > 0 ? `${fmtNum(ilm)} índice(s) parados em erro` : 'nenhum índice em erro';
  const ilmTip = 'Índices cuja execução da política de ILM <strong>falhou</strong> e está parada num passo de <strong>ERRO</strong> (consulta <code>_ilm/explain?only_errors=true</code>).<br><br>' +
    'Enquanto o índice permanece nesse estado, ele não avança nas fases (hot → warm → cold → delete): não é encolhido, realocado nem excluído. Causas comuns incluem falta de espaço em disco, ausência de nós com o atributo de alocação exigido pela fase ou erros de permissão. Requer investigação e, muitas vezes, um <code>_ilm/retry</code> após corrigir a causa raiz.';

  const cb = d.circuit_breaker_trips || 0;
  const cbColor = cb > 0 ? 'red' : 'green';
  const cbSub = cb > 0 ? `Parent: ${fmtNum(d.circuit_breaker_parent_trips)} disparo(s)` : 'sem disparos desde o boot';
  const cbTip = 'Os <strong>circuit breakers</strong> do Elasticsearch abortam requisições para proteger a JVM de estouro de memória. O contador <code>tripped</code> conta quantas requisições já foram <strong>derrubadas por proteção de memória</strong> — cada disparo é uma query ou indexação rejeitada.<br><br>' +
    'O breaker <strong>parent</strong> é o mais crítico: ele soma o uso de todos os demais (fielddata, request, in-flight, etc.) e, ao atingir o limite (padrão ~95% do heap), começa a rejeitar tudo. Disparos acima de zero indicam pressão de memória severa e instabilidade — o cluster pode estar derrubando consultas silenciosamente. Clique para ver o uso atual de cada breaker por nó.<br><br>' +
    '<strong>Atenção:</strong> este contador é <strong>acumulado desde o boot do nó</strong> — não reflete o instante atual. Para avaliar o estado <em>agora</em>, observe o <strong>Parent CB %</strong> e a <strong>Fila TP</strong> na tabela <em>Utilização por Nó</em>, que são indicadores vivos e antecipados.';

  // Backup / SLM: indisponível (licença/permissão) → neutro; falha → red;
  // não configurado → yellow; em dia → green. Espelha o insight de backup.
  const slm = d.slm || {};
  let slmColor, slmVal, slmSub;
  if (!slm.available) {
    slmColor = 'muted'; slmVal = 0; slmSub = 'indisponível (licença/permissão)';
  } else if ((slm.failed || 0) > 0) {
    slmColor = 'red'; slmVal = slm.failed; slmSub = `${fmtNum(slm.failed)} política(s) com falha`;
  } else if (!slm.configured) {
    slmColor = 'yellow'; slmVal = 0; slmSub = 'sem snapshots automáticos';
  } else {
    slmColor = 'green'; slmVal = slm.configured; slmSub = 'backups em dia';
  }
  const slmTip = 'Estado das políticas de <strong>snapshot (SLM)</strong> — os backups automáticos do cluster.<br><br>' +
    '<strong>Vermelho</strong>: a execução mais recente de alguma política falhou (os backups podem estar desatualizados — verifique o repositório). ' +
    '<strong>Amarelo</strong>: nenhuma política configurada, o cluster não tem backup automático. ' +
    '<strong>—</strong>: a API de SLM está indisponível (licença ou permissão).<br><br>' +
    'Clique para ver cada política: repositório, agendamento, último sucesso/falha e próxima execução.';

  // Flood-stage é o único sinal vital aqui: bloqueio de escrita aplicado
  // automaticamente quando o disco passou de 95% — incidente de disponibilidade
  // ao vivo. Read-only manual sem ILM (yellow) e read-only via ILM (esperado)
  // não entram nos sinais vitais; o manual aparece como insight de higiene.
  const flood = (d.read_only_indices || {}).flood || 0;
  const floodColor = flood > 0 ? 'red' : 'green';
  const floodSub = flood > 0 ? `${fmtNum(flood)} índice(s) com escrita bloqueada` : 'nenhum índice nesse status';
  const floodTip = '<strong>Flood-stage</strong>: bloqueio de escrita aplicado <strong>automaticamente</strong> pelo Elasticsearch quando o disco de um nó passou de <strong>95%</strong> (<code>cluster.routing.allocation.disk.watermark.flood_stage</code>).<br><br>' +
    'É um <strong>incidente de disponibilidade ao vivo</strong>: enquanto durar, os índices afetados não aceitam escrita. O bloqueio (<code>index.blocks.read_only_allow_delete</code>) <strong>persiste mesmo após liberar disco</strong> — é preciso removê-lo manualmente (<code>"index.blocks.read_only_allow_delete": null</code>) depois de resolver o espaço.<br><br>' +
    'Bloqueios <em>read-only manuais</em> (fora do ILM) não são incidente e aparecem como apontamento na página <strong>Diagnóstico</strong>; read-only definido pelo ILM é esperado. Clique para listar os índices bloqueados e a categoria de cada um.';

  return [
    signalItem('pending_tasks', 'Tarefas Pendentes', 'Tarefas de cluster state aguardando o nó master', 'fa-list-check', 'Tarefas Pendentes', pending, pendColor, pendSub, pendTip, 'help-pending-tasks'),
    signalItem('ilm_errors', 'ILM com Falha', '', 'fa-circle-exclamation', 'ILM com Falha', ilm, ilmColor, ilmSub, ilmTip, 'help-ilm-errors'),
    signalItem('circuit_breakers', 'Circuit Breakers', '', 'fa-bolt', 'Circuit Breakers', cb, cbColor, cbSub, cbTip, 'help-circuit-breakers'),
    signalItem('slm_policies', 'Políticas de Snapshot (SLM)', 'Último backup, falhas e agendamento', 'fa-database', 'Backup (SLM)', slmVal, slmColor, slmSub, slmTip, 'help-slm-policies'),
    signalItem('read_only_indices', 'Índices Read-only', '', 'fa-water', 'Flood-stage', flood, floodColor, floodSub, floodTip, 'help-flood-stage'),
  ].join('');
}

// Snapshots em criação agora (_snapshot/_status, via d.snapshots_running) —
// vive no Inventário (Volume e Capacidade), não nos Sinais Vitais: é dado de


// color: 'green' (ok, com check) | 'yellow'/'red'/'blue' (alerta, sub colorido) |
// 'muted' (indisponível — renderiza '—' em vez do número, sem check nem cor).
function signalItem(metric, detailTitle, detailSub, icon, label, value, color, sub, tip, topic) {
  const numHtml = color === 'muted' ? '&mdash;' : fmtNum(value);
  const subHtml = color === 'green'
    ? `<i class="fas fa-check signal-ok-icon"></i> ${sub}`
    : sub;
  const subStyle = (color === 'red' || color === 'yellow' || color === 'blue') ? `style="color:var(--${color})"` : '';
  const clickAttr = `onclick="openDetail('${metric}','${detailTitle}','${detailSub}')"`;
  return `<div class="signal-card status-${color}" ${clickAttr}>
    <div class="signal-num value-${color}">${numHtml}</div>
    <div class="signal-info">
      <div class="signal-title">
        <i class="fas ${icon} signal-title-icon"></i>
        <span class="signal-label">${label}</span>
      </div>
      <div class="signal-sub" ${subStyle}>${subHtml}</div>
    </div>
    ${tooltip(tip, topic)}
  </div>`;
}

function sectionCardsResources(d) {
  return cardResourceTable(d);
}

function sectionCardsIndices(d) {
  return [
    cardCount('indices_without_replicas', 'Sem Réplica', 'fa-shield-halved', d.indices_without_replicas,
      'índices', d.indices_without_replicas > 0 ? 'yellow' : 'green',
      d.indices_without_replicas > 0 ? 'yellow' : 'green',
      'Índices sem réplicas são pontos únicos de falha. A perda de um nó com um shard primário sem réplica resulta em perda de dados permanente.',
      [], null, 'help-without-replicas'),
    cardCount('large_primary_shards', 'Shards Primários > 50 GB', 'fa-hard-drive', d.large_primary_shards,
      'índices', d.large_primary_shards > 0 ? 'yellow' : 'green',
      d.large_primary_shards > 0 ? 'yellow' : 'green',
      'Sinaliza índices que têm <strong>algum shard primário individual</strong> acima de 50 GB (não a soma do índice). Shards primários grandes causam recuperação lenta, realocação demorada e queda de desempenho. Considere reindexar com mais shards ou revisar a política de ILM.',
      [], null, 'help-large-shards'),
    cardCount('indices_without_ilm', 'Sem Política de ILM', 'fa-clock-rotate-left', d.indices_without_ilm,
      'índices', d.indices_without_ilm > 0 ? 'yellow' : 'green',
      d.indices_without_ilm > 0 ? 'yellow' : 'green',
      'Índices sem ILM podem crescer indefinidamente. O ILM automatiza a transição por fases (hot → warm → cold → delete), otimizando uso de recursos.',
      [], null, 'help-without-ilm'),
    cardCount('ilm_without_delete', 'ILM sem Fase DELETE', 'fa-trash-can', d.ilm_without_delete,
      'políticas', d.ilm_without_delete > 0 ? 'yellow' : 'green',
      d.ilm_without_delete > 0 ? 'yellow' : 'green',
      'Políticas de ILM sem fase de exclusão acumulam dados antigos indefinidamente, levando ao esgotamento de disco ao longo do tempo.',
      [], null, 'help-ilm-without-delete'),
  ].join('');
}

// Página "Sinais Vitais" (id interno: overview) — só o que responde "está
// funcionando agora?". Nós, volume/inventário e configuração de índices ficam na
// página "Inventário" (renderCapacity).
function renderCards(d) {
  const grid = document.getElementById('metricsGrid');

  grid.innerHTML = [
    section('Saúde do Cluster', 'health'),
    `<div id="section-cards-health" class="section-health-cards">${sectionCardsHealth(d)}</div>`,

    section('Sinais de Alerta', 'signals'),
    `<div id="section-cards-signals" class="section-signals-cards">${sectionCardsSignals(d)}</div>`,

    section('Utilização de Recursos', 'resources'),
    `<div id="section-cards-resources" style="display:contents">${sectionCardsResources(d)}</div>`,
  ].join('');
}

// Página "Inventário" (id interno: capacity) — nós, volume e
// higiene de configuração de índices. Reaproveita sectionCardsVolume/Indices e
// os mesmos ids de container, mantendo refreshSection('volume'|'indices') válido.
function renderCapacity(d = dashboardData) {
  const grid = document.getElementById('capacityGrid');
  if (!grid || !d) return;

  grid.innerHTML = [
    section('Volume e Capacidade', 'volume'),
    `<div id="section-cards-volume" class="section-volume-cards">${sectionCardsVolume(d)}</div>`,

    section('Disco por Tier', 'tierdisk'),
    `<div id="section-cards-tierdisk" class="section-volume-cards">${sectionCardsTierDisk(d)}</div>`,

    section('Configuração de Índices', 'indices'),
    `<div id="section-cards-indices" style="display:contents">${sectionCardsIndices(d)}</div>`,

    section('Topologia do Cluster', 'topology'),
    `<div id="section-cards-topology" class="section-volume-cards">${sectionCardsTopology(d)}</div>`,
  ].join('');
}

// Seção → função que a renderiza. Os ids são os mesmos que o backend conhece
// em DASHBOARD_SECTIONS (es_service.py) e que vão em ?sections=.
const SECTION_RENDERERS = {
  health: sectionCardsHealth,
  signals: sectionCardsSignals,
  resources: sectionCardsResources,
  volume: sectionCardsVolume,
  tierdisk: sectionCardsTierDisk,
  indices: sectionCardsIndices,
  topology: sectionCardsTopology,
};
const CAPACITY_SECTIONS = ['volume', 'tierdisk', 'indices', 'topology'];

async function refreshSection(sectionId) {
  const icon = document.getElementById(`sectionRefreshIcon-${sectionId}`);
  const container = document.getElementById(`section-cards-${sectionId}`);
  if (!container) return;
  const fn = SECTION_RENDERERS[sectionId];
  if (icon) icon.classList.add('spin');

  container.innerHTML = `<div class="loading-state section-loading"><i class="fas fa-circle-notch fa-spin"></i><span>Atualizando...</span></div>`;

  try {
    // Só as métricas desta seção são consultadas no cluster; o resultado é
    // mesclado no dashboardData, sem invalidar o que as outras seções mostram.
    const [data] = await Promise.all([
      fetchDashboard([sectionId]),
      new Promise(resolve => setTimeout(resolve, 500)),
    ]);
    if (fn) container.innerHTML = fn(data);
    renderInsights();
  } catch (_) {
    // mantém dados antigos: restaura a render da seção a partir do último estado
    if (fn && dashboardData) container.innerHTML = fn(dashboardData);
  } finally {
    if (icon) icon.classList.remove('spin');
  }
}

function cardHealth(h, version, license) {
  const status = h.status;
  const color = healthColor(status);
  const tip = '<strong style="color:var(--green)">GREEN</strong>: Todos os shards primários e réplicas estão alocados e operacionais — cluster saudável.<br>' +
    '<strong style="color:var(--yellow)">YELLOW</strong>: Todos os shards primários estão alocados, mas há réplicas não alocadas. Se um nó falhar, parte dos dados pode ficar temporariamente indisponível.<br>' +
    '<strong style="color:var(--red)">RED</strong>: Um ou mais shards primários não estão alocados. Parte dos dados pode estar inacessível ou em risco de perda permanente.';

  const stats = [
    { label: 'Versão do Cluster', val: version ? `v${escHtml(version)}` : '-', color: 'text' },
  ];

  return `<div class="metric-card card-health-hero status-${color}" onclick="openDetail('cluster_health','Saúde por Índice','Status e shards por índice')">
    <div class="card-header">
      <div class="card-icon-title">
        <div class="card-icon" style="--card-icon-bg:var(--${color}-bg);--card-icon-color:var(--${color})"><i class="fas fa-heart-pulse"></i></div>
        <div class="card-title">Saúde do Cluster</div>
      </div>
      ${tooltip(tip, 'help-cluster-health')}
    </div>
    <div style="display:flex;align-items:center;gap:20px;margin-bottom:16px;flex-wrap:wrap">
      <div class="health-badge ${status}">
        <span class="health-dot"></span>
        ${status.toUpperCase()}
      </div>
    </div>
    <div class="card-footer" style="flex-wrap:wrap;gap:14px 20px">
      ${stats.map(s => `<div class="footer-stat">
        <span class="footer-stat-label">${s.label}</span>
        <span class="footer-stat-val" style="color:${s.color !== 'text' ? `var(--${s.color})` : 'var(--text)'}">${s.val}</span>
      </div>`).join('')}
    </div>
  </div>`;
}

// Conta nós por tier de dados (HOT/WARM/COLD/FROZEN), mas só quando o nó tem
// EXATAMENTE um desses roles de tier — nós que acumulam mais de um tier (ex.:
// data_hot + data_warm) não entram em nenhuma contagem. Roles complementares
// (ingest, data_content, etc.) não interferem. Quando o nó também é master, o
// tier é rotulado como "MASTER / HOT" (master conviver com um único tier é comum
// em ambientes menores). A chave de cada contagem é o próprio rótulo exibido.
const TIER_ROLES = { data_hot: 'HOT', data_warm: 'WARM', data_cold: 'COLD', data_frozen: 'FROZEN' };
const TIER_LABEL_ORDER = ['HOT', 'MASTER / HOT', 'WARM', 'MASTER / WARM', 'COLD', 'MASTER / COLD', 'FROZEN', 'MASTER / FROZEN'];
function tierNodeCounts(nodes) {
  const counts = {};
  for (const n of nodes) {
    const roles = Array.isArray(n.roles) ? n.roles : [];
    const tiers = roles.filter(r => TIER_ROLES[r]);
    if (tiers.length !== 1) continue;
    const label = (roles.includes('master') ? 'MASTER / ' : '') + TIER_ROLES[tiers[0]];
    counts[label] = (counts[label] || 0) + 1;
  }
  return counts;
}

function cardNodes(total, h, dedicatedMasters, nodes) {
  const tip = 'Monitore a estabilidade do número de nós. Uma diminuição inesperada indica falha. O número de data nodes impacta a distribuição de shards.';
  const footerStat = (label, val) => `<div class="footer-stat"><span class="footer-stat-label">${label}</span><span class="footer-stat-val">${fmtNum(val)}</span></div>`;
  const masterStat = dedicatedMasters > 0 ? footerStat('Master', dedicatedMasters) : '';
  const tiers = tierNodeCounts(nodes || []);
  const tierStats = TIER_LABEL_ORDER
    .filter(t => tiers[t] > 0)
    .map(t => footerStat(t, tiers[t]))
    .join('');
  return `<div class="metric-card status-blue" onclick="openDetail('nodes','Nós do Cluster','Detalhes de CPU, Heap e Disco por nó')">
    <div class="card-header">
      <div class="card-icon-title">
        <div class="card-icon"><i class="fas fa-server"></i></div>
        <div class="card-title">Total de Nós</div>
      </div>
      ${tooltip(tip, 'help-total-nodes')}
    </div>
    <div class="card-value-wrap">
      <div class="card-value">${total}</div>
      <div class="card-label">nós no cluster</div>
    </div>
    <div class="card-footer">
      ${footerStat('Data Nodes', h.number_of_data_nodes)}
      ${masterStat}
      ${tierStats}
    </div>
  </div>`;
}

function cardCount(metric, title, icon, value, unit, valColor, cardStatus, tipText, footerStats, detailTitle, topic) {
  const iconBg = `--card-icon-bg:var(--${valColor}-bg);--card-icon-color:var(--${valColor})`;
  const dt = detailTitle || title;
  return `<div class="metric-card status-${cardStatus}" onclick="openDetail('${metric}','${dt}','')">
    <div class="card-header">
      <div class="card-icon-title">
        <div class="card-icon" style="${iconBg}"><i class="fas ${icon}"></i></div>
        <div class="card-title">${title}</div>
      </div>
      ${tooltip(tipText, topic)}
    </div>
    <div class="card-value-wrap">
      <div class="card-value value-${valColor}">${fmtNum(value)}</div>
      <div class="card-label">${unit}</div>
    </div>
    ${footerStats.length ? `<div class="card-footer">${footerStats.map(s => `<div class="footer-stat"><span class="footer-stat-label">${s.label}</span><span class="footer-stat-val" ${s.color ? `style="color:var(--${s.color})"` : ''}>${s.val}</span></div>`).join('')}</div>` : ''}
  </div>`;
}

// Card de valor genérico (aceita HTML já formatado no valor, ex.: formatBytes).
function cardStat(metric, title, icon, valueHtml, unit, color, tip, footerStats, topic) {
  const iconBg = `--card-icon-bg:var(--${color}-bg);--card-icon-color:var(--${color})`;
  const click = metric
    ? ` onclick="${metric.includes('(') ? metric : `openDetail('${metric}','${title}','')`}"`
    : '';
  const staticCls = metric ? '' : ' metric-card-static';
  return `<div class="metric-card status-${color}${staticCls}"${click}>
    <div class="card-header">
      <div class="card-icon-title">
        <div class="card-icon" style="${iconBg}"><i class="fas ${icon}"></i></div>
        <div class="card-title">${title}</div>
      </div>
      ${tip ? tooltip(tip, topic) : ''}
    </div>
    <div class="card-value-wrap">
      <div class="card-value value-${color}">${valueHtml}</div>
      <div class="card-label">${unit}</div>
    </div>
    ${footerStats && footerStats.length ? `<div class="card-footer" style="flex-wrap:wrap;gap:10px 18px">${footerStats.map(s => `<div class="footer-stat"><span class="footer-stat-label">${s.label}</span><span class="footer-stat-val" ${s.color ? `style="color:var(--${s.color})"` : ''}>${s.val}</span></div>`).join('')}</div>` : ''}
  </div>`;
}

// Capacidade de disco agregada por tier (bytes): total, usado e livre, somando
// todos os data nodes de cada tier. Base do card "Disco por Tier" (página Inventário).
function tierDiskAgg(nodes) {
  const tiers = {};
  for (const n of nodes) {
    const t = nodeTier(n.roles);
    if (!t || !n.disk_total) continue;
    tiers[t] = tiers[t] || { used: 0, total: 0 };
    tiers[t].used += n.disk_used || 0;
    tiers[t].total += n.disk_total || 0;
  }
  return tiers;
}

// Gráfico de barras horizontais: uma linha por tier. O trilho cinza é a
// capacidade total do tier; o preenchimento colorido é o uso, com o % à direita.
// Os bytes (usado · total · livre) ficam centralizados abaixo de cada barra.
// Cor por uso: verde <70%, amarelo ≥70%, vermelho ≥85%.
function tierDiskRow(tier, agg) {
  const total = agg.total || 0;
  const used = agg.used || 0;
  const free = Math.max(0, total - used);
  const pct = total ? Math.round(used / total * 100) : 0;
  const freePct = 100 - pct;
  const color = pct >= 85 ? 'red' : pct >= 70 ? 'yellow' : 'green';
  return `<div class="tier-disk-item">
    <div class="tier-disk-row">
      <div class="tier-disk-name">${tier}</div>
      <div class="tier-disk-track"><div class="tier-disk-fill" style="width:${pct}%;background:var(--${color})"></div></div>
      <div class="tier-disk-pct text-${color}">${pct}%</div>
    </div>
    <div class="tier-disk-bytes">${formatBytes(used)} usado · ${formatBytes(total)} total · ${formatBytes(free)} livre (${freePct}%)</div>
  </div>`;
}

function sectionCardsTierDisk(d) {
  const tiers = tierDiskAgg((d || {}).nodes_summary || []);
  const order = ['HOT', 'WARM', 'COLD', 'FROZEN'].filter(t => tiers[t]);
  const tip = 'Capacidade de disco por <strong>tier de dados</strong> (HOT / WARM / COLD / FROZEN), somando todos os data nodes de cada tier.<br><br>' +
    'Em cada barra, o trilho <strong>cinza</strong> é a capacidade <strong>total</strong> do tier e o preenchimento <strong>colorido</strong> mostra o quanto está em uso. O <strong>% de uso</strong> fica à direita e os volumes (usado · total · livre) logo abaixo da barra.<br><br>' +
    'Cor por uso: amarelo a partir de <strong>70%</strong>, vermelho a partir de <strong>85%</strong>. Watermarks padrão do ES: low 85% / high 90% / flood 95%.';
  const body = order.length
    ? `<div class="tier-disk-list">${order.map(t => tierDiskRow(t, tiers[t])).join('')}</div>`
    : `<div class="empty-state" style="padding:16px"><i class="fas fa-circle-info"></i><p>Sem dados de disco por tier — nenhum data node com role de tier (<code>data_hot/warm/cold/frozen</code>) reportou capacidade.</p></div>`;
  return `<div class="metric-card metric-card-static card-full">
    <div class="card-header">
      <div class="card-icon-title">
        <div class="card-icon"><i class="fas fa-hard-drive"></i></div>
        <div class="card-title">Capacidade por tier</div>
      </div>
      ${tooltip(tip, 'help-tier-disk')}
    </div>
    ${body}
  </div>`;
}

// ─── Seção: Topologia do Cluster ──────────────────────────
// Diagrama de fluxo dinâmico: MASTER → HOT → WARM → COLD → FROZEN,
// com setas conectando as camadas. Tiers unificados (hot+warm no mesmo nó)
// formam uma faixa combinada. Faixas surgem/somem conforme as roles reais.

const TOPOLOGY_TIER_ORDER = ['data_hot', 'data_warm', 'data_cold', 'data_frozen'];
const TOPOLOGY_TIER_LABEL = { data_hot: 'HOT', data_warm: 'WARM', data_cold: 'COLD', data_frozen: 'FROZEN' };
const TOPOLOGY_TIER_ICON  = { MASTER: 'fa-crown', HOT: 'fa-fire-flame-curved', WARM: 'fa-temperature-half', COLD: 'fa-snowflake', FROZEN: 'fa-icicles', OUTROS: 'fa-server' };

// Agrupa nós por camada; retorna array ordenado { label, nodes, sortKey, isMaster, isOthers }.
function groupNodesByLayer(nodes) {
  const layers = {};
  for (const n of nodes) {
    const roles = Array.isArray(n.roles) ? n.roles : [];
    const tierRoles = TOPOLOGY_TIER_ORDER.filter(r => roles.includes(r));
    let key, label, sortKey, isMasterLayer = false, isOthers = false;
    if (tierRoles.length > 0) {
      const tierLabel = tierRoles.map(r => TOPOLOGY_TIER_LABEL[r]).join(' / ');
      label = roles.includes('master') ? `MASTER / ${tierLabel}` : tierLabel;
      key = label;
      sortKey = TOPOLOGY_TIER_ORDER.indexOf(tierRoles[0]);
    } else if (roles.includes('master') && !roles.some(r => r.startsWith('data'))) {
      key = '__MASTER__'; label = 'MASTER'; sortKey = -1; isMasterLayer = true;
    } else {
      key = '__OTHERS__'; label = 'OUTROS'; sortKey = 999; isOthers = true;
    }
    if (!layers[key]) layers[key] = { label, nodes: [], sortKey, isMasterLayer, isOthers };
    layers[key].nodes.push(n);
  }
  return Object.values(layers).sort((a, b) => a.sortKey - b.sortKey);
}

// Card individual de nó: nome e IP. Clicável — abre o modal de detalhe do nó.
function topologyNodeCard(n, electedName) {
  const isMaster = n.name === electedName;
  const titleAttr = rolesTitle(n.roles, isMaster);
  const star = isMaster ? '<span class="topology-master-star" title="Master eleito">★</span>' : '';
  const nameEsc = escHtml(n.name || '').replace(/'/g, '&#39;');
  const metricRow = (label, val) => {
    const pct = parseFloat(val) || 0;
    const c = pctColor(pct);
    return `<div class="topo-metric-row">
      <span class="topo-metric-label">${label}</span>
      <div class="progress-bar topo-metric-bar"><div class="progress-fill progress-${c}" style="width:${Math.min(pct,100)}%"></div></div>
      <span class="topo-metric-val text-${c}">${pct}%</span>
    </div>`;
  };
  return `<div class="topology-node-card" title="${titleAttr}" onclick="openNodeModal('${nameEsc}')">
    <div class="topology-node-name">${escHtml(n.name) || '-'}${star}</div>
    ${n.ip ? `<div class="topology-node-ip">${escHtml(n.ip)}</div>` : ''}
    <div class="topo-metrics">
      ${metricRow('CPU', n.cpu)}
      ${metricRow('Heap', n.heap_percent)}
      ${metricRow('Disco', n.disk_used_percent)}
    </div>
  </div>`;
}

// Conector com seta e badge de rótulo entre duas camadas do fluxo.
function topologyConnector(label) {
  return `<div class="topology-connector">
    <div class="topology-connector-stem"></div>
    <div class="topology-connector-badge"><i class="fas fa-arrow-down"></i>${label}</div>
    <div class="topology-connector-stem"></div>
    <div class="topology-connector-arrow"></div>
  </div>`;
}

// Bloco visual de uma camada: cabeçalho com ícone/rótulo + grid de cards de nó.
function topologyLayerBlock(layer, electedName) {
  const firstLabel = layer.label.split(' / ')[0];
  const icon = TOPOLOGY_TIER_ICON[firstLabel] || 'fa-server';
  return `<div class="topology-layer${layer.isMasterLayer ? ' topology-layer-master' : ''}${layer.isOthers ? ' topology-layer-others' : ''}">
    <div class="topology-layer-label">
      <i class="fas ${icon}"></i>
      <span>${layer.label}</span>
    </div>
    <div class="topology-nodes">
      ${layer.nodes.map(n => topologyNodeCard(n, electedName)).join('')}
    </div>
  </div>`;
}

function sectionCardsTopology(d) {
  const nodes = (d || {}).nodes_summary || [];
  const electedName = (nodes.find(n => n.is_master) || {}).name || null;
  const allLayers = groupNodesByLayer(nodes);

  // Fluxo principal (MASTER + tiers) e camada OUTROS separada
  const flowLayers = allLayers.filter(l => !l.isOthers);
  const othersLayer = allLayers.find(l => l.isOthers);

  const tip = 'Diagrama de <strong>fluxo da infraestrutura</strong> do cluster. As camadas representam o ciclo de vida típico dos dados no Elasticsearch: os nós <strong>MASTER</strong> gerenciam o cluster state; os dados entram pelo tier <strong>HOT</strong> (alta performance) e o ILM os move para tiers mais frios (<strong>WARM → COLD → FROZEN</strong>) conforme envelhecem, reduzindo custo. ' +
    'Nós com múltiplos tiers formam uma <strong>faixa combinada</strong> (ex.: HOT / WARM). ' +
    'O <strong>master eleito</strong> (★) aparece no seu tier; masters <strong>dedicados</strong> ficam na camada MASTER. ' +
    'A barrinha de cada nó mostra o <strong>uso de disco</strong> (amarelo ≥ 70%, vermelho ≥ 85%).';

  const header = `<div class="card-header">
    <div class="card-icon-title">
      <div class="card-icon"><i class="fas fa-sitemap"></i></div>
      <div class="card-title">Topologia do Cluster</div>
    </div>
    ${tooltip(tip, 'help-cluster-topology')}
  </div>`;

  if (!allLayers.length) {
    return `<div class="metric-card metric-card-static card-full">${header}
      <div class="empty-state" style="padding:16px"><i class="fas fa-circle-info"></i><p>Sem dados de nós disponíveis.</p></div>
    </div>`;
  }

  // Monta o fluxo com conectores entre camadas
  const flowHtml = flowLayers.map((layer, i) => {
    const isFirstTier = !layer.isMasterLayer && i > 0 && flowLayers[i - 1].isMasterLayer;
    const connector = i > 0
      ? topologyConnector(isFirstTier ? 'gerencia' : 'ILM →')
      : '';
    return connector + topologyLayerBlock(layer, electedName);
  }).join('');

  const othersHtml = othersLayer
    ? `<div class="topology-others-divider"><span>Outros nós</span></div>${topologyLayerBlock(othersLayer, electedName)}`
    : '';

  return `<div class="metric-card metric-card-static card-full">${header}
    <div class="topology-flow">${flowHtml}${othersHtml}</div>
  </div>`;
}

function sectionCardsVolume(d) {
  const h = d.cluster_health || {};
  return [
    cardNodes(d.total_nodes, h, d.dedicated_master_nodes || 0, d.nodes_summary || []),
    cardStat(null, 'Volume de Dados', 'fa-database', formatBytes(d.total_store_bytes || 0), 'em disco (store, com réplicas)', 'blue',
      'Soma do tamanho em disco de todos os índices (primários + réplicas, incluindo índices de sistema).',
      [], 'help-data-volume'),
    cardStat(null, 'Documentos', 'fa-file-lines', fmtNum(d.total_docs || 0), 'documentos indexados', 'blue',
      'Soma de <code>docs.count</code> de todos os índices — o total de documentos vivos no cluster.',
      [], 'help-total-docs'),
    cardCount('all_indices', 'Total de Índices', 'fa-layer-group', d.total_indices,
      'índices', 'blue', 'blue',
      'Contagem total de índices do cluster, incluindo índices de sistema (prefixo <code>.</code>). Uma contagem elevada pode impactar o desempenho — avalie o uso de data streams para séries temporais. Clique para listar todos os índices.',
      [],
      'Todos os Índices', 'help-total-indices'),
  ].join('');
}

function cardResourceTable(d) {
  const nodes = sortNodesByRole(d.nodes_summary || []);
  const tip = 'Métricas de utilização ao vivo por nó — um indicador por dimensão de saturação. Clique para a visão completa (Heap JVM, GC Overhead, Rejeições e shards por nó).<br>' +
    '<strong>CPU</strong>: uso do processador — acima de 80% por períodos prolongados indica sobrecarga e degrada busca e indexação.<br>' +
    '<strong>Disco</strong>: espaço utilizado — acima de 85% o ES ativa o flood-stage watermark e coloca índices em modo read-only automaticamente.<br>' +
    '<strong>Mem. Pressure</strong>: percentual da geração antiga (old-gen) do heap ocupada após o último GC — indicador real de pressão de memória. Acima de 75% gera pausas longas (GC storms).<br>' +
    '<strong>Parent CB</strong>: percentual do limite do circuit breaker <em>parent</em> em uso no momento — indicador antecipado. Ao chegar a 100% o nó começa a derrubar requisições para proteger a memória.<br>' +
    '<strong>Pressão Escrita</strong>: percentual da memória de buffer de indexação (<code>indexing_pressure</code>) em uso no momento sobre o limite — indicador <em>antecipado</em> e ao vivo de saturação de escrita. Ao chegar a 100% o nó passa a <strong>rejeitar escritas (HTTP 429)</strong>.<br>' +
    '<strong>Fila TP</strong>: soma das requisições enfileiradas nas thread pools do nó. Indicador <em>antecipado</em> de saturação — uma fila crescente precede as rejeições.';

  const colCount = 7;
  const rows = nodes.map(n => {
    const q = n.tp_queue || 0;
    return `<tr>
      <td>${nodeNameCell(n.name, n.roles || [], n.is_master)}</td>
      <td>${pctBar(n.cpu)}</td>
      <td>${pctBar(n.disk_used_percent)}</td>
      <td>${pctBar(n.mem_pressure)}</td>
      <td>${pctBar(n.parent_cb_pct || 0)}</td>
      <td>${pctBar(n.write_pressure_pct || 0)}</td>
      <td style="text-align:right;color:${q > 0 ? 'var(--yellow)' : 'var(--text-muted)'};font-weight:${q > 0 ? '700' : '400'}">${fmtNum(q)}</td>
    </tr>`;
  }).join('');

  const emptyRow = `<tr><td colspan="${colCount}" style="text-align:center;color:var(--text-dim);padding:24px">Nenhum nó encontrado</td></tr>`;

  return `<div class="metric-card card-full" onclick="openDetail('nodes','Nós do Cluster','Detalhes completos — roles, shards e recursos por nó')">
    <div class="card-header">
      <div class="card-icon-title">
        <div class="card-icon"><i class="fas fa-server"></i></div>
        <div class="card-title">Utilização por Nó</div>
      </div>
      ${tooltip(tip, 'help-resource-table')}
    </div>
    <div class="resource-table-wrap">
      <table class="data-table resource-table">
        <thead><tr>
          <th>Nó</th>
          <th>CPU</th>
          <th>Disco</th>
          <th>Mem. Pressure</th>
          <th>Parent CB</th>
          <th>Pressão Escrita</th>
          <th style="text-align:right">Fila TP</th>
        </tr></thead>
        <tbody>${rows || emptyRow}</tbody>
      </table>
    </div>
  </div>`;
}

// ─── Export Config ────────────────────────────────────────
const EXPORT_CONFIG = {
  indices_without_replicas: {
    filename: 'Sem Réplica',
    extract: r => ({
      índice: r.index,
      saúde: r.health,
      primários: r.pri,
      réplicas: r.rep,
      tamanho: r['store.size'],
      documentos: r['docs.count'],
    }),
  },
  unassignable_replicas: {
    filename: 'Réplicas Não Alocáveis',
    extract: r => ({
      índice: r.index,
      saúde: r.health,
      primários: r.pri,
      réplicas: r.rep,
      tamanho: r['store.size'],
      documentos: r['docs.count'],
    }),
  },
  oversharded_indices: {
    filename: 'Índices com Oversharding',
    extract: r => ({
      índice: r.index,
      primários: r.pri,
      réplicas: r.rep,
      tamanho_primários: formatBytes(r.pri_store_bytes),
      tamanho_médio_por_shard: formatBytes(r.avg_shard_bytes),
      documentos: r.docs,
    }),
  },
  large_primary_shards: {
    filename: 'Shards Primários > 50 GB',
    extract: r => ({
      índice: r.index,
      shards_primários: r.shard_count,
      maior_shard_primário: formatBytes(r.max_shard_bytes),
      tamanho_total: formatBytes(r.total_size_bytes),
      tamanho_médio_por_shard: formatBytes(r.shard_count > 0 ? r.total_size_bytes / r.shard_count : 0),
    }),
  },
  indices_without_ilm: {
    filename: 'Sem Política de ILM',
    extract: r => ({
      índice: r.index,
      saúde: r.health,
      primários: r.pri,
      réplicas: r.rep,
      tamanho: r['store.size'],
      documentos: r['docs.count'],
    }),
  },
  ilm_without_delete: {
    filename: 'ILM sem Fase DELETE',
    extract: r => ({
      política: r.name,
      índices: r.index_count,
      fases_configuradas: (r.phases || []).join(', '),
      última_modificação: r.modified_date,
    }),
  },
  ilm_errors: {
    filename: 'ILM com Falha',
    extract: r => ({
      índice: r.index,
      política: r.policy,
      fase: r.phase,
      passo_com_falha: r.failed_step,
      tentativas: r.failed_step_retry_count,
      tipo_do_erro: r.error_type,
      motivo: r.error_reason,
    }),
  },
  circuit_breakers: {
    filename: 'Circuit Breakers',
    extract: r => ({
      nó: r.node,
      breaker: r.breaker,
      disparos: r.tripped,
      uso_estimado: formatBytes(r.estimated_size_in_bytes),
      limite: formatBytes(r.limit_size_in_bytes),
      percentual_do_limite: r.usage_pct,
    }),
  },
  read_only_indices: {
    filename: 'Índices Read-only',
    extract: r => ({
      índice: r.index,
      categoria: r.category === 'flood' ? 'flood-stage (disco)' : 'manual (sem ILM)',
      bloqueios: r.blocks,
      saúde: r.health,
      tamanho: r['store.size'],
      documentos: r['docs.count'],
    }),
  },
};

function exportList() {
  const config = EXPORT_CONFIG[currentMetric];
  if (!config) return;
  const data = currentRows.map(config.extract);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = config.filename + '.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function setExportBtn(visible) {
  const btn = document.getElementById('detailExportBtn');
  if (btn) btn.style.display = visible ? '' : 'none';
}

// ─── Detail Modal ─────────────────────────────────────────

function openShardsDetail() {
  if (!dashboardData) return;
  const h = dashboardData.cluster_health || {};
  const dataNodes = h.number_of_data_nodes || 0;
  const totalShards = dashboardData.total_shards || 0;
  const avgShards = dataNodes ? Math.round(totalShards / dataNodes) : 0;
  const pctRaw = h.active_shards_percent ?? 100;
  const pctColor = pctRaw >= 100 ? 'green' : pctRaw >= 90 ? 'yellow' : 'red';
  const pct = pctRaw >= 100 ? 100 : Math.min(99.9, Math.round(pctRaw * 10) / 10);
  const avgColor = avgShards >= 1000 ? 'red' : avgShards >= 600 ? 'yellow' : null;
  const unassigned = h.unassigned_shards || 0;
  const delayed = h.delayed_unassigned_shards || 0;

  clusterHealthFilters.clear();
  detailNavStack.length = 0;
  document.getElementById('detailTitle').textContent = 'Total de Shards';
  document.getElementById('detailTitleTip').innerHTML = '';
  document.getElementById('detailSubtitle').textContent = '';
  document.getElementById('detailSearch').value = '';
  document.getElementById('detailCount').textContent = '';
  // Este modal não tem tabela filtrável — esconde a barra de busca
  document.getElementById('detailSearchBar').style.display = 'none';
  document.getElementById('detailBreadcrumb').style.display = 'none';
  document.getElementById('detailModal').style.display = 'flex';
  document.body.style.overflow = 'hidden';
  setExportBtn(false);

  const stats = [
    { label: 'Primários', val: fmtNum(h.active_primary_shards), color: null },
    { label: 'Réplicas', val: fmtNum((h.active_shards || 0) - (h.active_primary_shards || 0)), color: null },
    { label: 'Ativos', val: `${pct}%`, color: pctColor },
    { label: 'Média por data node', val: fmtNum(avgShards), color: avgColor },
  ];

  const unassignedLabel = `${fmtNum(unassigned)} shard${unassigned === 1 ? '' : 's'} não alocado${unassigned === 1 ? '' : 's'} aguardando alocação`;
  const delayedNote = delayed > 0 ? ` · ${fmtNum(delayed)} com atraso por timeout` : '';
  const noticeHtml = unassigned > 0 ? `
    <div class="shards-notice">
      <i class="fas fa-circle-info"></i>
      <div class="shards-notice-text">
        <span class="shards-notice-main">${unassignedLabel}</span>
        <span class="shards-notice-sub">Pode incluir restaurações de snapshot e réplicas pendentes. Consulte o diagnóstico para ver o motivo de cada shard.${delayedNote}</span>
      </div>
    </div>` : '';

  document.getElementById('detailBody').innerHTML = `
    <div class="shards-detail">
      <div class="shards-stats">
        ${stats.map(s => `
          <div class="shards-stat">
            <div class="shards-stat-val" ${s.color ? `style="color:var(--${s.color})"` : ''}>${s.val}</div>
            <div class="shards-stat-label">${s.label}</div>
          </div>`).join('')}
      </div>
      ${noticeHtml}
      <div class="shards-recovery">
        <div class="shards-recovery-head">
          <h3><i class="fas fa-right-left"></i> Realocação e Recuperação de Shards</h3>
          <span id="recoveryCount" class="shards-recovery-count"></span>
        </div>
        <div id="recoveryBody">
          <div class="loading-state section-loading"><i class="fas fa-circle-notch fa-spin"></i><span>Carregando...</span></div>
        </div>
      </div>
    </div>`;

  loadRecovery();
}

// Célula nome + roles de um nó a partir do seu nome (mesma regra de "Utilização por
// Nó"). Usada por qualquer modal de listagem de instâncias cujo dado bruto traz só o
// nome do nó (recovery, circuit breakers, shards de índice…); as roles vêm do
// dashboardData já carregado.
function nodeCellByName(name) {
  if (!name) return `<div class="node-name-cell"><div class="node-name">—</div></div>`;
  const nodes = (dashboardData && dashboardData.nodes_summary) || [];
  const n = nodes.find(x => x.name === name);
  return nodeNameCell(name, (n && n.roles) || [], !!(n && n.is_master));
}

// Mapeia o `type` do _recovery em rótulo de operação.
// `desc` = "quando ocorre" (exibido no tooltip, junto do valor cru do ES).
// Pode ser uma string ou uma função (primary) => string, quando o texto depende de
// o shard ser primário ou réplica (caso do PEER).
const RECOVERY_TYPES = {
  PEER: { label: 'Realocação', desc: (primary) => primary
    ? 'Cópia a partir de outro nó — este shard primário está sendo realocado entre nós.'
    : 'Cópia a partir de outro nó — esta réplica está sendo criada/copiada a partir do primário.' },
  SNAPSHOT: { label: 'Restauração (snapshot)', desc: 'Restauração a partir de um snapshot/repositório.' },
  EXISTING_STORE: { label: 'Recuperação local', desc: 'Shard recuperado do disco do próprio nó (ex.: após restart).' },
  EMPTY_STORE: { label: 'Inicialização', desc: 'Shard primário novo e vazio (criação de índice).' },
  LOCAL_SHARDS: { label: 'Redução (shrink)', desc: 'Shard montado a partir de shards locais num _shrink.' },
};

// Estágios do _recovery (em ordem) → significado, exibido no tooltip junto do
// valor cru do ES. DONE não aparece no painel (active_only só lista o que está ativo).
const RECOVERY_STAGES = {
  INIT: 'Recuperação registrada, mas ainda não começou a transferir dados.',
  INDEX: 'Copiando os arquivos do índice (segmentos Lucene) do nó de origem.',
  VERIFY_INDEX: 'Verificando a integridade dos arquivos copiados (checksums).',
  TRANSLOG: 'Reaplicando as operações do translog (escritas ocorridas durante a cópia).',
  FINALIZE: 'Limpeza e finalização (refresh, atualização do cluster state).',
  DONE: 'Recuperação concluída.',
};

// Estados de snapshot em execução (_snapshot/_status).
// Cada entrada: { label: rótulo pt-BR, desc: explicação para o tooltip }.

async function loadRecovery() {
  const body = document.getElementById('recoveryBody');
  if (!body) return;
  try {
    const res = await fetch('/api/recovery');
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    renderRecovery(data);
  } catch (e) {
    body.innerHTML = `<div class="error-state"><i class="fas fa-triangle-exclamation"></i><p>${e.message}</p></div>`;
  }
}

function renderRecovery(rows) {
  const body = document.getElementById('recoveryBody');
  const countEl = document.getElementById('recoveryCount');
  if (!body) return;

  if (!rows || rows.length === 0) {
    if (countEl) countEl.textContent = '';
    body.innerHTML = `<div class="empty-state" style="padding:28px 16px">
      <i class="fas fa-circle-check"></i>
      <p>Nenhuma realocação ou recuperação de shards em andamento.</p></div>`;
    return;
  }

  if (countEl) countEl.textContent = `${rows.length} em andamento`;

  body.innerHTML = `<div class="recovery-list">${rows.map(r => {
    const pct = Math.min(100, Math.max(0, r.bytes_percent || 0));
    const fillColor = pct >= 100 ? 'green' : 'blue';
    const meta = RECOVERY_TYPES[r.type] || { label: r.type || 'Recuperação' };
    const typeDesc = typeof meta.desc === 'function' ? meta.desc(r.primary) : meta.desc;
    const stageDesc = RECOVERY_STAGES[r.stage];
    // Tooltip único do par tipo+estágio. Usa o vocabulário do ES (Type/Stage), mostra
    // o valor cru + o rótulo amigável no tipo, e separa as duas descrições por uma
    // linha em branco (\n\n no title nativo).
    const typePart = `Type: ${r.type} (${meta.label})${typeDesc ? ` — ${typeDesc}` : ''}`;
    const stagePart = `Stage: ${r.stage}${stageDesc ? ` — ${stageDesc}` : ''}`;
    const opTitle = `${typePart}\n\n${stagePart}`;
    const route = r.source_node && r.target_node
      ? `${nodeCellByName(r.source_node)}<i class="fas fa-arrow-right-long rarrow"></i>${nodeCellByName(r.target_node)}`
      : nodeCellByName(r.target_node || r.source_node);
    return `
      <div class="recovery-item">
        <div class="recovery-head">
          <span class="recovery-index">${r.index}</span>
          <span class="recovery-shard">shard ${r.shard} · ${r.primary ? 'Primário' : 'Réplica'}</span>
          <span class="recovery-op" title="${escHtml(opTitle)}">${meta.label} / ${r.stage}</span>
          <span class="recovery-time"><i class="far fa-clock"></i> ${r.time_ms ? fmtDuration(r.time_ms) : '—'}</span>
        </div>
        <div class="recovery-route">${route}</div>
        <div class="recovery-progress">
          <div class="recovery-track"><div class="recovery-fill" style="width:${pct}%;background:var(--${fillColor})"></div></div>
          <span class="recovery-pct">${pct.toFixed(1)}%</span>
          <span class="recovery-bytes">${formatBytes(r.bytes_recovered)} / ${formatBytes(r.bytes_total)}</span>
        </div>
        <div class="recovery-sub">
          <span>Arquivos ${fmtNum(r.files_recovered)} / ${fmtNum(r.files_total)} (${(r.files_percent || 0).toFixed(0)}%)</span>
          <span>Translog ${fmtNum(r.translog_recovered)} / ${fmtNum(r.translog_total)} (${(r.translog_percent || 0).toFixed(0)}%)</span>
        </div>
      </div>`;
  }).join('')}</div>`;
}

// Tooltip de ajuda exibido ao lado do título de certas modais de detalhe, quando a
// lista tem uma regra de recorte que não é óbvia. Mesmo visual dos tooltips dos cards.
const DETAIL_TITLE_TIPS = {
  circuit_breakers: `<strong style="color:var(--text);display:block;margin-bottom:6px">Regra de listagem</strong>
A lista mostra <strong>um breaker por linha</strong> (nó × breaker) e exibe apenas os que merecem atenção — um breaker só aparece quando:<br><br>
<span style="color:var(--red)">●</span>&nbsp;<strong>Disparos &gt; 0</strong>&nbsp;&nbsp;<span style="color:var(--text-dim)">(já abortou requisições), <strong>ou</strong></span><br>
<span style="color:var(--yellow)">●</span>&nbsp;<strong>Uso &ge; 65% do limite</strong>&nbsp;&nbsp;<span style="color:var(--text-dim)">(faixa de atenção)</span><br><br>
Nós cujos breakers estão todos abaixo desses limiares são <strong>omitidos</strong> — o inventário completo de nós fica no card <em>Utilização por Nó</em>.`,
};

async function openDetail(metric, title, subtitle) {
  clusterHealthFilters.clear();
  document.getElementById('detailTitle').textContent = title;
  document.getElementById('detailTitleTip').innerHTML =
    DETAIL_TITLE_TIPS[metric] ? tooltip(DETAIL_TITLE_TIPS[metric]) : '';
  document.getElementById('detailSubtitle').textContent = subtitle;
  document.getElementById('detailSearch').value = '';
  document.getElementById('detailSearchBar').style.display = '';
  document.getElementById('detailBody').innerHTML =
    `<div class="loading-state"><i class="fas fa-circle-notch fa-spin"></i><span>Carregando...</span></div>`;
  document.getElementById('detailModal').style.display = 'flex';
  document.querySelector('#detailModal .detail-card')
    .classList.toggle('detail-card--wide', WIDE_DETAIL_METRICS.has(metric));
  document.body.style.overflow = 'hidden';

  try {
    const res = await fetch(`/api/detail/${metric}`);
    const data = await res.json();

    if (data.error) throw new Error(data.error);

    currentRows = metric === 'nodes' ? sortNodesByRole(data) : data;
    currentSort = { col: null, dir: 'asc' };
    currentMetric = metric;
    renderDetailTable(metric, currentRows);
  } catch (e) {
    document.getElementById('detailBody').innerHTML =
      `<div class="error-state"><i class="fas fa-triangle-exclamation"></i><p>${e.message}</p></div>`;
  }
}

function closeDetail(e) {
  if (e.target === document.getElementById('detailModal')) closeDetailModal();
}

function closeDetailModal() {
  document.getElementById('detailModal').style.display = 'none';
  document.querySelector('#detailModal .detail-card').classList.remove('detail-card--wide');
  document.body.style.overflow = '';
  detailNavStack.length = 0;
  document.getElementById('detailBreadcrumb').style.display = 'none';
  setExportBtn(false);
}

function filterTable() {
  const q = document.getElementById('detailSearch').value.toLowerCase();
  const rows = document.querySelectorAll('#detailBody tbody tr');
  let visible = 0;
  rows.forEach(row => {
    const match = row.textContent.toLowerCase().includes(q);
    row.style.display = match ? '' : 'none';
    if (match) visible++;
  });
  updateCount(visible);
}

function updateCount(n) {
  const el = document.getElementById('detailCount');
  if (el) el.textContent = `${n.toLocaleString('pt-BR')} registros`;
}

// metric → função que renderiza a tabela de detalhe
const DETAIL_RENDERERS = {
  cluster_health: tableClusterHealth,
  all_indices: tableIndices,
  indices_without_replicas: tableIndices,
  unassignable_replicas: tableIndices,
  oversharded_indices: tableOversharded,
  large_primary_shards: tableLargeShards,
  indices_without_ilm: tableIndices,
  ilm_without_delete: tableIlm,
  ilm_errors: tableIlmErrors,
  nodes: tableNodes,
  circuit_breakers: tableCircuitBreakers,
  pending_tasks: tablePendingTasks,
  index_shards: tableIndexShards,
  read_only_indices: tableReadOnly,
};

// Métricas cuja modal de detalhe usa largura estendida (~96vw) por terem tabelas largas
const WIDE_DETAIL_METRICS = new Set(['nodes']);

function renderDetailTableBody(metric, rows) {
  return (DETAIL_RENDERERS[metric] || tableGeneric)(rows);
}

// Mensagem de estado vazio por métrica (quando o detalhe não traz nenhuma linha).
const EMPTY_MESSAGES = {
  slm_policies: {
    icon: 'fa-database',
    text: 'Nenhuma política de snapshot (SLM) configurada — o cluster não tem backups automáticos. Crie uma política em Kibana → Stack Management → Snapshot and Restore (ou via <code>PUT _slm/policy</code>) para garantir recuperação em caso de perda de dados.',
  },
};

function renderDetailTable(metric, rows) {
  const body = document.getElementById('detailBody');

  if (!rows.length) {
    const empty = EMPTY_MESSAGES[metric] || { icon: 'fa-circle-check', text: 'Nenhum item encontrado' };
    body.innerHTML = `<div class="empty-state"><i class="fas ${empty.icon}"></i><p>${empty.text}</p></div>`;
    document.getElementById('detailCount').textContent = '0 registros';
    setExportBtn(false);
    return;
  }

  body.innerHTML = renderDetailTableBody(metric, rows);
  document.getElementById('detailCount').textContent = `${rows.length.toLocaleString('pt-BR')} registros`;
  setExportBtn(!!EXPORT_CONFIG[metric]);
  setupSort(metric, rows);
}

// ─── Table Renderers ──────────────────────────────────────
function healthBadge(status) {
  const c = healthColor(status || '');
  return `<span class="badge badge-${c}">${status || '-'}</span>`;
}

function pctBar(val) {
  const n = parseFloat(val) || 0;
  const c = pctColor(n);
  return `<div style="display:flex;align-items:center;gap:8px;width:100%">
    <span style="font-weight:600;color:var(--${c})">${n}%</span>
    <div class="progress-bar" style="flex:1"><div class="progress-fill progress-${c}" style="width:${Math.min(n, 100)}%"></div></div>
  </div>`;
}

function gcOverheadColor(pct) {
  if (pct >= 25) return 'red';
  if (pct >= 10) return 'yellow';
  return 'green';
}

function gcOverheadBar(val) {
  const n = parseFloat(val) || 0;
  const c = gcOverheadColor(n);
  return `<div style="display:flex;align-items:center;gap:8px;width:100%">
    <span style="font-weight:600;color:var(--${c})">${n}%</span>
    <div class="progress-bar" style="flex:1"><div class="progress-fill progress-${c}" style="width:${Math.min(n, 100)}%"></div></div>
  </div>`;
}

function loadColor(load, availableProcessors) {
  if (!availableProcessors || availableProcessors <= 0) return 'text-muted';
  const ratio = parseFloat(load) / availableProcessors;
  if (ratio >= 0.9) return 'red';
  if (ratio >= 0.7) return 'yellow';
  return 'green';
}

function loadBadge(load, availableProcessors) {
  if (load == null || load === '') return '-';
  const c = loadColor(load, availableProcessors);
  const colorVar = c === 'text-muted' ? 'var(--text-muted)' : `var(--${c})`;
  return `<span style="font-variant-numeric:tabular-nums;font-weight:600;color:${colorVar}">${load}</span>`;
}

function tableClusterHealth(rows) {
  const filterDefs = [
    { key: 'unassigned_shards',   label: 'Não Alocados'  },
    { key: 'relocating_shards',   label: 'Realocando'    },
    { key: 'initializing_shards', label: 'Inicializando' },
  ].filter(f => rows.some(r => (r[f.key] || 0) > 0));

  const visible = clusterHealthFilters.size
    ? rows.filter(r => [...clusterHealthFilters].some(k => (r[k] || 0) > 0))
    : rows;

  const pills = filterDefs.map(f => {
    const sel = clusterHealthFilters.has(f.key);
    return `<button class="task-action-pill${sel ? ' selected' : ''}" onclick="toggleClusterHealthFilter('${f.key}')">${f.label}</button>`;
  }).join('');

  const clearBtn = clusterHealthFilters.size
    ? `<button class="tasks-filter-clear" onclick="clearClusterHealthFilter()"><i class="fas fa-xmark"></i> Limpar</button>`
    : '';

  const filterHtml = filterDefs.length
    ? `<div class="tasks-filter">\n    <span class="tasks-filter-label">Filtrar</span>\n    ${pills}\n    ${clearBtn}\n  </div>`
    : '';

  return `${filterHtml}<table class="data-table">
    <thead><tr>
      <th data-col="index">Índice <span class="sort-icon">↕</span></th>
      <th data-col="status">Status <span class="sort-icon">↕</span></th>
      <th data-col="active_primary_shards" data-type="num">Primários <span class="sort-icon">↕</span></th>
      <th data-col="number_of_replicas" data-type="num">Réplicas <span class="sort-icon">↕</span></th>
      <th data-col="unassigned_shards" data-type="num">Não Alocados <span class="sort-icon">↕</span></th>
      <th data-col="relocating_shards" data-type="num">Realocando <span class="sort-icon">↕</span></th>
      <th data-col="initializing_shards" data-type="num">Inicializando <span class="sort-icon">↕</span></th>
    </tr></thead>
    <tbody>${visible.map(r => `<tr>
      <td style="font-family:monospace;font-size:12px"><span class="index-link" data-index="${escHtml(r.index)}" onclick="event.stopPropagation();openIndexShards(this.dataset.index)">${escHtml(r.index)}</span></td>
      <td>${healthBadge(r.status)}</td>
      <td>${fmtNum(r.active_primary_shards)}</td>
      <td style="color:${r.number_of_replicas === 0 ? 'var(--yellow)' : 'var(--text)'}">${fmtNum(r.number_of_replicas)}</td>
      <td style="color:${r.unassigned_shards > 0 ? 'var(--red)' : 'var(--text-muted)'}">${fmtNum(r.unassigned_shards)}</td>
      <td style="color:${r.relocating_shards > 0 ? 'var(--yellow)' : 'var(--text-muted)'}">${fmtNum(r.relocating_shards)}</td>
      <td style="color:${r.initializing_shards > 0 ? 'var(--yellow)' : 'var(--text-muted)'}">${fmtNum(r.initializing_shards)}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function toggleClusterHealthFilter(key) {
  if (clusterHealthFilters.has(key)) clusterHealthFilters.delete(key);
  else clusterHealthFilters.add(key);
  renderDetailTable('cluster_health', currentRows);
}

function clearClusterHealthFilter() {
  clusterHealthFilters.clear();
  renderDetailTable('cluster_health', currentRows);
}

function tableIndices(rows) {
  return `<table class="data-table">
    <thead><tr>
      <th data-col="index">Índice <span class="sort-icon">↕</span></th>
      <th data-col="health">Saúde <span class="sort-icon">↕</span></th>
      <th data-col="pri">Primários <span class="sort-icon">↕</span></th>
      <th data-col="rep">Réplicas <span class="sort-icon">↕</span></th>
      <th data-col="store.size" data-type="size">Tamanho <span class="sort-icon">↕</span></th>
      <th data-col="docs.count" data-type="num">Documentos <span class="sort-icon">↕</span></th>
    </tr></thead>
    <tbody>${rows.map(r => `<tr>
      <td style="font-family:monospace;font-size:12px"><span class="index-link" data-index="${escHtml(r.index)}" onclick="event.stopPropagation();openIndexShards(this.dataset.index)">${escHtml(r.index)}</span></td>
      <td>${healthBadge(r.health)}</td>
      <td>${r.pri || '-'}</td>
      <td><span style="color:${r.rep === '0' ? 'var(--yellow)' : 'var(--text)'}">${r.rep || '-'}</span></td>
      <td>${r['store.size'] || '-'}</td>
      <td>${fmtNum(r['docs.count'])}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function tableOversharded(rows) {
  return `<table class="data-table">
    <thead><tr>
      <th data-col="index">Índice <span class="sort-icon">↕</span></th>
      <th data-col="pri" data-type="num">Primários <span class="sort-icon">↕</span></th>
      <th data-col="rep" data-type="num">Réplicas <span class="sort-icon">↕</span></th>
      <th data-col="pri_store_bytes" data-type="num">Tamanho Primários <span class="sort-icon">↕</span></th>
      <th data-col="avg_shard_bytes" data-type="num">Médio/Shard <span class="sort-icon">↕</span></th>
      <th data-col="docs" data-type="num">Documentos <span class="sort-icon">↕</span></th>
    </tr></thead>
    <tbody>${rows.map(r => `<tr>
      <td style="font-family:monospace;font-size:12px">${escHtml(r.index)}</td>
      <td>${fmtNum(r.pri)}</td>
      <td>${fmtNum(r.rep)}</td>
      <td>${formatBytes(r.pri_store_bytes)}</td>
      <td style="color:var(--yellow);font-weight:600">${formatBytes(r.avg_shard_bytes)}</td>
      <td>${fmtNum(r.docs)}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function tableLargeShards(rows) {
  return `<table class="data-table">
    <thead><tr>
      <th data-col="index">Índice <span class="sort-icon">↕</span></th>
      <th data-col="shard_count" data-type="num">Shards Primários <span class="sort-icon">↕</span></th>
      <th data-col="max_shard_bytes" data-type="num">Maior Shard Primário <span class="sort-icon">↕</span></th>
      <th data-col="total_size_bytes" data-type="num">Tamanho Total <span class="sort-icon">↕</span></th>
      <th data-col="total_size_bytes" data-type="num">Tamanho Médio/Shard <span class="sort-icon">↕</span></th>
    </tr></thead>
    <tbody>${rows.map(r => `<tr>
      <td style="font-family:monospace;font-size:12px">${r.index}</td>
      <td>${r.shard_count}</td>
      <td style="color:var(--red);font-weight:600">${formatBytes(r.max_shard_bytes)}</td>
      <td>${formatBytes(r.total_size_bytes)}</td>
      <td>${formatBytes(r.shard_count > 0 ? r.total_size_bytes / r.shard_count : 0)}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function tableIlm(rows) {
  return `<table class="data-table">
    <thead><tr>
      <th data-col="name">Política <span class="sort-icon">↕</span></th>
      <th data-col="index_count" data-type="num">Índices <span class="sort-icon">↕</span></th>
      <th data-col="phases">Fases Configuradas <span class="sort-icon">↕</span></th>
      <th data-col="modified_date">Última Modificação <span class="sort-icon">↕</span></th>
    </tr></thead>
    <tbody>${rows.map(r => `<tr>
      <td style="font-family:monospace;font-size:12px">${r.name}</td>
      <td style="font-weight:600">${fmtNum(r.index_count ?? 0)}</td>
      <td>${(r.phases || []).map(p => `<span class="badge badge-blue" style="margin-right:4px">${p}</span>`).join('')}</td>
      <td style="color:var(--text-muted);font-size:12px">${r.modified_date || '-'}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function tableIlmErrors(rows) {
  return `<table class="data-table">
    <thead><tr>
      <th data-col="index">Índice <span class="sort-icon">↕</span></th>
      <th data-col="policy">Política <span class="sort-icon">↕</span></th>
      <th data-col="phase">Fase <span class="sort-icon">↕</span></th>
      <th data-col="failed_step">Passo com Falha <span class="sort-icon">↕</span></th>
      <th data-col="failed_step_retry_count" data-type="num">Tentativas <span class="sort-icon">↕</span></th>
      <th data-col="error_type">Tipo do Erro <span class="sort-icon">↕</span></th>
      <th data-col="error_reason">Motivo <span class="sort-icon">↕</span></th>
      <th></th>
    </tr></thead>
    <tbody>${rows.map(r => `<tr class="task-row" onclick="showIlmErrorJson(this.dataset.index)" data-index="${escHtml(r.index)}">
      <td style="font-family:monospace;font-size:12px"><span class="index-link" data-index="${escHtml(r.index)}" onclick="event.stopPropagation();openIndexShards(this.dataset.index)">${escHtml(r.index)}</span></td>
      <td style="font-family:monospace;font-size:12px">${escHtml(r.policy)}</td>
      <td><span class="badge badge-blue">${escHtml(r.phase)}</span></td>
      <td style="font-family:monospace;font-size:12px;color:var(--red)">${escHtml(r.failed_step)}</td>
      <td style="text-align:center;color:var(--text-muted)">${r.failed_step_retry_count ?? '-'}</td>
      <td><span class="badge badge-red">${escHtml(r.error_type)}</span></td>
      <td style="color:var(--text-muted);font-size:12px;max-width:480px;white-space:normal">${escHtml(r.error_reason)}</td>
      <td style="text-align:right;color:var(--text-dim)" title="Ver JSON completo"><i class="fas fa-code"></i></td>
    </tr>`).join('')}</tbody>
  </table>`;
}

const READ_ONLY_CAT = { flood: ['badge-red', 'Flood-stage (disco)'], manual: ['badge-yellow', 'Manual (sem ILM)'] };

function tableReadOnly(rows) {
  return `<table class="data-table">
    <thead><tr>
      <th data-col="index">Índice <span class="sort-icon">↕</span></th>
      <th data-col="category">Categoria <span class="sort-icon">↕</span></th>
      <th data-col="blocks">Bloqueio(s) <span class="sort-icon">↕</span></th>
      <th data-col="health">Saúde <span class="sort-icon">↕</span></th>
      <th data-col="store.size" data-type="size">Tamanho <span class="sort-icon">↕</span></th>
      <th data-col="docs.count" data-type="num">Documentos <span class="sort-icon">↕</span></th>
    </tr></thead>
    <tbody>${rows.map(r => {
      const [catCls, catLabel] = READ_ONLY_CAT[r.category] || ['badge-gray', r.category || '-'];
      const blockCls = r.category === 'flood' ? 'badge-red' : 'badge-yellow';
      return `<tr>
      <td style="font-family:monospace;font-size:12px"><span class="index-link" data-index="${escHtml(r.index)}" onclick="event.stopPropagation();openIndexShards(this.dataset.index)">${escHtml(r.index)}</span></td>
      <td><span class="badge ${catCls}">${catLabel}</span></td>
      <td>${(r.blocks || '').split(', ').filter(Boolean).map(b => `<span class="badge ${blockCls}" style="margin-right:4px">${escHtml(b)}</span>`).join('')}</td>
      <td>${healthBadge(r.health)}</td>
      <td>${r['store.size'] || '-'}</td>
      <td>${fmtNum(r['docs.count'])}</td>
    </tr>`;
    }).join('')}</tbody>
  </table>`;
}

// Abre o JSON completo da entrada de _ilm/explain para o índice clicado
function showIlmErrorJson(indexName) {
  const row = currentRows.find(r => r.index === indexName);
  if (!row) return;
  showJsonModal('Detalhes do Erro de ILM', indexName, row);
}

// ─── Modal de JSON genérico ───────────────────────────────
function showJsonModal(title, subtitle, obj) {
  document.getElementById('jsonModalTitle').textContent = title;
  document.getElementById('jsonModalSubtitle').textContent = subtitle || '';
  document.getElementById('jsonModalBody').textContent = JSON.stringify(obj, null, 2);
  document.getElementById('jsonModal').style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closeJsonModal() {
  document.getElementById('jsonModal').style.display = 'none';
  document.body.style.overflow = '';
}

const ROLE_COLOR = {
  master: 'yellow', data: 'blue', data_hot: 'blue', data_warm: 'blue',
  data_cold: 'blue', data_frozen: 'blue', ingest: 'green',
  ml: 'gray', voting_only: 'gray',
};

// Rótulos curtos das roles para a linha compacta abaixo do nome do nó
const ROLE_SHORT = {
  master: 'MASTER', data: 'DATA', data_content: 'CONTENT', data_hot: 'HOT',
  data_warm: 'WARM', data_cold: 'COLD', data_frozen: 'FROZEN',
  ingest: 'INGEST', ml: 'ML', voting_only: 'VOTING',
};
// Roles principais exibidas (em ordem) na linha compacta sob o nome do nó
const ROLE_INLINE_ORDER = ['master', 'data_hot', 'data_warm', 'data_cold', 'data_frozen'];
const ROLE_CSS_VAR = { yellow: '--yellow', blue: '--blue', green: '--green', gray: '--text-dim' };

// Um nó é considerado dedicado a ML quando tem a role `ml` e nenhuma role de
// master ou de dados. Nesse caso a linha compacta — que normalmente ficaria
// vazia (ML não é uma role de tier) — passa a exibir ML, para não deixar o nó
// sem role visível.
function isDedicatedMl(roles) {
  const r = Array.isArray(roles) ? roles : [];
  return r.includes('ml') && !r.includes('master') && !r.some(x => x.startsWith('data'));
}

// Linha compacta e colorida ("MASTER / HOT / WARM / ...") exibida sob o nome do nó
function renderRolesInline(roles, isElectedMaster) {
  if (!Array.isArray(roles) || !roles.length) return '';
  const present = new Set(roles);
  const ordered = ROLE_INLINE_ORDER.filter(r => present.has(r));
  if (isDedicatedMl(roles)) ordered.push('ml');
  if (!ordered.length) return '';
  return ordered.map(role => {
    const v = ROLE_CSS_VAR[ROLE_COLOR[role] || 'gray'] || '--text-dim';
    const star = (role === 'master' && isElectedMaster) ? '&#9733;' : '';
    return `<span style="color:var(${v})">${star}${ROLE_SHORT[role] || role.toUpperCase()}</span>`;
  }).join('<span style="color:var(--text-dim)"> / </span>');
}

// Texto do hover (title) listando TODAS as roles do nó (master eleito com ★)
function rolesTitle(roles, isElectedMaster) {
  const all = (Array.isArray(roles) ? roles : []).slice().sort();
  const titleRoles = all.map(r => (r === 'master' && isElectedMaster) ? `★ ${r}` : r).join(', ');
  return titleRoles ? `Roles: ${titleRoles}` : 'Sem roles';
}

// Célula que mescla nome + roles; o title (hover) lista TODAS as roles do nó
function nodeNameCell(name, roles, isElectedMaster) {
  const inline = renderRolesInline(roles, isElectedMaster);
  const title = rolesTitle(roles, isElectedMaster);
  const safeAttr = (name || '').replace(/'/g, '&#39;');
  const click = name ? ` onclick="event.stopPropagation();openNodeModal('${safeAttr}')"` : '';
  return `<div class="node-name-cell" title="${title}">
    <div class="node-name node-name-clickable"${click}>${escHtml(name) || '-'}</div>
    ${inline ? `<div class="node-roles-inline">${inline}</div>` : ''}
  </div>`;
}

// Nome do master eleito, a partir dos dados de dashboard já carregados (para a ★)
function electedMasterName() {
  const nodes = (dashboardData && dashboardData.nodes_summary) || [];
  const m = nodes.find(n => n.is_master);
  return m ? m.name : null;
}

// ─── Página Diagnóstico ───────────────────────────────────
// Leitura interpretada dos dados, reaproveitando o estado já carregado pela
// Sinais Vitais (dashboardData/tasksList) — sem nenhuma requisição extra.

// Tier predominante do nó a partir das roles (frozen > cold > warm > hot)
function nodeTier(roles) {
  const present = new Set(Array.isArray(roles) ? roles : []);
  if (present.has('data_frozen')) return 'FROZEN';
  if (present.has('data_cold')) return 'COLD';
  if (present.has('data_warm')) return 'WARM';
  if (present.has('data_hot')) return 'HOT';
  return null;
}

// Ordem padrão da coluna "Nó" nas tabelas de utilização/detalhe: MASTER dedicado >
// OUTROS (sem master, sem tier/data_content) > HOT/DATA_CONTENT > WARM > COLD > FROZEN,
// e alfabético dentro de cada grupo.
function nodeSortRank(roles) {
  const r = Array.isArray(roles) ? roles : [];
  const hasData = r.some(x => x.startsWith('data'));
  if (r.includes('master') && !hasData) return 0;
  if (r.includes('data_hot') || r.includes('data_content')) return 2;
  if (r.includes('data_warm')) return 3;
  if (r.includes('data_cold')) return 4;
  if (r.includes('data_frozen')) return 5;
  return 1;
}

function sortNodesByRole(nodes) {
  return [...nodes].sort((a, b) => {
    const ra = nodeSortRank(a.roles), rb = nodeSortRank(b.roles);
    if (ra !== rb) return ra - rb;
    return (a.name || '').localeCompare(b.name || '');
  });
}

function insightCard(sev, icon, title, metric, desc, tag, onclick) {
  const click = onclick ? ` onclick="${onclick}"` : '';
  return `<div class="insight-card sev-${sev}">
    <div class="insight-icon"><i class="fas ${icon}"></i></div>
    <div class="insight-body">
      <div class="insight-head"><span class="insight-title">${title}</span>${metric ? `<span class="insight-metric">${metric}</span>` : ''}</div>
      <div class="insight-desc">${desc}</div>
      ${tag ? `<div class="insight-tag"${click}><i class="fas fa-arrow-right"></i>${tag}</div>` : ''}
    </div>
  </div>`;
}

// Detalhe local (sem backend) do insight "heap acima de 50% da RAM": lista só os
// nós alertados, com nome+role, o % do heap sobre a RAM, o heap e a RAM total.
// Alimentado pelo dashboardData já carregado (mesmo padrão de openShardsDetail).
function openHeapRamDetail() {
  if (!dashboardData) return;
  const nodes = (dashboardData.nodes_summary || [])
    .filter(n => n.heap_max && n.ram_total && n.heap_max / n.ram_total > 0.5)
    .sort((a, b) => (b.heap_max / b.ram_total) - (a.heap_max / a.ram_total));

  clusterHealthFilters.clear();
  detailNavStack.length = 0;
  document.getElementById('detailTitle').textContent = 'Heap acima de 50% da RAM';
  document.getElementById('detailTitleTip').innerHTML = '';
  document.getElementById('detailSubtitle').textContent =
    `${fmtNum(nodes.length)} nó${nodes.length !== 1 ? 's' : ''} — o heap deve ficar em ≤ 50% da RAM física`;
  document.getElementById('detailSearch').value = '';
  document.getElementById('detailCount').textContent = '';
  document.getElementById('detailSearchBar').style.display = 'none';
  document.getElementById('detailBreadcrumb').style.display = 'none';
  document.querySelector('#detailModal .detail-card').classList.remove('detail-card--wide');
  document.getElementById('detailModal').style.display = 'flex';
  document.body.style.overflow = 'hidden';
  setExportBtn(false);

  const body = document.getElementById('detailBody');
  if (!nodes.length) {
    body.innerHTML = `<div class="empty-state"><i class="fas fa-circle-check"></i><p>Nenhum nó com heap acima de 50% da RAM.</p></div>`;
    return;
  }
  const rows = nodes.map(n => {
    const pct = Math.round(n.heap_max / n.ram_total * 100);
    const color = pct >= 75 ? 'red' : 'yellow';
    return `<tr>
      <td>${nodeNameCell(n.name, n.roles, n.is_master)}</td>
      <td><span class="text-${color}" style="font-weight:700">${pct}%</span></td>
      <td>${formatBytes(n.heap_max)}</td>
      <td>${formatBytes(n.ram_total)}</td>
    </tr>`;
  }).join('');
  body.innerHTML = `<table class="data-table">
    <thead><tr>
      <th>Nó</th>
      <th>Heap / RAM</th>
      <th>Heap</th>
      <th>RAM total</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderInsights() {
  const el = document.getElementById('page-insights');
  if (!el) return;
  const d = dashboardData;
  if (!d) {
    el.innerHTML = `<div class="empty-state">
      <i class="fas fa-circle-info"></i>
      <p>Sem dados ainda — abra os Sinais Vitais para carregar as métricas.</p>
    </div>`;
    return;
  }

  const h = d.cluster_health || {};
  const status = h.status || 'green';
  const nodes = d.nodes_summary || [];
  const insights = [];
  const add = (sev, icon, title, metric, desc, tag, onclick) =>
    insights.push({ sev, html: insightCard(sev, icon, title, metric, desc, tag, onclick) });
  const plural = (n) => n !== 1 ? 's' : '';

  // 1. Índices sem réplica
  const noRep = d.indices_without_replicas || 0;
  if (noRep > 0) {
    const total = d.total_indices || 0;
    const pct = total ? Math.round(noRep / total * 100) : 0;
    add('red', 'fa-shield-halved',
      `${fmtNum(noRep)} índice${plural(noRep)} sem réplica`,
      total ? `≈ ${pct}% do total` : '',
      'Índices sem cópia — a perda de um único data node pode significar perda de dados.',
      'Listar índices sem réplica',
      `openDetail('indices_without_replicas','Índices sem Réplica','')`);
  }

  // 2. Índices sem política de ILM
  const noIlm = d.indices_without_ilm || 0;
  if (noIlm > 0) {
    add('yellow', 'fa-clock-rotate-left',
      `${fmtNum(noIlm)} índice${plural(noIlm)} sem política de ILM`,
      'sem ciclo de vida',
      'Crescem sem rollover nem expurgo automático — risco de saturar o disco com o tempo.',
      'Listar índices sem política de ILM',
      `openDetail('indices_without_ilm','Sem Política de ILM','')`);
  }

  // 3. Disco alto por tier — um card por tier afetado (≥70%); vermelho se ≥85%
  const byTier = {};
  for (const n of nodes) {
    const tier = nodeTier(n.roles);
    const disk = n.disk_used_percent;
    if (tier == null || disk == null || disk < 70) continue;
    (byTier[tier] = byTier[tier] || []).push(n);
  }
  for (const tier of ['HOT', 'WARM', 'COLD', 'FROZEN']) {
    const hot = byTier[tier];
    if (!hot || !hot.length) continue;
    hot.sort((a, b) => b.disk_used_percent - a.disk_used_percent);
    const max = hot[0].disk_used_percent;
    const list = hot.map(n => `${n.name} (${n.disk_used_percent.toFixed(1)}%)`).join(', ');
    // Watermarks padrão do ES: low 85% (não aloca novos), high 90% (realoca para fora), flood 95% (read-only)
    let tail;
    if (max >= 95) tail = 'nível de flood-stage (≥ 95%) — índices podem entrar em modo read-only.';
    else if (max >= 90) tail = 'acima do high watermark (≥ 90%) — o ES força a realocação de shards para fora do nó.';
    else if (max >= 85) tail = 'acima do low watermark (≥ 85%) — novos shards deixam de ser alocados no nó.';
    else tail = 'acima do limite de alerta (70%).';
    add(max >= 85 ? 'red' : 'yellow', 'fa-hard-drive',
      `Disco alto no tier ${tier}`,
      `${hot.length} nó${plural(hot.length)} ≥ 70%`,
      `${list} — ${tail}`,
      'Ver detalhes',
      'openDiskModal()');
  }

  // 4. Políticas de ILM sem fase delete
  const ilmNoDel = d.ilm_without_delete || 0;
  if (ilmNoDel > 0) {
    add('yellow', 'fa-trash-can',
      `${fmtNum(ilmNoDel)} política${plural(ilmNoDel)} de ILM sem fase delete`,
      'retenção infinita',
      'Dados gerenciados por essas políticas migram entre tiers mas nunca são removidos.',
      'Listar políticas sem fase delete',
      `openDetail('ilm_without_delete','ILM sem Fase DELETE','')`);
  }

  // 5. Réplicas não alocáveis (rep >= nº de data nodes) — mantém o cluster YELLOW
  const unassignRep = d.unassignable_replicas || 0;
  if (unassignRep > 0) {
    const dataNodes = h.number_of_data_nodes || 0;
    add('red', 'fa-clone',
      `${fmtNum(unassignRep)} índice${plural(unassignRep)} com réplicas não alocáveis`,
      `≥ ${dataNodes} data node${plural(dataNodes)}`,
      'O número de réplicas é maior ou igual ao de data nodes, então essas réplicas nunca alocam e mantêm o cluster em YELLOW. Reduza as réplicas ou adicione data nodes.',
      'Listar índices afetados',
      `openDetail('unassignable_replicas','Réplicas Não Alocáveis','')`);
  }

  // 6. Quorum de master frágil (poucos master-eligible ou número par)
  const me = d.master_eligible_nodes || 0;
  const totalNodes = d.total_nodes || 0;
  if (totalNodes > 1 && (me < 3 || me % 2 === 0)) {
    const sev = me < 3 ? 'red' : 'yellow';
    const msg = me < 3
      ? `Há apenas ${fmtNum(me)} nó${plural(me)} master-eligible — sem tolerância à falha do master (o recomendado em produção são 3).`
      : `${fmtNum(me)} nós master-eligible (número par) — recomenda-se um número ímpar para um quorum saudável e evitar split-brain.`;
    add(sev, 'fa-crown',
      'Quorum de master frágil',
      `${fmtNum(me)} master-eligible`,
      msg,
      'Ver nós',
      `openDetail('nodes','Nós do Cluster','')`);
  }

  // 7. Oversharding — vários primários com tamanho médio por shard < 1 GB
  const overshard = d.oversharded_indices || 0;
  if (overshard > 0) {
    add('yellow', 'fa-grip',
      `${fmtNum(overshard)} índice${plural(overshard)} com oversharding`,
      'shards pequenos demais',
      'Índices com mais de um shard primário e tamanho médio por shard abaixo de 1 GB — muitos shards pequenos desperdiçam heap e geram overhead de cluster.',
      'Listar índices',
      `openDetail('oversharded_indices','Índices com Oversharding','')`);
  }

  // 8. Pressão de memória (GC overhead ≥ 25% ou mem pressure ≥ 75% em algum nó)
  const memHot = nodes.filter(n => (n.gc_overhead || 0) >= 25 || (n.mem_pressure || 0) >= 75);
  if (memHot.length) {
    const list = memHot.map(n => n.name).join(', ');
    add('yellow', 'fa-memory',
      `${fmtNum(memHot.length)} nó${plural(memHot.length)} sob pressão de memória`,
      'GC / heap alto',
      `${list} — GC overhead ≥ 25% ou memory pressure ≥ 75%, sinal de heap pressionado (risco de pausas longas de GC).`,
      'Ver nós',
      `openDetail('nodes','Nós do Cluster','')`);
  }

  // 8a2. Heap acima de 50% da RAM física (pouca memória para o filesystem cache)
  const heapBig = nodes.filter(n => n.heap_max && n.ram_total && n.heap_max / n.ram_total > 0.5);
  if (heapBig.length) {
    const list = heapBig.map(n => `${n.name} (${Math.round(n.heap_max / n.ram_total * 100)}%)`).join(', ');
    add('yellow', 'fa-scale-unbalanced',
      `${fmtNum(heapBig.length)} nó${plural(heapBig.length)} com heap acima de 50% da RAM`,
      'Heap desproporcional',
      `${list} — o heap ocupa mais da metade da RAM física, sobrando pouca memória para o filesystem cache (essencial ao desempenho de busca do ES). O recomendado é manter o heap em ≤ 50% da RAM.`,
      'Ver nós',
      `openHeapRamDetail()`);
  }

  // 8b. Pressão de escrita ao vivo (indexing_pressure ≥ 70% em algum nó)
  const writeHot = nodes.filter(n => (n.write_pressure_pct || 0) >= 70);
  if (writeHot.length) {
    const critical = writeHot.some(n => (n.write_pressure_pct || 0) >= 90);
    const list = writeHot.map(n => `${n.name} (${n.write_pressure_pct}%)`).join(', ');
    add(critical ? 'red' : 'yellow', 'fa-pen-to-square',
      `${fmtNum(writeHot.length)} nó${plural(writeHot.length)} sob pressão de escrita`,
      'Indexing pressure alto',
      `${list} — memória de buffer de indexação acima de 70% do limite. Ao chegar a 100% o nó passa a rejeitar escritas (HTTP 429). Veja a coluna "Pressão Escrita" na tabela de nós.`,
      'Ver nós',
      `openDetail('nodes','Nós do Cluster','')`);
  }

  // 9. Versões de ES mistas (rolling upgrade em andamento/incompleto)
  const versions = d.node_versions || [];
  if (versions.length > 1) {
    add('yellow', 'fa-code-branch',
      'Versões de Elasticsearch mistas',
      `${versions.length} versões`,
      `Nós rodando versões diferentes (${escHtml(versions.join(', '))}) — rolling upgrade em andamento ou incompleto. Evite operações prolongadas (reindex, snapshots grandes) até concluir.`,
      'Ver nós',
      `openDetail('nodes','Nós do Cluster','')`);
  }

  // 10. Backup / SLM (só avalia quando a consulta de SLM esteve disponível)
  const slm = d.slm || {};
  if (slm.available) {
    if (slm.failed > 0) {
      add('red', 'fa-database',
        `${fmtNum(slm.failed)} política${plural(slm.failed)} de snapshot com falha`,
        'backup falhando',
        'A execução mais recente de uma ou mais políticas de SLM falhou — os backups podem estar desatualizados. Verifique o repositório de snapshots.',
        'Revisar SLM',
        `openDetail('slm_policies','Políticas de Snapshot (SLM)','Último backup, falhas e agendamento')`);
    } else if (!slm.configured) {
      add('yellow', 'fa-database',
        'Sem política de backup (SLM)',
        'sem snapshots automáticos',
        'Não há nenhuma política de snapshot (SLM) configurada — o cluster não possui backups automáticos. Configure o SLM para garantir recuperação em caso de perda de dados.',
        'Configurar SLM',
        `openDetail('slm_policies','Políticas de Snapshot (SLM)','Backups automáticos do cluster')`);
    }
  }

  // 11. Tarefa longa em execução (reusa tasksList já carregado pelos Sinais Vitais)
  if (Array.isArray(tasksList) && tasksList.length) {
    const longest = tasksList.reduce((a, b) =>
      (b.running_time_in_nanos || 0) > (a.running_time_in_nanos || 0) ? b : a);
    // Contagem por operação (tarefas-pai), coerente com o badge da seção; o "mais
    // longa" continua sendo o maior tempo bruto (o pai carrega o tempo total).
    const ops = taskRoots(tasksList).length;
    add('blue', 'fa-gears',
      `${fmtNum(ops)} tarefa${plural(ops)} longa${plural(ops)} em execução`,
      `${fmtNanosToSecs(longest.running_time_in_nanos || 0)} ativa`,
      `Mais longa: <code>${escHtml(longest.action || '—')}</code> no ${escHtml(longest.node || '—')}.`,
      'Ver tarefas em execução',
      'goToTasks()');
  }

  // 12. Índices com bloqueio de escrita — flood-stage (red) e manual sem ILM (yellow);
  //     read-only definido pelo ILM é esperado e não entra aqui.
  const ro = d.read_only_indices || {};
  const roFlood = ro.flood || 0;
  const roManual = ro.manual || 0;
  if (roFlood > 0) {
    add('red', 'fa-lock',
      `${fmtNum(roFlood)} índice${plural(roFlood)} bloqueado${plural(roFlood)} por flood-stage`,
      'disco / escrita bloqueada',
      'Bloqueio de escrita aplicado automaticamente pelo ES quando o disco passou de 95% (flood-stage). Pode persistir mesmo após liberar disco — verifique e remova com <code>"index.blocks.read_only_allow_delete": null</code> depois de resolver o espaço.',
      'Listar índices bloqueados',
      `openDetail('read_only_indices','Índices Read-only','')`);
  }
  if (roManual > 0) {
    add('yellow', 'fa-lock',
      `${fmtNum(roManual)} índice${plural(roManual)} read-only sem ILM`,
      'bloqueio manual',
      'Índices com bloqueio de escrita (<code>read_only</code>/<code>write</code>) que <strong>não</strong> são gerenciados por ILM — pode ser intencional (dados arquivados) ou um bloqueio manual esquecido. Índices deixados read-only pelo ILM não entram aqui.',
      'Listar índices bloqueados',
      `openDetail('read_only_indices','Índices Read-only','')`);
  }

  // 13. Configurações de cluster de risco (alocação desligada, watermarks, read-only…)
  const cs = d.cluster_settings_risks || {};
  if (cs.available && (cs.red > 0 || cs.yellow > 0)) {
    const n = cs.red + cs.yellow;
    add(cs.red > 0 ? 'red' : 'yellow', 'fa-sliders',
      `${fmtNum(n)} ${n !== 1 ? 'configurações de cluster de risco' : 'configuração de cluster de risco'}`,
      'overrides',
      'Sobrescritas no cluster que podem causar problemas — por exemplo alocação de shards restrita, watermarks de disco desabilitados ou cluster em read-only.',
      'Revisar configurações',
      `openDetail('cluster_settings','Configurações de Cluster de Risco','')`);
  }

  // 14. Deprecations (prontidão para upgrade)
  const dep = d.deprecations || {};
  if (dep.available && dep.total > 0) {
    const parts = [];
    if (dep.critical) parts.push(`${fmtNum(dep.critical)} crítico${plural(dep.critical)}`);
    if (dep.warning) parts.push(`${fmtNum(dep.warning)} aviso${plural(dep.warning)}`);
    add(dep.critical > 0 ? 'red' : 'yellow', 'fa-clipboard-check',
      `${fmtNum(dep.total)} aviso${plural(dep.total)} de deprecação`,
      'prontidão p/ upgrade',
      `${parts.join(' e ')} — configurações que vão mudar ou quebrar na próxima versão major. Resolva antes de atualizar.`,
      'Ver deprecations',
      `openDetail('deprecations','Deprecations','Prontidão para upgrade')`);
  }

  // 15. Licença expirada ou expirando
  const lic = d.license || {};
  if (lic.available && (lic.status === 'expired' || (lic.days_left != null && lic.days_left <= 30))) {
    const expired = lic.status === 'expired';
    const sev = (expired || (lic.days_left != null && lic.days_left <= 7)) ? 'red' : 'yellow';
    const type = (lic.type || '-').toUpperCase();
    const msg = expired
      ? `A licença ${escHtml(type)} está expirada — recursos licenciados podem estar desativados.`
      : `A licença ${escHtml(type)} expira em ${fmtNum(lic.days_left)} dia${plural(lic.days_left)}. Renove para não perder recursos.`;
    add(sev, 'fa-id-card',
      expired ? 'Licença expirada' : 'Licença expirando',
      escHtml(type),
      msg,
      'Ver licenciamento');
  }

  // 16. Shards não alocados — diagnóstico via allocation explain
  const unassignedShards = h.unassigned_shards || 0;
  if (unassignedShards > 0) {
    add('red', 'fa-circle-question',
      `${fmtNum(unassignedShards)} shard${plural(unassignedShards)} não alocado${plural(unassignedShards)} — diagnóstico`,
      'allocation explain',
      'Descubra a razão exata pela qual cada shard não aloca (a decisão dos deciders por nó) via <code>_cluster/allocation/explain</code>.',
      'Diagnosticar alocação',
      `openDetail('allocation_explain','Diagnóstico de Alocação','Por que cada shard não aloca')`);
  }

  // 17. Disponibilidade — só aparece quando há problema (oculta se tudo saudável)
  const unassigned = h.unassigned_shards || 0;
  const cbTrips = d.circuit_breaker_trips || 0;
  const activePct = h.active_shards_percent ?? 100;
  const availabilityAdded = status !== 'green' || unassigned > 0 || cbTrips > 0;
  if (availabilityAdded) {
    const sev = (status === 'red' || unassigned > 0) ? 'red' : 'yellow';
    const parts = [`${activePct}% dos shards ativos`, `${fmtNum(unassigned)} não alocado${plural(unassigned)}`];
    if (cbTrips > 0) parts.push(`${fmtNum(cbTrips)} disparo${plural(cbTrips)} de circuit breaker`);
    add(sev, 'fa-heart-pulse',
      'Disponibilidade comprometida',
      status.toUpperCase(),
      parts.join(', ') + '.',
      'Revisar saúde do cluster',
      `openDetail('cluster_health','Saúde por Índice','Status e shards por índice')`);
  }

  // ─── Resumo de severidade (topo) ───
  const counts = { red: 0, yellow: 0, blue: 0 };
  for (const i of insights) if (counts[i.sev] != null) counts[i.sev]++;
  const riskTotal = counts.red + counts.yellow;
  const badge = document.getElementById('insightsBadge');
  if (badge) {
    badge.textContent = riskTotal;
    badge.hidden = riskTotal === 0;
  }
  // A cor/ícone do resumo seguem a disponibilidade do cluster (status), não as
  // severidades de configuração: um cluster GREEN mostra o card verde (OK) mesmo
  // havendo riscos de configuração a tratar.
  const sumColor = healthColor(status);
  const sumIcon = status === 'red' ? 'fa-circle-exclamation'
    : (status === 'yellow' ? 'fa-triangle-exclamation' : 'fa-circle-check');
  const configRisks = riskTotal - (availabilityAdded ? 1 : 0);
  const v = configRisks !== 1 ? 'precisam' : 'precisa';
  const riskPhrase = configRisks > 0
    ? (status === 'green'
        ? ` Há, porém, <strong class="text-yellow">${configRisks} risco${plural(configRisks)} de configuração</strong> que ${v} de atenção.`
        : ` Soma-se a isso <strong class="text-yellow">${configRisks} risco${plural(configRisks)} de configuração</strong>.`)
    : ' Nenhum risco de configuração identificado nos dados atuais.';
  const availPhrase = status === 'green'
    ? 'Nenhum problema crítico de disponibilidade.'
    : 'Há problemas de disponibilidade que precisam de atenção.';
  const sumDesc = availPhrase + riskPhrase;

  const summary = `<div class="insights-summary">
    <div class="insights-summary-main">
      <div class="insights-summary-icon" style="background:var(--${sumColor}-bg);color:var(--${sumColor})"><i class="fas ${sumIcon}"></i></div>
      <div>
        <div class="insights-summary-title">Cluster operando em ${status.toUpperCase()}</div>
        <div class="insights-summary-desc">${sumDesc}</div>
      </div>
    </div>
    <div class="insights-summary-counts">
      <div class="severity-count"><div class="severity-num text-red">${counts.red}</div><div class="severity-label">Crítico</div></div>
      <div class="severity-count"><div class="severity-num text-yellow">${counts.yellow}</div><div class="severity-label">Atenção</div></div>
      <div class="severity-count"><div class="severity-num text-blue">${counts.blue}</div><div class="severity-label">Info</div></div>
    </div>
  </div>`;

  // ─── Grade "O que merece atenção" ───
  // Ordena por severidade: críticos (red) primeiro, depois atenção (yellow) e por
  // fim info (blue). Sort estável — mantém a ordem de inserção dentro de cada nível.
  const sevRank = { red: 0, yellow: 1, blue: 2 };
  const ordered = [...insights].sort((a, b) => (sevRank[a.sev] ?? 3) - (sevRank[b.sev] ?? 3));
  const gridBlock = insights.length
    ? `<div class="insights-block">
        <div class="grid-section"><span class="grid-section-label">O que merece atenção</span><span class="grid-section-line"></span></div>
        <div class="insights-grid">${ordered.map(i => i.html).join('')}</div>
      </div>`
    : `<div class="insights-block">
        <div class="empty-state"><i class="fas fa-circle-check"></i><p>Nenhum ponto de atenção nos dados atuais.</p></div>
      </div>`;

  el.innerHTML = summary + gridBlock;
}

// Visual "Uso de disco por nó" (nós ≥70%, desc) — usado no modal do insight de disco.
// Retorna '' quando nenhum nó atinge o limite de alerta.
function diskByNodeContent() {
  const nodes = (dashboardData && dashboardData.nodes_summary) || [];
  const diskNodes = nodes
    .filter(n => (n.disk_used_percent ?? 0) >= 70)
    .sort((a, b) => b.disk_used_percent - a.disk_used_percent);
  if (!diskNodes.length) return '';
  const rows = diskNodes.map(n => {
    const disk = n.disk_used_percent;
    const color = disk >= 85 ? 'red' : 'yellow';
    // Mesma célula nome + roles principais dos Sinais Vitais (Utilização por Nó).
    return `<div class="disk-row">
      <div class="disk-label">${nodeNameCell(n.name, n.roles, n.is_master)}</div>
      <div class="disk-track"><div class="disk-fill" style="width:${disk}%;background:var(--${color})"></div></div>
      <div class="disk-val text-${color}">${disk.toFixed(2)}%</div>
    </div>`;
  }).join('');
  return `<div class="disk-card">
    ${rows}
    <div class="disk-note"><i class="fas fa-circle-info"></i>Alerta de disco: <strong class="text-yellow">≥ 70%</strong> (atenção) · <strong class="text-red">≥ 85%</strong> (crítico). Watermarks padrão do ES: low 85% / high 90%.</div>
  </div>`;
}

function openDiskModal() {
  const content = diskByNodeContent();
  document.getElementById('diskModalBody').innerHTML = content ||
    `<div class="empty-state"><i class="fas fa-circle-check"></i><p>Nenhum nó acima de 70% de uso de disco.</p></div>`;
  document.getElementById('diskModal').style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closeDiskModal() {
  document.getElementById('diskModal').style.display = 'none';
  document.body.style.overflow = '';
}

function tableNodes(rows) {
  const loadTip = `<strong style="color:var(--text);display:block;margin-bottom:6px">Como as cores do Load são calculadas</strong>
<span style="color:var(--text-dim)">O load average do Linux <strong>não mede só CPU</strong>: ele conta processos rodando ou aguardando a CPU <strong>e também processos bloqueados em I/O</strong> (ex.: espera de disco). Um load alto pode indicar gargalo de disco/merge/flush no Elasticsearch mesmo com a CPU tranquila — por isso é um indicador de demanda geral do nó, não um substituto do CPU%.</span><br><br>
A cor reflete a proporção entre o load e o número de processadores disponíveis no nó (<code style="color:var(--blue);background:var(--surface-hover);padding:1px 4px;border-radius:3px">os.available_processors</code>):<br><br>
<code style="color:var(--text-muted);font-size:11px">utilização = load / os.available_processors</code><br><br>
<span style="color:var(--green)">●</span>&nbsp;<strong style="color:var(--green)">Verde</strong>&nbsp;&nbsp;&nbsp;— utilização &lt; 70%&nbsp;&nbsp;<span style="color:var(--text-dim)">(carga saudável)</span><br>
<span style="color:var(--yellow)">●</span>&nbsp;<strong style="color:var(--yellow)">Amarelo</strong>&nbsp;— utilização &gt;= 70% e &lt; 90%&nbsp;&nbsp;<span style="color:var(--text-dim)">(atenção)</span><br>
<span style="color:var(--red)">●</span>&nbsp;<strong style="color:var(--red)">Vermelho</strong>&nbsp;— utilização &gt;= 90%&nbsp;&nbsp;<span style="color:var(--text-dim)">(risco de sobrecarga)</span><br><br>
<span style="color:var(--text-dim)">Ex.: nó com 8 processadores e load 1m = 6.4 → 80% → amarelo.<br>Regra aplicada igualmente para 1m, 5m e 15m.</span><br><br>
<span style="color:var(--text-dim)"><strong style="color:var(--text)">Como diagnosticar a causa:</strong> cruze com a coluna <strong>CPU%</strong> desta mesma linha. Load e CPU% altos juntos → gargalo de CPU. Load alto com CPU% normal/baixo → provável espera por I/O (disco lento, merge/flush, GC ou swap), já que o load conta processos bloqueados em I/O, não só os que disputam CPU.</span>`;
  return `<table class="data-table data-table--freeze-first">
    <thead><tr>
      <th data-col="name" data-role-sort="true">Nó <span class="sort-icon">↕</span></th>
      <th>Shards P/R</th>
      <th data-col="cpu" data-type="num">CPU% <span class="sort-icon">↕</span></th>
      <th data-col="heap.percent" data-type="num">Heap% <span class="sort-icon">↕</span></th>
      <th data-col="mem_pressure" data-type="num">Mem. Pressure% <span class="sort-icon">↕</span></th>
      <th data-col="write_pressure_pct" data-type="num">Pressão Escrita% <span class="sort-icon">↕</span></th>
      <th data-col="gc_overhead" data-type="num">GC Overhead% <span class="sort-icon">↕</span></th>
      <th data-col="available_processors" data-type="num">Processadores <span class="sort-icon">↕</span></th>
      <th data-col="load_sum" data-type="num" data-sum-cols="load_1m,load_5m,load_15m"><div style="display:flex;align-items:center;gap:5px">Load 1m/5m/15m <span class="sort-icon">↕</span><div class="tooltip-wrap" onclick="event.stopPropagation()" style="font-weight:400;text-transform:none;letter-spacing:0"><div class="tooltip-btn">?</div><div class="tooltip-box" style="right:-8px;width:360px">${loadTip}</div></div></div></th>
      <th data-col="disk.used_percent" data-type="num">Disco <span class="sort-icon">↕</span></th>
      <th data-col="tp_queue" data-type="num" style="text-align:right">Fila TP <span class="sort-icon">↕</span></th>
      <th data-col="rejections" data-type="num" style="text-align:right">Rejeições Thread Pool <span class="sort-icon">↕</span></th>
      <th data-col="indexing_rejections" data-type="num" style="text-align:right">Rejeições Indexação <span class="sort-icon">↕</span></th>
    </tr></thead>
    <tbody>${rows.map(r => `<tr>
      <td>${nodeNameCell(r.name, r.roles, r.master === '*')}</td>
      <td><span style="font-weight:600;color:var(--blue)">${fmtNum(r.shards_primary)}</span><span style="color:var(--text-muted)"> / ${fmtNum(r.shards_replica)}</span></td>
      <td>${pctBar(r.cpu)}</td>
      <td>${pctBar(r['heap.percent'])}</td>
      <td>${pctBar(r.mem_pressure)}</td>
      <td>${pctBar(r.write_pressure_pct || 0)}</td>
      <td>${gcOverheadBar(r.gc_overhead)}</td>
      <td style="text-align:center;color:var(--text-muted);font-variant-numeric:tabular-nums">${r.available_processors || '-'}</td>
      <td>${loadBadge(r.load_1m, r.available_processors)} / ${loadBadge(r.load_5m, r.available_processors)} / ${loadBadge(r.load_15m, r.available_processors)}</td>
      <td><div style="display:flex;align-items:center;gap:10px">
        <div style="flex:1;min-width:90px">${pctBar(r['disk.used_percent'])}</div>
        <span style="flex-shrink:0;width:120px;color:var(--text-muted);font-variant-numeric:tabular-nums;white-space:nowrap">${r['disk.used'] || '-'} / ${r['disk.total'] || '-'}</span>
      </div></td>
      <td style="text-align:right;color:${(r.tp_queue||0)>0?'var(--yellow)':'var(--text-muted)'};font-weight:${(r.tp_queue||0)>0?'700':'400'}">${fmtNum(r.tp_queue??0)}</td>
      <td style="text-align:right;color:${(r.rejections||0)>0?'var(--red)':'var(--text-muted)'};font-weight:${(r.rejections||0)>0?'700':'400'}">${fmtNum(r.rejections??0)}</td>
      <td style="text-align:right;color:${(r.indexing_rejections||0)>0?'var(--red)':'var(--text-muted)'};font-weight:${(r.indexing_rejections||0)>0?'700':'400'}">${fmtNum(r.indexing_rejections??0)}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function tableCircuitBreakers(rows) {
  const trippedTip = `<strong style="color:var(--text);display:block;margin-bottom:6px">O que são os Disparos (tripped)</strong>
Cada vez que o breaker <strong>aborta uma requisição</strong> para proteger a JVM de estouro de memória, o contador <code style="color:var(--blue);background:var(--surface-hover);padding:1px 4px;border-radius:3px">tripped</code> é incrementado. Cada disparo é uma query ou indexação <strong>rejeitada</strong>.<br><br>
É um indicador <strong>tardio</strong>: quando ele sobe, o nó já esteve sob pressão de memória e derrubou trabalho.<br><br>
<span style="color:var(--text-muted)">●</span>&nbsp;<strong style="color:var(--text-muted)">0 disparos</strong>&nbsp;&nbsp;<span style="color:var(--text-dim)">(nenhuma requisição derrubada)</span><br>
<span style="color:var(--red)">●</span>&nbsp;<strong style="color:var(--red)">&gt; 0 disparos</strong>&nbsp;&nbsp;<span style="color:var(--text-dim)">(pressão de memória — requer investigação)</span>`;

  const usageTip = `<strong style="color:var(--text);display:block;margin-bottom:6px">Como o % do Limite é calculado</strong>
A cor reflete a proporção entre o uso estimado do breaker e o limite configurado para ele:<br><br>
<code style="color:var(--text-muted);font-size:11px">% do limite = uso_estimado / limite</code><br><br>
<span style="color:var(--green)">●</span>&nbsp;<strong style="color:var(--green)">Verde</strong>&nbsp;&nbsp;&nbsp;— &lt; 65%&nbsp;&nbsp;<span style="color:var(--text-dim)">(folga)</span><br>
<span style="color:var(--yellow)">●</span>&nbsp;<strong style="color:var(--yellow)">Amarelo</strong>&nbsp;— &gt;= 65% e &lt; 80%&nbsp;&nbsp;<span style="color:var(--text-dim)">(atenção)</span><br>
<span style="color:var(--red)">●</span>&nbsp;<strong style="color:var(--red)">Vermelho</strong>&nbsp;— &gt;= 80%&nbsp;&nbsp;<span style="color:var(--text-dim)">(próximo de disparar)</span><br><br>
<span style="color:var(--text-dim)">É o indicador <em>antecipado</em>: ao chegar a 100% o breaker começa a derrubar requisições (sobem os disparos).</span>`;

  return `<table class="data-table">
    <thead><tr>
      <th data-col="node">Nó <span class="sort-icon">↕</span></th>
      <th data-col="breaker">Breaker <span class="sort-icon">↕</span></th>
      <th data-col="tripped" data-type="num"><div style="display:flex;align-items:center;gap:5px">Disparos <span class="sort-icon">↕</span><div class="tooltip-wrap" onclick="event.stopPropagation()" style="font-weight:400;text-transform:none;letter-spacing:0"><div class="tooltip-btn">?</div><div class="tooltip-box" style="right:-8px;width:340px">${trippedTip}</div></div></div></th>
      <th data-col="estimated_size_in_bytes" data-type="num">Uso Estimado <span class="sort-icon">↕</span></th>
      <th data-col="limit_size_in_bytes" data-type="num">Limite <span class="sort-icon">↕</span></th>
      <th data-col="usage_pct" data-type="num"><div style="display:flex;align-items:center;gap:5px">% do Limite <span class="sort-icon">↕</span><div class="tooltip-wrap" onclick="event.stopPropagation()" style="font-weight:400;text-transform:none;letter-spacing:0"><div class="tooltip-btn">?</div><div class="tooltip-box" style="right:0;width:340px">${usageTip}</div></div></div></th>
    </tr></thead>
    <tbody>${rows.map(r => `<tr>
      <td>${nodeCellByName(r.node)}</td>
      <td><span class="badge badge-gray">${escHtml(r.breaker || '-')}</span></td>
      <td style="color:${(r.tripped||0)>0?'var(--red)':'var(--text-muted)'};font-weight:${(r.tripped||0)>0?'700':'400'}">${fmtNum(r.tripped)}</td>
      <td>${formatBytes(r.estimated_size_in_bytes)}</td>
      <td style="color:var(--text-muted)">${formatBytes(r.limit_size_in_bytes)}</td>
      <td>${pctBar(r.usage_pct)}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

const PRIORITY_COLOR = {
  IMMEDIATE: 'red', URGENT: 'red', HIGH: 'yellow',
  NORMAL: 'blue', LOW: 'gray', LANGUID: 'gray',
};

function tablePendingTasks(rows) {
  return `<table class="data-table">
    <thead><tr>
      <th data-col="insert_order" data-type="num">Ordem <span class="sort-icon">↕</span></th>
      <th data-col="priority">Prioridade <span class="sort-icon">↕</span></th>
      <th data-col="source">Origem <span class="sort-icon">↕</span></th>
      <th data-col="executing">Executando <span class="sort-icon">↕</span></th>
      <th data-col="time_in_queue_millis" data-type="num" style="text-align:right">Tempo na Fila <span class="sort-icon">↕</span></th>
    </tr></thead>
    <tbody>${rows.map(r => {
      const pc = PRIORITY_COLOR[r.priority] || 'gray';
      const wait = r.time_in_queue_millis || 0;
      return `<tr>
      <td style="font-weight:700;color:var(--text-muted)">${r.insert_order ?? '-'}</td>
      <td><span class="badge badge-${pc}">${escHtml(r.priority || '-')}</span></td>
      <td style="font-family:monospace;font-size:12px;max-width:520px;white-space:normal">${escHtml(r.source || '-')}</td>
      <td>${r.executing ? '<span class="badge badge-green">sim</span>' : '<span class="badge badge-gray">não</span>'}</td>
      <td style="text-align:right;color:${wait >= 200 ? 'var(--red)' : wait > 0 ? 'var(--yellow)' : 'var(--text-muted)'};font-weight:${wait > 0 ? '700' : '400'}">${fmtDuration(wait)}</td>
    </tr>`;
    }).join('')}</tbody>
  </table>`;
}

function tableGeneric(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  return `<table class="data-table">
    <thead><tr>${cols.map(c => `<th data-col="${c}">${c} <span class="sort-icon">↕</span></th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr>${cols.map(c => `<td>${r[c] ?? '-'}</td>`).join('')}</tr>`).join('')}</tbody>
  </table>`;
}

// ─── Index Shard Drill-down ───────────────────────────────
async function openIndexShards(indexName) {
  detailNavStack.push({
    title: document.getElementById('detailTitle').textContent,
    subtitle: document.getElementById('detailSubtitle').textContent,
    search: document.getElementById('detailSearch').value,
    metric: currentMetric,
    rows: currentRows.slice(),
    sort: { ...currentSort },
  });

  document.getElementById('detailTitle').textContent = indexName;
  document.getElementById('detailTitleTip').innerHTML = '';
  document.getElementById('detailSubtitle').textContent = 'Shards do índice';
  document.getElementById('detailSearch').value = '';
  document.getElementById('detailCount').textContent = '';
  setExportBtn(false);
  document.getElementById('detailBreadcrumb').style.display = 'flex';
  document.getElementById('breadcrumbCurrent').textContent = indexName;
  document.getElementById('detailBody').innerHTML =
    `<div class="loading-state"><i class="fas fa-circle-notch fa-spin"></i><span>Carregando shards...</span></div>`;

  try {
    const res = await fetch(`/api/index_shards/${encodeURIComponent(indexName)}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    currentRows = data;
    currentSort = { col: null, dir: 'asc' };
    currentMetric = 'index_shards';
    renderDetailTable('index_shards', data);
  } catch (e) {
    document.getElementById('detailBody').innerHTML =
      `<div class="error-state"><i class="fas fa-triangle-exclamation"></i><p>${escHtml(e.message)}</p></div>`;
  }
}

function goBackDetail() {
  if (!detailNavStack.length) return;
  const prev = detailNavStack.pop();
  document.getElementById('detailTitle').textContent = prev.title;
  document.getElementById('detailTitleTip').innerHTML =
    DETAIL_TITLE_TIPS[prev.metric] ? tooltip(DETAIL_TITLE_TIPS[prev.metric]) : '';
  document.getElementById('detailSubtitle').textContent = prev.subtitle;
  document.getElementById('detailSearch').value = prev.search || '';
  currentRows = prev.rows;
  currentSort = prev.sort;
  currentMetric = prev.metric;
  renderDetailTable(prev.metric, prev.rows);
  if (prev.search) filterTable();
  if (!detailNavStack.length) {
    document.getElementById('detailBreadcrumb').style.display = 'none';
  }
}

function shardTypeBadge(prirep) {
  if (prirep === 'p') return `<span class="badge badge-blue">Primário</span>`;
  if (prirep === 'r') return `<span class="badge badge-gray">Réplica</span>`;
  return `<span class="badge badge-gray">${escHtml(prirep || '-')}</span>`;
}

function shardStateBadge(state) {
  const color = { STARTED: 'green', RELOCATING: 'yellow', INITIALIZING: 'blue', UNASSIGNED: 'red' }[state] || 'gray';
  return `<span class="badge badge-${color}">${escHtml(state || '-')}</span>`;
}

function tableIndexShards(rows) {
  if (!rows.length) {
    return `<div class="empty-state"><i class="fas fa-circle-check"></i><p>Nenhum shard encontrado</p></div>`;
  }
  return `<table class="data-table">
    <thead><tr>
      <th data-col="shard" data-type="num">Shard <span class="sort-icon">↕</span></th>
      <th data-col="prirep">Tipo <span class="sort-icon">↕</span></th>
      <th data-col="state">Estado <span class="sort-icon">↕</span></th>
      <th data-col="node">Nó <span class="sort-icon">↕</span></th>
      <th data-col="ip">IP <span class="sort-icon">↕</span></th>
      <th data-col="docs" data-type="num">Docs <span class="sort-icon">↕</span></th>
      <th data-col="store" data-type="size">Tamanho <span class="sort-icon">↕</span></th>
      <th>Realocação / Motivo</th>
    </tr></thead>
    <tbody>${rows.map(r => {
      let infoCell = '<span style="color:var(--text-dim)">—</span>';
      if (r.state === 'RELOCATING' && r.relocation_target) {
        infoCell = `<span class="reloc-info reloc-out"><i class="fas fa-arrow-right"></i> ${escHtml(r.relocation_target)}</span>`;
      } else if (r.state === 'INITIALIZING' && r.relocation_source) {
        infoCell = `<span class="reloc-info reloc-in"><i class="fas fa-arrow-left"></i> ${escHtml(r.relocation_source)}</span>`;
      } else if (r.state === 'UNASSIGNED' && r['unassigned.reason']) {
        infoCell = `<span class="badge badge-red" style="font-size:10px">${escHtml(r['unassigned.reason'])}</span>`;
      }
      return `<tr>
        <td style="font-weight:700;color:var(--text-muted)">${r.shard ?? '-'}</td>
        <td>${shardTypeBadge(r.prirep)}</td>
        <td>${shardStateBadge(r.state)}</td>
        <td>${r.node ? nodeCellByName(r.node) : '<span style="color:var(--text-dim)">—</span>'}</td>
        <td style="font-size:12px;color:var(--text-muted)">${r.ip || '—'}</td>
        <td>${fmtNum(r.docs)}</td>
        <td>${r.store || '—'}</td>
        <td>${infoCell}</td>
      </tr>`;
    }).join('')}</tbody>
  </table>`;
}

// ─── Table Sorting ────────────────────────────────────────
function setupSort(metric, allRows) {
  document.querySelectorAll('#detailBody th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      const type = th.dataset.type || 'str';
      const isRoleSort = th.dataset.roleSort === 'true';
      const sumCols = th.dataset.sumCols ? th.dataset.sumCols.split(',') : null;

      document.querySelectorAll('#detailBody th').forEach(h => h.classList.remove('sort-asc', 'sort-desc', 'sort-role'));

      let sorted;
      if (isRoleSort) {
        // Coluna "Nó": todo clique volta para a ordem padrão por role (MASTER > OUTROS >
        // HOT/DATA_CONTENT > WARM > COLD > FROZEN, alfabético dentro do grupo) — não
        // participa do toggle asc/desc genérico das demais colunas.
        currentSort = { col, dir: 'role' };
        th.classList.add('sort-role');
        const icon = th.querySelector('.sort-icon');
        if (icon) icon.textContent = '⟲';
        sorted = sortNodesByRole(allRows);
      } else {
        if (currentSort.col === col) {
          currentSort.dir = currentSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          currentSort.col = col;
          currentSort.dir = 'asc';
        }
        th.classList.add(`sort-${currentSort.dir}`);
        const icon = th.querySelector('.sort-icon');
        if (icon) icon.textContent = currentSort.dir === 'asc' ? '↑' : '↓';

        sorted = [...allRows].sort((a, b) => {
          let va, vb;
          if (sumCols) {
            va = sumCols.reduce((s, k) => s + (parseFloat(a[k]) || 0), 0);
            vb = sumCols.reduce((s, k) => s + (parseFloat(b[k]) || 0), 0);
          } else {
            va = a[col] ?? ''; vb = b[col] ?? '';
            if (type === 'num') { va = parseFloat(va) || 0; vb = parseFloat(vb) || 0; }
            else if (type === 'size') { va = parseSizeStr(va); vb = parseSizeStr(vb); }
            else { va = String(va).toLowerCase(); vb = String(vb).toLowerCase(); }
          }
          const cmp = va < vb ? -1 : va > vb ? 1 : 0;
          return currentSort.dir === 'asc' ? cmp : -cmp;
        });
      }

      const tbody = document.querySelector('#detailBody tbody');
      if (tbody) {
        tbody.innerHTML = '';
        const tmpDiv = document.createElement('div');
        tmpDiv.innerHTML = renderDetailTableBody(metric, sorted);
        const newTbody = tmpDiv.querySelector('tbody');
        if (newTbody) tbody.innerHTML = newTbody.innerHTML;
      }

      filterTable();
    });
  });
}

// ─── Tasks Section ────────────────────────────────────────
async function loadTasks() {
  const body = document.getElementById('tasksBody');
  const icon = document.getElementById('tasksRefreshIcon');
  if (icon) icon.classList.add('spin');

  body.innerHTML = `<div class="loading-state tasks-loading">
    <i class="fas fa-circle-notch fa-spin"></i><span>Carregando tarefas...</span>
  </div>`;

  try {
    const res = await fetch('/api/tasks');
    if (res.status === 401) return;
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    renderTasksTable(data);
    const countEl = document.getElementById('tasksCount');
    if (countEl) {
      // Conta operações (tarefas-pai), não tarefas brutas: 5 reindexes com slices=5
      // são 5 operações, não 30.
      const ops = taskRoots(data).length;
      if (ops) {
        countEl.textContent = `${ops} tarefa${ops !== 1 ? 's' : ''}`;
        countEl.style.display = '';
      } else {
        countEl.textContent = '';
        countEl.style.display = 'none';
      }
    }
    // tasksList acabou de ser atualizado — reflete o card "Tarefa longa" e o badge.
    if (dashboardData) renderInsights();
  } catch (e) {
    body.innerHTML = `<div class="error-state tasks-loading">
      <i class="fas fa-triangle-exclamation"></i><p>${escHtml(e.message)}</p>
    </div>`;
  } finally {
    if (icon) icon.classList.remove('spin');
  }
}

// Agrupa a lista plana por parent_task_id: cada tarefa cujo pai está presente na
// lista é anexada em childrenOf[pai]; as demais (raiz ou órfã — pai filtrado pelo
// corte de 5s) viram roots. Um nível basta (slices de reindex não têm netos).
// Devolve os objetos ORIGINAIS (não cópias), para `tasksList.indexOf` seguir válido.
function groupTasks(tasks) {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const childrenOf = new Map();
  const roots = [];
  for (const t of tasks) {
    const pid = t.parent_task_id;
    if (pid && pid !== '-' && byId.has(pid)) {
      if (!childrenOf.has(pid)) childrenOf.set(pid, []);
      childrenOf.get(pid).push(t);
    } else {
      roots.push(t);
    }
  }
  return { roots, childrenOf };
}

// Nº de operações (tarefas raiz) — usado nas contagens (badge da seção e insight).
function taskRoots(tasks) {
  return groupTasks(tasks).roots;
}

function renderTasksTable(tasks) {
  tasksList = tasks;
  const body = document.getElementById('tasksBody');

  if (!tasks.length) {
    body.innerHTML = `<div class="empty-state tasks-empty">
      <i class="fas fa-circle-check"></i>
      <p>Nenhuma tarefa com mais de 5 segundos em execução</p>
    </div>`;
    return;
  }

  const actions = [...new Set(tasks.map(t => t.action))].sort();

  // Remove seleções de ações que não existem mais
  for (const a of selectedActions) {
    if (!actions.includes(a)) selectedActions.delete(a);
  }

  const visible = selectedActions.size
    ? tasks.filter(t => selectedActions.has(t.action))
    : tasks;

  // Filter pills (rendered inside the table wrapper)
  const actionCounts = tasks.reduce((acc, t) => { acc[t.action] = (acc[t.action] || 0) + 1; return acc; }, {});
  const pills = actions.map(a => {
    const sel = selectedActions.has(a);
    return `<button class="task-action-pill${sel ? ' selected' : ''}" onclick="toggleActionFilter('${escHtml(a)}')">${escHtml(a)} (total: ${actionCounts[a]})</button>`;
  }).join('');

  const clearBtn = selectedActions.size
    ? `<button class="tasks-filter-clear" onclick="clearActionFilter()"><i class="fas fa-xmark"></i> Limpar</button>`
    : '';

  const filterHtml = `<div class="tasks-filter">
    <span class="tasks-filter-label">Ação</span>
    ${pills}
    ${clearBtn}
  </div>`;

  // Agrupa filhas (slices) sob a tarefa-pai; renderiza recolhido por padrão.
  const { roots, childrenOf } = groupTasks(visible);

  // Monta o <tr> de uma tarefa (isChild = linha-filha recuada). O pai com filhas
  // ganha o chevron de expandir + badge "N sub-tarefas"; o chevron não abre o JSON.
  const taskRowHtml = (t, isChild) => {
    const idx = tasksList.indexOf(t);
    const kids = childrenOf.get(t.id) || [];
    const expanded = expandedTasks.has(t.id);
    const cancelBtn = t.cancellable
      ? `<button class="btn btn-danger btn-sm" onclick="event.stopPropagation();cancelTask('${escHtml(t.id)}', this)">
           <i class="fas fa-ban"></i> Cancelar
         </button>`
      : `<button class="btn btn-ghost btn-sm" style="cursor:not-allowed;opacity:0.45" title="Essa tarefa não pode ser cancelada" onclick="event.stopPropagation()">
           <i class="fas fa-ban"></i> Cancelar
         </button>`;
    const toggle = kids.length
      ? `<button class="task-group-toggle${expanded ? ' open' : ''}" onclick="event.stopPropagation();toggleTaskGroup('${escHtml(t.id)}')" title="${expanded ? 'Recolher' : 'Expandir'} sub-tarefas"><i class="fas fa-chevron-right"></i></button>`
      : '<span class="task-group-spacer"></span>';
    const subBadge = kids.length
      ? `<span class="task-subcount">${fmtNum(kids.length)} sub-tarefa${kids.length !== 1 ? 's' : ''}</span>`
      : '';
    return `<tr class="task-row${isChild ? ' task-child-row' : ''}" onclick="showTaskJson(${idx})">
      <td><div class="task-node-cell">${toggle}${nodeNameCell(t.node, t.roles || [], t.node === electedMasterName())}</div></td>
      <td><code class="task-action">${escHtml(t.action)}</code>${subBadge}</td>
      <td class="task-desc">${escHtml(t.description || '—')}</td>
      <td class="task-elapsed" style="white-space:nowrap;font-weight:700;color:var(--yellow)" title="Início: ${escHtml(fmtMillisDate(t.start_time_in_millis))}">${fmtNanosToSecs(t.running_time_in_nanos)}</td>
      <td style="text-align:right">${cancelBtn}</td>
    </tr>`;
  };

  const rows = roots.map(r => {
    const kids = childrenOf.get(r.id) || [];
    const parentHtml = taskRowHtml(r, false);
    return (kids.length && expandedTasks.has(r.id))
      ? parentHtml + kids.map(k => taskRowHtml(k, true)).join('')
      : parentHtml;
  }).join('');

  const emptyFilter = visible.length === 0
    ? `<tr><td colspan="5" style="text-align:center;padding:28px;color:var(--text-dim)">Nenhuma tarefa para os filtros selecionados</td></tr>`
    : '';

  body.innerHTML = `<div class="tasks-table-wrap">
    ${filterHtml}
    <table class="data-table tasks-table">
      <thead><tr>
        <th>Nó</th>
        <th>Ação</th>
        <th>Descrição</th>
        <th>Tempo</th>
        <th></th>
      </tr></thead>
      <tbody>${rows || emptyFilter}</tbody>
    </table>
  </div>`;
}

function toggleActionFilter(action) {
  if (selectedActions.has(action)) selectedActions.delete(action);
  else selectedActions.add(action);
  renderTasksTable(tasksList);
}

function clearActionFilter() {
  selectedActions.clear();
  renderTasksTable(tasksList);
}

function toggleTaskGroup(parentId) {
  if (expandedTasks.has(parentId)) expandedTasks.delete(parentId);
  else expandedTasks.add(parentId);
  renderTasksTable(tasksList);
}

let currentTaskId = '';

function showTaskJson(idx) {
  const task = tasksList[idx];
  if (!task) return;
  currentTaskId = task.id;
  document.getElementById('taskJsonSubtitle').textContent = task.id;
  document.getElementById('taskJsonBody').textContent = JSON.stringify(task, null, 2);
  document.getElementById('taskJsonModal').style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

async function copyTaskId() {
  try {
    await navigator.clipboard.writeText(currentTaskId);
    const icon = document.querySelector('#taskJsonCopyBtn i');
    icon.className = 'fas fa-check';
    setTimeout(() => { icon.className = 'fas fa-copy'; }, 1500);
  } catch (_) {}
}

function closeTaskJsonModal() {
  document.getElementById('taskJsonModal').style.display = 'none';
  document.body.style.overflow = '';
}

async function cancelTask(taskId, btn) {
  if (!confirm(`Cancelar a tarefa:\n${taskId}\n\nEsta ação envia um sinal de cancelamento ao Elasticsearch. Confirma?`)) return;

  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i>';

  try {
    const res = await fetch('/api/tasks/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: taskId }),
    });
    const data = await res.json();
    if (data.success) {
      const row = btn.closest('tr');
      if (row) row.style.opacity = '0.4';
      btn.innerHTML = '<i class="fas fa-check"></i> Cancelada';
      setTimeout(loadTasks, 2500);
    } else {
      alert('Erro ao cancelar: ' + (data.error || 'desconhecido'));
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-ban"></i> Cancelar';
    }
  } catch (e) {
    alert('Erro de rede: ' + e.message);
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-ban"></i> Cancelar';
  }
}

// ─── Modal de Detalhe de Nó (Topologia) ──────────────────
// Carregado sob demanda ao clicar na caixinha — sem impacto no dashboard.

function openNodeModal(name) {
  document.getElementById('nodeModalTitle').textContent = name;
  document.getElementById('nodeModalSubtitle').textContent = '';
  document.getElementById('nodeModalBody').innerHTML =
    `<div class="loading-state"><i class="fas fa-circle-notch fa-spin"></i><span>Carregando...</span></div>`;
  document.getElementById('nodeModal').style.display = 'flex';
  document.body.style.overflow = 'hidden';
  loadNodeDetail(name);
}

function closeNodeModal() {
  document.getElementById('nodeModal').style.display = 'none';
  document.body.style.overflow = '';
}

async function loadNodeDetail(name) {
  const body = document.getElementById('nodeModalBody');
  if (!body) return;
  try {
    const res  = await fetch('/api/node/' + encodeURIComponent(name));
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    renderNodeDetail(data);
  } catch (e) {
    body.innerHTML = `<div class="error-state"><i class="fas fa-triangle-exclamation"></i><p>${escHtml(e.message)}</p></div>`;
  }
}

function renderNodeDetail(d) {
  const body = document.getElementById('nodeModalBody');
  if (!body) return;

  const id  = d.identity  || {};
  const os  = d.os        || {};
  const cpu = d.cpu       || {};
  const mem = d.memory    || {};
  const jvm = d.jvm       || {};
  const dsk = d.disk      || {};
  const prc = d.process   || {};

  // Topo mostra só o nome da instância (IP e SO ficam nas seções abaixo)
  document.getElementById('nodeModalSubtitle').textContent = '';

  // Helper: barra de % colorida (reutiliza .tier-disk-track/.tier-disk-fill)
  function pctRow(label, pct, extra = '', opts = {}) {
    const color = pct >= 85 ? 'red' : pct >= 70 ? 'yellow' : 'green';
    // fixedBar: barra de largura fixa (para alinhar barras entre linhas e trazer
    // o texto logo em seguida, em vez de a barra esticar até o fim da linha)
    return `<div class="nd-row${opts.fixedBar ? ' nd-row--fixbar' : ''}">
      <span class="nd-label">${label}</span>
      <div class="nd-bar-wrap">
        <div class="tier-disk-track nd-bar"><div class="tier-disk-fill" style="width:${pct}%;background:var(--${color})"></div></div>
        <span class="nd-pct text-${color}">${pct}%</span>
        ${extra ? `<span class="nd-extra">${extra}</span>` : ''}
      </div>
    </div>`;
  }

  // Helper: linha simples label / valor
  function valRow(label, value, dim = false) {
    if (value === null || value === undefined || value === '') return '';
    return `<div class="nd-row">
      <span class="nd-label">${label}</span>
      <span class="nd-value${dim ? ' nd-dim' : ''}">${value}</span>
    </div>`;
  }

  // Helper: nota de alerta (linha sem coluna de rótulo), cor amarela/vermelha
  function warnRow(text, color = 'yellow') {
    return `<div class="nd-row"><span class="nd-value text-${color}" style="font-size:12px">
      <i class="fas fa-triangle-exclamation" style="margin-right:6px"></i>${text}</span></div>`;
  }

  function sec(icon, title, rows) {
    return `<div class="nd-section">
      <div class="nd-section-title"><i class="fas ${icon}"></i>${title}</div>
      ${rows.filter(Boolean).join('')}
    </div>`;
  }

  // Disco: uso geral + mounts. O uso é calculado sobre "available" (espaço
  // disponível a não-root), que é a base dos watermarks do ES (85/90/95%).
  // Filesystems de rede (NFS/CIFS/…) não são recomendados para dados do ES.
  function isNetworkFs(t) { return /nfs|cifs|smb|glusterfs|ceph|lustre|9p|afs/i.test(t || ''); }
  function diskUsage(total, available, free) {
    if (!total) return { used: null, avail: null, pct: 0 };
    const avail = available != null ? available : free;
    const used = avail != null ? total - avail : null;
    return { used, avail, pct: used != null ? Math.round((used / total) * 100) : 0 };
  }

  // Rótulo do tipo de filesystem (amarelo + ⚠ quando for de rede)
  function fsTypeTag(t) {
    if (!t) return '';
    const net = isNetworkFs(t);
    return `<span class="${net ? 'text-yellow' : 'nd-dim'}"${net ? ' title="Filesystem de rede — não recomendado para dados do Elasticsearch"' : ''}>(${escHtml(t)}${net ? ' ⚠' : ''})</span>`;
  }

  const dg = diskUsage(dsk.total, dsk.available, dsk.free);
  const mounts = Array.isArray(dsk.mounts) ? dsk.mounts : [];
  // Detalha os mounts quando há mais de um ou quando algum é filesystem de rede
  const showMounts = mounts.length > 1 || mounts.some(m => isNetworkFs(m.type));
  // Disco único: o tipo do fs vai no próprio "Uso geral" (sem sub-lista)
  const singleType = (!showMounts && mounts.length === 1) ? mounts[0].type : '';
  const dskRows = [
    dsk.total ? pctRow('Uso geral', dg.pct,
      `${singleType ? fsTypeTag(singleType) + ' · ' : ''}${formatBytes(dg.used ?? 0)} de ${formatBytes(dsk.total)} · livre ${formatBytes(dg.avail ?? 0)}`) : '',
  ];
  if (showMounts) {
    for (const m of mounts) {
      if (!m.total) continue;
      const mu = diskUsage(m.total, m.available, m.free);
      const typeTag = m.type ? fsTypeTag(m.type) + ' · ' : '';
      const label = `<i class="fas fa-folder nd-dim" style="margin-right:6px"></i>${escHtml(m.path || m.mount || '—')}`;
      dskRows.push(pctRow(label, mu.pct,
        `${typeTag}${formatBytes(mu.used ?? 0)} de ${formatBytes(m.total)}`));
    }
  }

  // Load average com qtd de CPUs como referência
  const procs = os.available_processors || 1;
  function loadColor(v) { return v / procs >= 1.5 ? 'red' : v / procs >= 0.8 ? 'yellow' : 'green'; }
  function loadVal(v) {
    if (!v && v !== 0) return '';
    const c = loadColor(v);
    return `<span class="text-${c}" style="font-weight:700">${v.toFixed(2)}</span>`;
  }
  const loadLine = [cpu.load_1m, cpu.load_5m, cpu.load_15m].some(v => v != null)
    ? `<div class="nd-row"><span class="nd-label">Load avg (1m/5m/15m)</span><span class="nd-value">${
        [cpu.load_1m, cpu.load_5m, cpu.load_15m].map(v => v != null ? loadVal(v) : '—').join(' / ')
      } <span class="nd-dim">· ${procs} vCPU${procs !== 1 ? 's' : ''}</span></span></div>`
    : '';

  const heapPct = jvm.heap_used_percent || 0;

  // Sanidade do heap (regras de ouro do ES): não passar de ~50% da RAM (deixar
  // memória para o filesystem cache) nem de ~32 GB (senão perde os compressed
  // oops). Ambas derivadas de heap_max + RAM total, sem chamada extra.
  const GB = 1024 ** 3;
  const heapMax = jvm.heap_max || 0;
  const heapPctRam = mem.total ? Math.round((heapMax / mem.total) * 100) : null;
  const heapOverHalf = heapPctRam != null && heapPctRam > 50;
  const heapOver32 = heapMax > 32 * GB;
  const heapRatioRow = heapPctRam != null
    ? valRow('Heap / RAM física', `<span class="text-${heapOverHalf ? 'yellow' : 'green'}">${heapPctRam}%</span>`)
    : '';
  // Aviso de heap > 50% da RAM foi movido para o Diagnóstico (card de insight);
  // aqui fica só a linha informativa "Heap / RAM física" (colorida) e o aviso de
  // compressed oops, que é específico do nó.
  const heapWarns = [
    heapOver32 ? warnRow('Heap acima de ~32 GB — sem compressed oops (ponteiros comprimidos); um heap menor pode render mais') : '',
  ];

  // Swap: o ES recomenda swap desabilitado. Verde quando desabilitado/sem uso,
  // amarelo quando há swap em uso (risco de pausas e latência).
  const swapTotal = mem.swap_total || 0;
  const swapUsed  = mem.swap_used  || 0;
  const swapRow = swapTotal === 0
    ? valRow('Swap', `<span class="text-green">desabilitado</span>`)
    : swapUsed === 0
      ? valRow('Swap', `<span class="text-green">0 em uso</span> <span class="nd-dim">· ${formatBytes(swapTotal)} disponível</span>`)
      : valRow('Swap', `<span class="text-yellow">${formatBytes(swapUsed)} em uso</span> <span class="nd-dim">de ${formatBytes(swapTotal)}</span>`);
  const swapWarn = (swapTotal > 0 && swapUsed > 0)
    ? warnRow('Swap em uso — o ES recomenda desabilitar o swap para evitar pausas de GC e latência')
    : '';

  // Memory lock (mlockall): heap travado na RAM, protegido de swap.
  const mlock = mem.mlockall;
  const mlockRow = mlock == null ? '' : (mlock
    ? valRow('Memory lock', `<span class="text-green">ativo</span> <span class="nd-dim">· heap travado na RAM</span>`)
    : valRow('Memory lock', `<span class="text-yellow">inativo</span> <span class="nd-dim">· heap pode ser paginado para swap</span>`));

  const uptimeStr = jvm.uptime_millis ? fmtDuration(jvm.uptime_millis) : '—';

  const fdsStr = prc.open_fds != null && prc.max_fds
    ? `${fmtNum(prc.open_fds)} / ${fmtNum(prc.max_fds)}`
    : prc.open_fds != null ? fmtNum(prc.open_fds) : null;

  body.innerHTML = `<div class="nd-body">
    ${sec('fa-server', 'Identificação', [
      valRow('Host', id.host),
      valRow('Versão ES', id.version),
      valRow('Build flavor', id.build_flavor, true),
      valRow('Build type', id.build_type, true),
      valRow('Build hash', id.build_hash, true),
      valRow('Roles', (id.roles || []).join(', '), true),
    ])}
    ${sec('fa-desktop', 'Sistema Operacional', [
      valRow('SO', os.pretty_name || os.name),
      valRow('Versão do kernel', os.version, true),
      valRow('Arquitetura', os.arch, true),
    ])}
    ${sec('fa-microchip', 'CPU', [
      cpu.percent != null ? pctRow('CPU (SO)', cpu.percent) : '',
      cpu.proc_percent != null ? pctRow('CPU (processo ES)', cpu.proc_percent) : '',
      loadLine,
    ])}
    ${sec('fa-memory', 'RAM/JVM', [
      mem.total ? pctRow('RAM usada', mem.used_percent,
        `${formatBytes(mem.used)} de ${formatBytes(mem.total)} · livre ${formatBytes(mem.free ?? (mem.total - mem.used))}`, { fixedBar: true }) : '',
      jvm.heap_max ? pctRow('Heap usada', heapPct,
        `${formatBytes(jvm.heap_used)} de ${formatBytes(jvm.heap_max)} · livre ${formatBytes(jvm.heap_max - jvm.heap_used)}`, { fixedBar: true }) : '',
      heapRatioRow,
      ...heapWarns,
      swapRow,
      swapWarn,
      mlockRow,
      valRow('Uptime', uptimeStr),
      valRow('Versão JVM', jvm.version),
      valRow('VM', [jvm.vm_name, jvm.vm_vendor].filter(Boolean).join(' · '), true),
    ])}
    ${sec('fa-hard-drive', 'Disco', dskRows)}
    ${(fdsStr || jvm.threads) ? sec('fa-file', 'Processo', [
      fdsStr ? valRow('File descriptors (abertos / máx.)', fdsStr) : '',
      jvm.threads ? valRow('Threads', fmtNum(jvm.threads)) : '',
    ]) : ''}
  </div>`;
}

// ─── Keyboard Shortcuts ───────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    const jm = document.getElementById('jsonModal');
    if (jm && jm.style.display === 'flex') { closeJsonModal(); return; }
    const dm = document.getElementById('diskModal');
    if (dm && dm.style.display === 'flex') { closeDiskModal(); return; }
    const nm = document.getElementById('nodeModal');
    if (nm && nm.style.display === 'flex') { closeNodeModal(); return; }
    closeDetailModal(); closeTaskJsonModal(); closeAliasModal(); closeConfirmModal();
  }
  if (e.key === 'r' && !e.ctrlKey && !e.metaKey && document.activeElement.tagName !== 'INPUT' &&
      (currentPage === 'overview' || currentPage === 'capacity' || currentPage === 'kibana')) {
    refreshCurrentPage();
  }
});

// Tooltips dos cards abrem para a esquerda por padrão (right:0). Em cards da
// coluna mais à esquerda isso transborda e fica sob a sidebar — ao passar o
// mouse, mede a posição e inverte para abrir à direita quando falta espaço.
document.addEventListener('mouseover', e => {
  const wrap = e.target.closest && e.target.closest('.tooltip-wrap');
  if (!wrap) return;
  const box = wrap.querySelector('.tooltip-box');
  if (!box) return;
  box.classList.remove('flip-left');
  const sidebar = document.querySelector('.sidebar');
  const minLeft = sidebar ? sidebar.getBoundingClientRect().right : 0;
  if (box.getBoundingClientRect().left < minLeft + 4) box.classList.add('flip-left');
});

// ─── Init ─────────────────────────────────────────────────
(async () => {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();

    if (data.connected) {
      document.getElementById('connectModal').style.display = 'none';
      document.getElementById('app').style.display = 'flex';
      setClusterInfo(data.info);
      loadDashboard();
      showPage(pageFromHash());
    } else {
      loadConnections();
    }
  } catch (e) {
    loadConnections();
  }
})();
