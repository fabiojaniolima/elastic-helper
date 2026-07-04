'use strict';

// ─── State ───────────────────────────────────────────────
let dashboardData = null;

// ─── Utilities ───────────────────────────────────────────
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + units[i];
}

function fmtNum(n) {
  if (n == null || n === '') return '-';
  return Number(n).toLocaleString('pt-BR');
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

  try {
    // Refresh global: coleta completa, que também realimenta Inventário e Diagnóstico.
    const data = await fetchDashboard();
    renderCards(data);

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

// Refresh da topbar e do atalho R: cada página recarrega a sua própria fonte.
function refreshCurrentPage() {
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

// Página "Sinais Vitais" (id interno: overview) — só o que responde "está
// funcionando agora?". Nós, volume/inventário e configuração de índices ficam na
// página "Inventário" (renderCapacity).
function renderCards(d) {
  const grid = document.getElementById('metricsGrid');

  grid.innerHTML = [
    section('Saúde do Cluster', 'health'),
    `<div id="section-cards-health" class="section-health-cards">${sectionCardsHealth(d)}</div>`,
  ].join('');
}

// Seção → função que a renderiza. Os ids são os mesmos que o backend conhece
// em DASHBOARD_SECTIONS (es_service.py) e que vão em ?sections=.
const SECTION_RENDERERS = {
  health: sectionCardsHealth,
};

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

// ─── Keyboard Shortcuts ───────────────────────────────────
document.addEventListener('keydown', e => {
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
