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

// Custo por evento do Logstash: valores tipicamente entre frações de ms e
// alguns ms, onde fmtDuration (que arredonda para 0s) não serve.
function fmtMs(ms) {
  if (ms == null) return '-';
  const n = Number(ms);
  if (!isFinite(n)) return '-';
  if (n >= 100) return Math.round(n).toLocaleString('pt-BR') + ' ms';
  // Abaixo da resolução exibida, dizer "0 ms" seria falso: o plugin gastou tempo.
  if (n > 0 && n < 0.001) return '< 0,001 ms';
  // Custos submilissegundo precisam de 3 casas para não virar 0; zeros à
  // direita são cortados para 0,5 ms não sair como 0,500 ms.
  const digits = n >= 1 ? 1 : 3;
  return n.toFixed(digits).replace(/0+$/, '').replace(/[.,]$/, '').replace('.', ',') + ' ms';
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
      // Config das integrações é por conexão: recarrega ao trocar de cluster.
      resetIntegrations();
      loadIntegrations();
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
  kibana:   { title: 'Kibana', subtitle: 'Instâncias, Task Manager, frota do Fleet e APM Server' },
  logstash: { title: 'Logstash', subtitle: 'Instâncias, vazão de eventos, pipelines, filas e DLQ' },
  config:   { title: 'Configuração', subtitle: 'Integrações e preferências desta conexão' },
  help:     { title: 'Ajuda', subtitle: 'O que cada métrica significa e como agir' },
};

const PAGES = ['overview', 'capacity', 'insights', 'kibana', 'logstash', 'config', 'help'];
// Páginas com dados ao vivo: ganham timestamp e botão de refresh na topbar.
const REFRESHABLE_PAGES = new Set(['overview', 'capacity', 'kibana', 'logstash']);

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
  // As integrações e a Configuração têm fonte própria (/api/<integração>/*).
  if (page === 'kibana') loadKibana();
  if (page === 'logstash') loadLogstash();
  if (page === 'config') renderConfig();
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

// ─── Ajuda: busca na documentação ─────────────────────────
function filterHelp(query) {
  const q = (query || '').trim().toLowerCase();
  let anyVisible = false;
  document.querySelectorAll('#helpGroups .help-section').forEach(section => {
    let sectionVisible = false;
    section.querySelectorAll('.help-article').forEach(article => {
      const match = !q || (article.dataset.text || '').includes(q);
      article.hidden = !match;
      if (match) sectionVisible = true;
    });
    section.hidden = !sectionVisible;
    if (sectionVisible) anyVisible = true;
  });
  document.getElementById('helpNoResults').hidden = anyVisible;
}

// Vai para a Ajuda e rola até o tópico do card clicado (ver tooltip() / índice).
function goToTasks() {
  showPage('overview');
  requestAnimationFrame(() => {
    const el = document.getElementById('tasksBody');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function goToHelp(topic) {
  showPage('help');
  const search = document.getElementById('helpSearch');
  if (search) { search.value = ''; filterHelp(''); }
  const item = document.getElementById(topic);
  if (!item) return;
  setActiveTocLink(topic);
  // espera o layout aplicar (a página acabou de ficar visível) antes de rolar
  requestAnimationFrame(() => {
    item.scrollIntoView({ behavior: 'smooth', block: 'start' });
    item.classList.add('help-flash');
    setTimeout(() => item.classList.remove('help-flash'), 1600);
  });
}

function setActiveTocLink(topic) {
  document.querySelectorAll('.help-toc-link').forEach(l => {
    l.classList.toggle('active', l.dataset.target === topic);
  });
}

// ─── Conteúdo da Ajuda (gerado) ───────────────────────────
// Um grupo por seção: os cards dos Sinais Vitais e do Inventário (resumo + explicação de cada dado
// exibido; os `id` casam com o `topic` dos tooltips, permitindo o "?" do card
// abrir direto a explicação) e a "Página de Diagnóstico" (o que é a página e quais
// cards existem / quando cada um aparece).
const HELP_CONTENT = [
  {
    label: 'Saúde e Infraestrutura', icon: 'fa-heart-pulse',
    topics: [
      {
        id: 'help-cluster-health', q: 'Saúde do Cluster',
        summary: 'Card-resumo da <strong>disponibilidade geral</strong> do cluster — o primeiro lugar a olhar. Reflete se todos os shards (primários e réplicas) estão alocados e operacionais. O rodapé traz a <strong>versão do cluster</strong> e a <strong>licença</strong>; o detalhe de primários e a <strong>taxa de alocação (% Shards Ativos)</strong> ficam no card Total de Shards. Clique no card para ver a saúde índice a índice.',
        data: [
          { label: 'Status (GREEN / YELLOW / RED)', desc: '<strong>GREEN</strong>: todos os shards primários e réplicas alocados — saudável. <strong>YELLOW</strong>: primários ok, mas há réplicas não alocadas; perder um nó pode deixar dados temporariamente indisponíveis. <strong>RED</strong>: ao menos um shard primário não alocado — parte dos dados inacessível ou em risco de perda permanente; exige ação imediata.' },
          { label: 'Versão do Cluster (rodapé)', desc: 'Versão do Elasticsearch do cluster conectado. Útil para conferir compatibilidade de recursos e planejar upgrades — é aqui (e não na sidebar) que a versão aparece.' },
          { label: 'Licença (rodapé)', desc: 'Tipo da licença do cluster (BASIC, GOLD, PLATINUM, ENTERPRISE…) e seu status. Fica <span style="color:var(--yellow)">amarela</span> quando expira em até 30 dias e <span style="color:var(--red)">vermelha</span> se expira em 7 dias ou já expirou. A licença basic é perpétua (sem expiração). O tipo também explica a ausência de recursos pagos (ex.: certas integrações de segurança ou ML). Omitida quando a consulta de licença está indisponível.' },
        ],
      },
      {
        id: 'help-total-nodes', q: 'Total de Nós',
        summary: 'Quantidade de nós que compõem o cluster agora, detalhada por função. Monitorar a <strong>estabilidade desse número</strong> é essencial: uma queda inesperada indica que um nó saiu (falha, rede ou manutenção), o que dispara realocação de shards e pode degradar o desempenho. Clique para ver CPU, Heap e Disco por nó.',
        data: [
          { label: 'Total de nós', desc: 'Soma de todos os nós conectados ao cluster (data, master, ingest, ML (Machine Learning), etc.).' },
          { label: 'Data Nodes', desc: 'Nós que armazenam dados (shards). Determinam a capacidade de armazenamento e a distribuição de carga. Poucos data nodes para muitos shards concentram carga e risco.' },
          { label: 'Master', desc: 'Nós master dedicados (exibido apenas quando existem). Cuidam do cluster state; em produção, o recomendado são 3 masters dedicados para garantir quórum e evitar split-brain.' },
          { label: 'HOT / WARM / COLD / FROZEN', desc: 'Quantos data nodes pertencem a cada tier de dados. Cada tier só é exibido quando há nós nele, e um nó só é contado quando tem <strong>exatamente um</strong> desses roles de tier — nós que acumulam mais de um tier (ex.: <code>data_hot</code> + <code>data_warm</code>) não entram em nenhuma contagem. Quando o nó também é master (comum em ambientes menores), o rótulo vira <strong>MASTER/HOT</strong>, <strong>MASTER/WARM</strong>, etc. Roles complementares (ingest, <code>data_content</code>, etc.) não afetam a contagem.' },
        ],
      },
      {
        id: 'help-total-indices', q: 'Total de Índices',
        summary: 'Contagem total de índices, incluindo os de sistema (prefixo <code>.</code>, como <code>.kibana</code> e <code>.security</code>). Uma contagem muito alta — e, sobretudo, um excesso de shards — pressiona a memória do master e degrada o desempenho; para séries temporais, prefira data streams. Clique para listar todos os índices.',
        data: [
          { label: 'Total de índices', desc: 'Número total de índices, visíveis e ocultos.' },
        ],
      },
      {
        id: 'help-data-volume', q: 'Volume de Dados',
        summary: 'Soma do tamanho <strong>em disco</strong> (store) de todos os índices, incluindo réplicas e índices de sistema. É a métrica mais direta do tamanho do cluster. O rodapé traz o total de <strong>documentos indexados</strong>. O uso de disco agregado por <strong>tier</strong> (HOT / WARM / COLD / FROZEN) fica no card <strong>Capacidade por tier</strong>, logo abaixo, na seção Disco por Tier.',
        data: [
          { label: 'Volume em disco (store)', desc: 'Tamanho ocupado por todos os shards (primários + réplicas). Difere do volume "lógico" dos dados, pois inclui as cópias.' },
          { label: 'Documentos (rodapé)', desc: 'Soma de <code>docs.count</code> de todos os índices — o total de documentos vivos no cluster. Não conta documentos marcados para exclusão que ainda não passaram por merge. Serve como ordem de grandeza do conteúdo indexado: cresce com a ingestão e diminui com expurgo/ILM.' },
        ],
      },
      {
        id: 'help-tier-disk', q: 'Disco por Tier',
        summary: 'Gráfico de barras horizontais com a capacidade de disco por <strong>tier de dados</strong> (HOT / WARM / COLD) — uma barra por tier, somando todos os data nodes daquele tier. O <strong>trilho cinza</strong> é a capacidade total do tier e o <strong>preenchimento colorido</strong> é o uso; o <strong>% de uso</strong> fica à direita e os bytes (usado · total · livre) logo abaixo da barra. Só conta nós com role de tier (<code>data_hot/warm/cold</code>).',
        data: [
          { label: 'Barra (trilho cinza)', desc: 'Capacidade total de disco do tier — a soma de todos os data nodes daquela camada.' },
          { label: 'Preenchimento colorido', desc: 'Espaço em uso. A cor segue o uso: verde < 70%, amarelo ≥ 70%, vermelho ≥ 85%.' },
          { label: '% à direita', desc: 'Percentual de uso da barra (usado ÷ total).' },
          { label: 'Usado · Total · Livre (abaixo)', desc: 'Os valores absolutos, centralizados sob a barra, com o <strong>percentual livre</strong> entre parênteses. Livre = total − usado. Watermarks padrão do ES: low 85% / high 90% / flood 95%.' },
          { label: 'Por que FROZEN não aparece', desc: 'O disco de um nó frozen não é capacidade de armazenamento: é o <strong>cache dos searchable snapshots</strong> (<code>xpack.searchable.snapshot.shared_cache.size</code>), pré-alocado num tamanho fixo e mantido cheio pelo Elasticsearch. Ele opera perto de 100% mesmo com o repositório inteiro à disposição, então somá-lo aos demais tiers criaria uma barra permanentemente vermelha sem significar falta de espaço. Os dados do tier frozen vivem no repositório de snapshots. Pelo mesmo motivo, o disco desses nós aparece como <strong>—</strong> em toda visão por nó: "Utilização por Nó", modal "Nós do Cluster", caixinha da Topologia, modal de detalhe do nó e os alertas de disco do Diagnóstico.' },
        ],
      },
      {
        id: 'help-cluster-topology', q: 'Topologia do Cluster',
        summary: 'Representação visual da <strong>infraestrutura do cluster</strong> agrupada por camada (tier). Cada faixa reúne os nós de um mesmo tier de dados; nós que acumulam múltiplos tiers (ex.: <code>data_hot</code> + <code>data_warm</code> no mesmo nó) formam uma <strong>faixa combinada</strong> (HOT / WARM). O layout é <strong>totalmente dinâmico</strong>: faixas surgem e somem conforme os tiers presentes no cluster, sem configuração manual.',
        data: [
          { label: 'Faixa MASTER', desc: 'Lista apenas os nós <strong>master dedicados</strong> — que têm a role <code>master</code> mas nenhuma role <code>data*</code>. O master eleito que também é data node <strong>não</strong> entra aqui; aparece no seu tier com um ★.' },
          { label: 'Faixas de tier (HOT / WARM / COLD / FROZEN)', desc: 'Agrupam os nós pelo conjunto de tiers que possuem. Nós com um único tier (ex.: só <code>data_hot</code>) ficam na faixa correspondente. Nós com múltiplos tiers (ex.: <code>data_hot</code> + <code>data_warm</code>) formam uma faixa combinada própria ("HOT / WARM") — refletindo a unificação de camadas. A ordem é HOT → WARM → COLD → FROZEN e, em caso de tiers combinados, pelo tier mais "quente" do conjunto.' },
          { label: 'Faixa OUTROS', desc: 'Nós sem role de tier de dados: coordinating puro, ingest-only, ML-only ou com apenas <code>data_content</code>. Aparecem ao final, quando existem.' },
          { label: '★ Master eleito', desc: 'O nó master eleito recebe uma estrela (★) no canto superior direito do seu card. Quando é master dedicado, aparece na faixa MASTER; quando também é data node, aparece na sua faixa de tier com a estrela.' },
          { label: 'IP do nó', desc: 'Endereço IP do nó, conforme reportado pelo <code>_cat/nodes</code>. Útil para correlacionar com logs, monitoramento e alertas de infra.' },
          { label: 'Barra de disco (rodapé do card)', desc: 'Uso de disco do nó em percentual. Cor verde < 70%, amarelo ≥ 70%, vermelho ≥ 85% — os mesmos limiares das demais telas.' },
          { label: 'Clique no card de nó', desc: 'Abre um <strong>modal de detalhe</strong> com informações da instância carregadas sob demanda (só para o nó clicado, sem impacto no dashboard): sistema operacional e versão do kernel, arquitetura, número de vCPUs, CPU ao vivo, load average, RAM (total / usada / livre), swap, heap JVM (usada / máx.), versão e uptime da JVM, uso de disco por mount e file descriptors do processo.' },
        ],
      },
      {
        id: 'help-snapshot-running', q: 'Snapshot em Execução',
        summary: 'Snapshots em <strong>criação</strong> neste momento — visão ao vivo de qual backup está sendo gerado, em qual repositório, há quanto tempo e o progresso total (bytes e shards). Diferente do <strong>Backup (SLM)</strong>, que mostra o histórico das políticas, este card reflete o que está acontecendo <em>agora</em>. O conteúdo do modal é buscado ao vivo a cada abertura — sem cache. Clique para abrir o painel com barra de progresso por snapshot.',
        data: [
          { label: 'Azul (N em andamento)', desc: 'Há N snapshots sendo criados agora. Clique para ver o progresso de cada um.' },
          { label: 'Verde (nenhum)', desc: 'Nenhum snapshot em criação no momento. É o estado normal fora das janelas de backup.' },
          { label: '— (indisponível)', desc: 'A API <code>_snapshot/_status</code> não respondeu (licença insuficiente ou falta de permissão). O card não consegue avaliar e não emite alarme.' },
          { label: 'Estado do snapshot', desc: '<strong>Iniciado</strong>: aceito, aguardando início da transferência. <strong>Em progresso</strong>: copiando dados dos shards para o repositório (estado esperado durante a maior parte da execução). <strong>Concluído</strong>: todos os shards copiados. <strong>Falhou</strong>: erro durante a criação — verifique logs do nó master e estado do repositório. <strong>Abortado</strong>: cancelado via API antes de concluir. <strong>Ausente</strong>: snapshot não encontrado no repositório (pode ter sido excluído externamente). <strong>Incompatível</strong>: criado em versão incompatível com a atual.' },
          { label: 'Barra de progresso', desc: 'Calculada por <strong>bytes processados / bytes totais</strong>. Nos primeiros instantes (antes de o ES calcular o total), o fallback é <strong>shards concluídos / shards totais</strong>.' },
          { label: 'Snapshot × Restauração', desc: 'Este card cobre apenas a <strong>criação</strong> de snapshots. Restaurações (restore) aparecem na seção <strong>Realocação e Recuperação de Shards</strong>, dentro do modal "Total de Shards", com tipo <em>Restauração (snapshot)</em>.' },
        ],
      },
      {
        id: 'help-total-shards', q: 'Total de Shards',
        summary: 'Número total de shards configurados (primários + réplicas). Cada shard tem um custo fixo de memória e metadados no master; <strong>excesso de shards</strong> é uma das causas mais comuns de instabilidade. A regra prática é manter abaixo de ~20 shards por GB de heap em cada nó. Clique para ver o resumo detalhado de primários, taxa de alocação, média por nó, operações de recovery em andamento e, quando houver shards não alocados, um aviso com link direto para o diagnóstico de alocação.',
        data: [
          { label: 'Total de shards', desc: 'Soma de primários e réplicas de todos os índices, incluindo os de sistema.' },
          { label: 'Primários (detalhe)', desc: 'Shards primários ativos no cluster — visível ao clicar no card.' },
          { label: 'Réplicas (detalhe)', desc: 'Shards de réplica ativos no cluster (cópias dos primários) — total de shards ativos menos os primários. Visível ao clicar no card.' },
          { label: 'Ativos %', desc: 'Percentual de shards (primários + réplicas) efetivamente alocados sobre o total esperado. Aparece no <strong>rodapé do card apenas quando &lt; 100%</strong> (amarelo 90–99.9%, vermelho &lt; 90% indica shards não alocados) e também no detalhe ao clicar no card; em 100% é omitido para não poluir a face.' },
          { label: 'Média por data node (detalhe)', desc: 'Total de shards dividido pelo nº de data nodes. Amarelo a partir de ~600 e vermelho a partir de ~1000 por nó — sinaliza oversharding no nível do cluster.' },
          { label: 'Aviso de shards não alocados (detalhe)', desc: 'Quando <code>unassigned_shards > 0</code>, o modal exibe um <strong>aviso informativo azul</strong> entre os números e a seção de recovery. Pode indicar restaurações de snapshot (<code>NEW_INDEX_RESTORED</code>) ou réplicas pendentes que ainda aguardam alocação (sem operação de recovery ativa). O botão <strong>"Ver diagnóstico"</strong> abre a tabela de diagnóstico de alocação (<code>_cluster/allocation/explain</code>), com o motivo exato de cada shard. Sem chamada extra — usa o <code>unassigned_shards</code> já presente no dashboard.' },
          { label: 'Realocação e Recuperação (detalhe)', desc: 'Lista das operações de shard <strong>em andamento</strong> (<code>_recovery?active_only</code>): índice, shard, se é primário ou réplica, tipo (realocação, restauração de snapshot, recuperação local), origem → destino, estágio, % concluído com barra de progresso, bytes migrados / total, tempo decorrido e o avanço de arquivos e translog. Vazio quando nenhuma recuperação está <em>ativa</em> — não equivale a "tudo alocado" (shards podem estar aguardando, visíveis no aviso acima).' },
          { label: 'Não Alocados (rodapé)', desc: 'Shards que o cluster não conseguiu atribuir a nenhum nó. Se forem primários, o índice fica inacessível e o cluster vai a RED. O ideal é 0.' },
          { label: 'Atraso (timeout) (rodapé)', desc: 'Parte dos não alocados que apenas aguarda o timeout de realocação após a saída de um nó (<code>node_left.delayed_timeout</code>, padrão 1m). Costuma se resolver sozinho — não é bloqueio real.' },
          { label: 'Realocando (rodapé)', desc: 'Shards migrando de um nó para outro, em geral após rebalanceamento ou adição de nó. Estado transitório.' },
          { label: 'Inicializando (rodapé)', desc: 'Shards sendo carregados pela primeira vez — ocorre na criação de índices ou na restauração de snapshot. Estado transitório.' },
        ],
      },
    ],
  },
  {
    label: 'Sinais de Alerta', icon: 'fa-triangle-exclamation',
    topics: [
      {
        id: 'help-pending-tasks', q: 'Tarefas Pendentes',
        summary: 'Tarefas de atualização do <strong>cluster state</strong> (criação de índices, alterações de mapping, alocação de shards) enfileiradas aguardando o nó <strong>master</strong>. Valores persistentemente acima de zero — e principalmente uma espera máxima alta — indicam um master sobrecarregado, causa comum de lentidão generalizada. Clique para ver a fila (<code>_cluster/pending_tasks</code>).',
        data: [
          { label: 'Nº na fila (pílula)', desc: 'Quantidade de tarefas aguardando o master agora. Verde = 0 (sem fila); amarelo = há fila; vermelho = fila com espera alta (≥ 200ms).' },
          { label: 'Espera máx na fila', desc: 'Maior tempo que uma tarefa está aguardando. É o sinal mais importante — uma espera crescente revela um master pressionado.' },
        ],
      },
      {
        id: 'help-ilm-errors', q: 'ILM com Falha',
        summary: 'Índices cuja execução da política de ILM (Index Lifecycle Management) <strong>falhou</strong> e está parada num passo de <strong>ERRO</strong> (<code>_ilm/explain?only_errors=true</code>). Nesse estado o índice não avança pelas fases (hot → warm → cold → delete): não é encolhido, realocado nem excluído. Causas comuns: falta de disco, ausência de nós com o atributo de alocação exigido, ou erros de permissão. Costuma exigir corrigir a causa e rodar <code>_ilm/retry</code>. Clique para ver os índices e o motivo do erro.',
        data: [
          { label: 'Nº de índices em erro', desc: 'Quantos índices estão parados num passo de ERRO. Verde = 0; vermelho = há índices travados que exigem investigação.' },
        ],
      },
      {
        id: 'help-circuit-breakers', q: 'Circuit Breakers',
        summary: 'Os circuit breakers abortam requisições para proteger a JVM de estouro de memória; o contador <code>tripped</code> soma quantas já foram derrubadas — cada disparo é uma query ou indexação rejeitada. O breaker <strong>parent</strong> é o mais crítico: agrega o uso de todos os demais e, ao atingir o limite (~95% do heap), passa a rejeitar tudo. <strong>Atenção:</strong> o contador é <strong>acumulado desde o boot</strong> — não reflete o instante atual; para o estado <em>agora</em>, use <strong>Parent CB % (Parent Circuit Breaker)</strong> e <strong>Fila TP (Fila de Thread Pool)</strong> na tabela Utilização por Nó. Clique para ver o uso por nó.',
        data: [
          { label: 'Total de disparos (tripped)', desc: 'Soma de disparos de todos os breakers desde o boot do nó. Verde = 0; vermelho = houve disparos (pressão de memória severa em algum momento).' },
          { label: 'Parent', desc: 'Nº de disparos do breaker parent (o agregador). Disparos aqui são os mais graves — indicam que o nó esgotou a proteção global de memória.' },
        ],
      },
      {
        id: 'help-slm-policies', q: 'Backup (SLM)',
        summary: 'Estado das políticas de <strong>snapshot (SLM — Snapshot Lifecycle Management)</strong>, os backups automáticos do cluster. Sem backups em dia, uma perda de dados pode ser irreversível. Clique para ver cada política: repositório, agendamento, último sucesso/falha e próxima execução.',
        data: [
          { label: 'Estado (pílula)', desc: '<span style="color:var(--green)">Verde</span> = backups em dia. <span style="color:var(--yellow)">Amarelo</span> = nenhuma política configurada (sem backup automático). <span style="color:var(--red)">Vermelho</span> = a execução mais recente de alguma política falhou — os backups podem estar desatualizados.' },
          { label: '— (indisponível)', desc: 'A API de SLM não respondeu (licença insuficiente ou falta de permissão). O card não consegue avaliar o backup e não emite alarme.' },
        ],
      },
      {
        id: 'help-flood-stage', q: 'Flood-stage',
        summary: 'Índices com <strong>bloqueio de escrita aplicado automaticamente</strong> pelo Elasticsearch quando o disco de um nó passou de <strong>95%</strong> (flood-stage watermark). É um <strong>incidente de disponibilidade ao vivo</strong>: enquanto durar, os índices afetados não aceitam escrita. O bloqueio <strong>persiste mesmo após liberar disco</strong> — remova com <code>"index.blocks.read_only_allow_delete": null</code> depois de resolver o espaço. Clique para listar os índices bloqueados.',
        data: [
          { label: 'Nº em flood-stage (pílula)', desc: '<span style="color:var(--green)">Verde</span> = 0 (nenhum índice bloqueado por disco). <span style="color:var(--red)">Vermelho</span> = há índices com escrita bloqueada — libere disco e remova o bloqueio.' },
          { label: 'Read-only manual (Diagnóstico)', desc: 'Bloqueios <code>read_only</code>/<code>write</code> definidos manualmente fora do ILM <strong>não</strong> entram aqui — são higiene, não incidente, e aparecem como apontamento amarelo na página Diagnóstico. Read-only definido pelo próprio ILM é esperado.' },
        ],
      },
    ],
  },
  {
    label: 'Utilização de Recursos', icon: 'fa-microchip',
    topics: [
      {
        id: 'help-resource-table', q: 'Utilização por Nó',
        summary: 'Tabela com indicadores ao vivo por nó — um por dimensão de saturação. Permite identificar nós sobrecarregados, com pressão de memória ou disco perto do limite. Clique para a visão completa, que inclui Heap JVM, GC Overhead, Rejeições e shards por nó.',
        data: [
          { label: 'Nó', desc: 'Nome do nó e suas roles principais (HOT / WARM / COLD…); o master eleito recebe ★.' },
          { label: 'CPU', desc: 'Uso do processador. Acima de 80% por períodos prolongados indica sobrecarga e degrada busca e indexação.' },
          { label: 'Disco', desc: 'Espaço utilizado. Acima de 85% o ES ativa o flood-stage watermark e coloca índices em modo read-only automaticamente.' },
          { label: 'Mem. Pressure (Memory Pressure / pressão de memória)', desc: 'Percentual da geração antiga (old-gen) do heap ocupada após o último GC (Garbage Collection) — o indicador real de pressão de memória. Acima de 75% gera pausas longas (GC storms).' },
          { label: 'Parent CB (Parent Circuit Breaker)', desc: 'Percentual do limite do circuit breaker parent em uso agora — indicador antecipado. Ao chegar a 100% o nó começa a derrubar requisições.' },
          { label: 'Pressão Escrita (Indexing Pressure)', desc: 'Percentual da memória de buffer de indexação em uso agora sobre o limite (<code>indexing_pressure.memory</code>) — indicador antecipado e ao vivo de saturação de escrita. Ao chegar a 100% o nó passa a rejeitar escritas (HTTP 429). É o equivalente de escrita do Parent CB.' },
          { label: 'Fila TP (Fila de Thread Pool)', desc: 'Soma das requisições enfileiradas nas thread pools do nó. Indicador antecipado de saturação — uma fila crescente precede as rejeições.' },
          { label: 'Heap JVM — visão completa', desc: 'Percentual do heap alocado em uso no momento. Disponível na visão completa (clique no card). Atenção: oscila com o ciclo de GC — prefira Mem. Pressure como referência de pressão real de memória.' },
          { label: 'GC Overhead — visão completa', desc: 'Percentual do tempo de vida do nó gasto em garbage collection. Acima de 25% indica pressão severa de memória. Disponível na visão completa (clique no card).' },
          { label: 'Rejeições de Thread Pool — visão completa', desc: 'Requisições descartadas por sobrecarga, acumuladas desde o boot (indicador tardio). Um valor maior que 0 pode ser histórico antigo; para o estado atual, use a Fila TP. Disponível na visão completa (clique no card).' },
        ],
      },
    ],
  },
  {
    label: 'Configuração de Índices', icon: 'fa-layer-group',
    topics: [
      {
        id: 'help-without-replicas', q: 'Sem Réplica',
        summary: 'Índices configurados com <code>number_of_replicas = 0</code>. Sem réplica, o shard primário é um <strong>ponto único de falha</strong>: perder o nó que o hospeda significa perda de dados permanente. Aceitável para dados descartáveis ou reconstruíveis, mas perigoso em produção. Clique para ver a lista.',
        data: [
          { label: 'Nº de índices', desc: 'Quantos índices estão sem réplica. Verde = 0; amarelo = há índices sem redundância — avalie quais são críticos.' },
        ],
      },
      {
        id: 'help-large-shards', q: 'Shards Primários > 50 GB',
        summary: 'Índices que têm <strong>algum shard primário individual</strong> acima de 50 GB (não a soma do índice). Shards primários grandes causam recuperação lenta, realocação demorada e queda de desempenho. A recomendação da Elastic é manter shards entre 10 e 50 GB — considere reindexar com mais shards ou ajustar o rollover da política de ILM. Clique para ver os índices e o tamanho do maior shard.',
        data: [
          { label: 'Nº de índices', desc: 'Quantos índices têm ao menos um shard primário acima de 50 GB. Verde = 0; amarelo = há shards grandes demais.' },
        ],
      },
      {
        id: 'help-without-ilm', q: 'Sem Política de ILM',
        summary: 'Índices sem <code>index.lifecycle.name</code>, ou seja, sem Index Lifecycle Management. Sem ILM, o índice cresce indefinidamente e exige gestão manual de rollover, migração entre tiers e expurgo. O ILM automatiza essas transições (hot → warm → cold → delete), otimizando recursos. Clique para a lista.',
        data: [
          { label: 'Nº de índices', desc: 'Quantos índices não têm política de ILM atribuída. Verde = 0; amarelo = há índices sem ciclo de vida automatizado.' },
        ],
      },
      {
        id: 'help-ilm-without-delete', q: 'ILM sem Fase DELETE',
        summary: 'Políticas de ILM sem a fase <strong>delete</strong>. Elas movem dados entre tiers mas nunca os removem — a retenção fica infinita e o disco só cresce. Pode ser intencional (dados que devem ser mantidos para sempre), mas costuma ser um esquecimento. Clique para ver as políticas e suas fases.',
        data: [
          { label: 'Nº de políticas', desc: 'Quantas políticas de ILM não têm fase delete. Verde = 0; amarelo = há políticas sem expurgo automático.' },
        ],
      },
    ],
  },
  {
    label: 'Tarefas em Execução', icon: 'fa-list-check',
    topics: [
      {
        id: 'help-running-tasks', q: 'Tarefas em Execução',
        summary: 'Lista as tarefas do cluster com tempo de execução acima de <strong>5s</strong> (ignora ações internas de baixo nível, como <code>health-node[c]</code>). Útil para flagrar operações travadas, reindexações longas ou consultas pesadas. Operações que se dividem em <strong>slices</strong> (reindex, update_by_query, delete_by_query com <code>slices=N</code>) são <strong>agrupadas sob a tarefa-pai</strong> — a linha do pai traz um badge com o nº de sub-tarefas e um chevron para expandir/recolher as filhas (recolhido por padrão). A <strong>contagem</strong> exibida é de <strong>operações</strong> (pais), não de tarefas brutas. Cada tarefa pode ser inspecionada (JSON completo) e, quando cancelável, cancelada.',
        data: [
          { label: 'Nó', desc: 'Nó onde a tarefa está em execução. Nas tarefas-pai que fatiam em slices, o chevron à esquerda expande/recolhe as sub-tarefas.' },
          { label: 'Action', desc: 'Tipo de ação interna do ES (ex.: <code>indices:data/write/bulk</code>). Na tarefa-pai, uma linha logo abaixo indica o nº de sub-tarefas (slices) agrupadas.' },
          { label: 'Description', desc: 'Descrição legível do que a tarefa faz.' },
          { label: 'Tempo', desc: 'Há quanto tempo está em execução. Quanto maior, mais suspeita de estar travada. Passe o mouse sobre o valor para ver a <strong>data/hora de início</strong> num tooltip (a coluna "Início" foi embutida aqui para liberar espaço na tabela).' },
          { label: 'Cancellable', desc: 'Se a tarefa aceita cancelamento. Tarefas internas críticas aparecem como não canceláveis. Cancelar a tarefa-pai cancela também as filhas.' },
          { label: 'Agrupamento (pai → slices)', desc: 'Feito por <code>parent_task_id</code>. Só operações <em>sliced scroll</em> geram pai + filhas; um <strong>forcemerge</strong>, por exemplo, não tem coordenadora-pai e aparece como linhas independentes. Uma filha cujo pai não esteja na lista (ex.: pai abaixo de 5s) é mostrada no nível raiz.' },
        ],
      },
    ],
  },
  {
    label: 'Página de Diagnóstico', icon: 'fa-lightbulb',
    topics: [
      {
        id: 'help-insights-overview', q: 'O que é a página de Diagnóstico',
        summary: 'O <strong>Diagnóstico</strong> é uma leitura <strong>interpretada</strong> dos mesmos dados dos Sinais Vitais e do Inventário — ele reaproveita o que já foi carregado (<strong>sem novas requisições ao cluster</strong>) e destaca apenas <strong>o que merece atenção</strong>. Cada card é <strong>condicional</strong>: só aparece quando a situação que ele descreve está de fato ocorrendo. Quando está tudo saudável, a grade fica vazia, com uma mensagem positiva. Os cards são ordenados por severidade: <span style="color:var(--red)">críticos</span> primeiro, depois <span style="color:var(--yellow)">atenção</span> e por fim <span style="color:var(--blue)">info</span>.',
        data: [
          { label: 'Resumo de severidade (topo)', desc: 'A cor e o ícone seguem a <strong>disponibilidade</strong> do cluster (status GREEN/YELLOW/RED), e não as severidades de configuração — um cluster GREEN aparece verde mesmo havendo riscos a tratar. Ao lado ficam os contadores Crítico / Atenção / Info.' },
          { label: 'Crítico / Atenção / Info', desc: '<span style="color:var(--red)">Crítico</span> = cards vermelhos (ação urgente). <span style="color:var(--yellow)">Atenção</span> = amarelos (avaliar). <span style="color:var(--blue)">Info</span> = azuis (apenas informativo).' },
          { label: 'Badge na sidebar', desc: 'O número ao lado de "Diagnóstico" no menu reflete a soma de <strong>Crítico + Atenção</strong> (fica oculto quando é zero).' },
        ],
      },
      {
        id: 'help-insights-cards', q: 'Cards de Diagnóstico e quando aparecem',
        summary: 'A lista abaixo descreve cada card de insight, a sua <strong>severidade</strong> e a <strong>condição</strong> que faz com que ele apareça. A maioria abre um modal de detalhe ao clicar no botão de ação.',
        data: [
          { label: 'Índices sem réplica', desc: '<span style="color:var(--red)">Vermelho</span>. Aparece quando há índices com <code>number_of_replicas = 0</code>. Abre "Sem Réplica".' },
          { label: 'Índices sem política de ILM', desc: '<span style="color:var(--yellow)">Amarelo</span>. Há índices sem <code>index.lifecycle.name</code>. Abre "Sem Política de ILM".' },
          { label: 'Disco alto no tier (um card por tier)', desc: '<span style="color:var(--yellow)">Amarelo</span> ≥ 70% / <span style="color:var(--red)">vermelho</span> ≥ 85%. Um card por tier (HOT/WARM/COLD/FROZEN) que tenha algum nó com disco ≥ 70%. O botão "Ver detalhes" abre o modal "Uso de disco por nó".' },
          { label: 'Políticas de ILM sem fase delete', desc: '<span style="color:var(--yellow)">Amarelo</span>. Há política de ILM sem a fase <code>delete</code> (retenção infinita). Abre "ILM sem Fase DELETE".' },
          { label: 'Réplicas não alocáveis', desc: '<span style="color:var(--red)">Vermelho</span>. Algum índice tem nº de réplicas ≥ nº de data nodes — réplicas que nunca alocam e mantêm o cluster em YELLOW. Abre "Réplicas Não Alocáveis".' },
          { label: 'Quorum de master frágil', desc: '<span style="color:var(--red)">Vermelho</span> (menos de 3 master-eligible) / <span style="color:var(--yellow)">amarelo</span> (número par). Só em clusters com mais de um nó. Abre "Nós do Cluster".' },
          { label: 'Oversharding', desc: '<span style="color:var(--yellow)">Amarelo</span>. Há índices com mais de um shard primário e tamanho médio por shard abaixo de 1 GB. Abre "Índices com Oversharding".' },
          { label: 'Pressão de memória', desc: '<span style="color:var(--yellow)">Amarelo</span>. Algum nó com GC overhead ≥ 25% ou memory pressure ≥ 75%. Abre "Nós do Cluster".' },
          { label: 'Heap acima de 50% da RAM', desc: '<span style="color:var(--yellow)">Amarelo</span>. Algum nó com heap máximo acima de 50% da RAM física — sobra pouca memória para o <em>filesystem cache</em>, essencial ao desempenho de busca (o recomendado é heap ≤ 50% da RAM). O botão "Ver nós" abre a lista só dos nós alertados, com nome + role, o % do heap sobre a RAM, o heap e a RAM total.' },
          { label: 'Pressão de escrita', desc: '<span style="color:var(--yellow)">Amarelo</span> (≥ 70%) / <span style="color:var(--red)">vermelho</span> (≥ 90%). Algum nó com a memória de buffer de indexação (<code>indexing_pressure</code>) acima de 70% do limite — ao chegar a 100% o nó rejeita escritas (HTTP 429). Abre "Nós do Cluster".' },
          { label: 'Versões de Elasticsearch mistas', desc: '<span style="color:var(--yellow)">Amarelo</span>. Há mais de uma versão de Elasticsearch entre os nós (rolling upgrade em andamento ou incompleto). Abre "Nós do Cluster".' },
          { label: 'Backup / SLM', desc: '<span style="color:var(--red)">Vermelho</span> (a execução de uma política de SLM falhou) / <span style="color:var(--yellow)">amarelo</span> (nenhuma política de SLM configurada). Só quando a consulta de SLM está disponível. Abre "Políticas de Snapshot (SLM)".' },
          { label: 'Tarefa longa em execução', desc: '<span style="color:var(--blue)">Info</span>. Há tarefa(s) em execução há mais de 5 segundos.' },
          { label: 'Índices bloqueados por flood-stage', desc: '<span style="color:var(--red)">Vermelho</span>. Há índices com <code>read_only_allow_delete</code> — bloqueio de escrita aplicado automaticamente quando o disco passou de 95%. Abre "Índices Read-only".' },
          { label: 'Índices read-only sem ILM', desc: '<span style="color:var(--yellow)">Amarelo</span>. Há índices com bloqueio manual (<code>read_only</code>/<code>write</code>) fora do ILM (read-only definido pelo ILM não conta). Abre "Índices Read-only".' },
          { label: 'Configurações de cluster de risco', desc: '<span style="color:var(--red)">Vermelho</span> / <span style="color:var(--yellow)">amarelo</span>. Há sobrescritas de risco no <code>_cluster/settings</code> e a consulta está disponível. Abre "Configurações de Cluster de Risco".' },
          { label: 'Deprecations', desc: '<span style="color:var(--red)">Vermelho</span> (há item crítico) / <span style="color:var(--yellow)">amarelo</span>. A Deprecation Info API está disponível e retornou avisos. Abre "Deprecations".' },
          { label: 'Licença expirada / expirando', desc: '<span style="color:var(--red)">Vermelho</span> (expirada ou ≤ 7 dias) / <span style="color:var(--yellow)">amarelo</span> (≤ 30 dias). A licença está próxima de vencer ou já venceu.' },
          { label: 'Shards não alocados — diagnóstico', desc: '<span style="color:var(--red)">Vermelho</span>. Há shards não alocados no cluster. Abre "Diagnóstico de Alocação" (<code>allocation explain</code>).' },
          { label: 'Disponibilidade comprometida', desc: '<span style="color:var(--red)">Vermelho</span> / <span style="color:var(--yellow)">amarelo</span>. Aparece só quando o status ≠ green, há shards não alocados ou houve disparos de circuit breaker — fica oculto quando tudo está saudável.' },
        ],
      },
    ],
  },
  {
    label: 'Página Kibana', icon: 'fa-chart-line',
    topics: [
      {
        id: 'help-kibana-config', q: 'Configuração e de onde vêm os dados',
        summary: 'A página <strong>Kibana</strong> é ativada em <strong>Configuração</strong> e usa <strong>três fontes</strong>, com precedência aplicada <strong>por métrica</strong>: <strong>Elastic Agent → self-monitoring → API do Kibana</strong>. A primeira fonte que tiver o dado vence; o tooltip de cada célula mostra qual foi usada. As instâncias são <strong>descobertas automaticamente</strong> pelo self-monitoring do cluster conectado — cadastrar a URL é o que acrescenta Task Manager, Fleet e APM Server, que só existem na API.',
        data: [
          { label: 'Ativação', desc: 'O item <strong>Kibana</strong> só aparece na barra lateral com a integração ativada. A configuração é gravada <strong>por conexão salva</strong>: cada cluster tem suas próprias instâncias. Numa conexão ad-hoc que não corresponda a nenhuma salva não há onde gravar — salve a conexão primeiro.' },
          { label: 'Usuário e senha', desc: 'Compartilhados por todas as instâncias. A senha fica gravada em texto plano no <code>connections.db</code>, mesma condição das credenciais do Elasticsearch (ferramenta local, sem autenticação própria).' },
          { label: 'Sem nenhuma URL cadastrada', desc: 'A página continua funcionando com o que vier do self-monitoring: instâncias, status, heap, RAM e event loop. Ficam de fora apenas Task Manager, Fleet e APM Server.' },
          { label: 'Testar', desc: 'Valida URL e credenciais de uma instância isolada, sem gravar nada — devolve nome, versão e status. Com a senha já salva, o teste a reaproveita sem exigir que você redigite.' },
        ],
      },
      {
        id: 'help-kibana-instances', q: 'Instâncias Saudáveis',
        summary: 'Card de topo da página: quantas instâncias estão disponíveis, com a <strong>versão</strong> e as instâncias inacessíveis no rodapé.',
        data: [
          { label: 'Valor principal', desc: 'Proporção de instâncias com status <strong>disponível</strong>. O status vem do <code>/api/status</code> ao vivo quando a URL está cadastrada; sem URL, vem do self-monitoring — que pode estar alguns minutos atrasado.' },
          { label: 'Versão (rodapé)', desc: 'Versão das instâncias. Quando há mais de uma, todas são listadas e o valor fica <span style="color:var(--yellow)">amarelo</span> — sinal de upgrade em andamento ou incompleto. Instâncias em versões diferentes atrás do mesmo load balancer podem se comportar de forma inconsistente.' },
          { label: 'Inacessíveis (rodapé)', desc: 'Instâncias com URL cadastrada que não responderam: timeout, erro de TLS, credencial inválida ou serviço fora do ar. Só aparece quando há alguma. O motivo exato fica no tooltip da linha correspondente na tabela.' },
        ],
      },
      {
        id: 'help-kibana-utilization', q: 'Utilização por Instância',
        summary: 'Tabela de recursos por instância, no mesmo formato da <strong>Utilização por Nó</strong> dos Sinais Vitais. Cada célula informa no tooltip a <strong>origem</strong> do número. Um traço significa <strong>ausência de fonte</strong> para aquela métrica — não é zero.',
        data: [
          { label: 'CPU e Disco', desc: 'São do <strong>host</strong> e vêm exclusivamente da integração <code>system</code> do <strong>Elastic Agent</strong> (<code>metrics-system.cpu-*</code> e <code>metrics-system.filesystem-*</code>), casada pelo nome do host. <strong>A API do Kibana não expõe nenhum dos dois</strong>, e o self-monitoring também não — ambos coletam o mesmo conjunto da API. Sem agente naquele host, a célula fica com um traço. No disco é considerado o <strong>ponto de montagem mais cheio</strong>.' },
          { label: 'RAM', desc: 'Memória do host onde a instância roda. Vem do Elastic Agent quando disponível; senão, do self-monitoring ou da API.' },
          { label: 'Heap', desc: 'Heap do processo Node.js sobre o <strong><code>size_limit</code></strong> (o <code>--max-old-space-size</code>). Esse é o denominador correto: o V8 aumenta o heap sob demanda, então comparar contra o total alocado no momento inflaria o percentual e geraria falso alarme.' },
          { label: 'ELU (Event Loop Utilization)', desc: 'Fração do intervalo de coleta em que o event loop ficou <strong>ativo</strong>, já calculada pelo próprio Kibana. Como o Kibana é <strong>single-threaded</strong>, é o indicador mais fiel de saturação de CPU do processo — acima de ~80% as requisições passam a enfileirar. É o substituto legítimo de uma coluna de CPU do processo, que não existe na API.' },
          { label: 'Delay', desc: 'Atraso do event loop em milissegundos. Valores altos indicam o loop bloqueado por trabalho síncrono — sintoma direto de lentidão percebida na interface.' },
          { label: 'só self-monitoring', desc: 'Marca instâncias descobertas pelo self-monitoring sem URL cadastrada. Elas não têm Task Manager nem alimentam Fleet/APM — cadastre a URL na Configuração para completar.' },
        ],
      },
      {
        id: 'help-kibana-task-manager', q: 'Task Manager (Alerting, Actions e Reporting)',
        summary: 'Saúde do <strong>Task Manager</strong> por instância (<code>/api/task_manager/_health</code>) — o motor que executa <strong>alertas</strong>, <strong>ações</strong> e <strong>relatórios</strong>. Os valores já vêm calculados pelo Kibana e consultá-los <strong>não gera carga adicional</strong>. Só aparece para instâncias com URL cadastrada.',
        data: [
          { label: 'Status', desc: '<strong>OK</strong>, <strong>Warning</strong> ou <strong>Error</strong>, conforme a própria avaliação do Kibana sobre configuração, workload, runtime e capacidade.' },
          { label: 'Load', desc: 'Ocupação dos <strong>workers de tarefas do Kibana</strong> — não confundir com o load average do host, que é do sistema operacional e não diz nada sobre o Kibana. Perto de 100% não há capacidade sobrando para executar tarefas no horário previsto.' },
          { label: 'Drift', desc: 'Atraso entre o horário <strong>agendado</strong> da tarefa e sua <strong>execução real</strong> (p50, com o p99 abaixo). Drift alto significa alertas disparando tarde e relatórios saindo fora de hora — mesmo com o cluster saudável.' },
          { label: 'Capacidade', desc: 'Estimativa do próprio Kibana sobre a suficiência da capacidade atual para a carga de tarefas configurada.' },
          { label: 'Atrasadas', desc: 'Tarefas cujo horário já passou e que ainda não executaram. Um número persistentemente acima de zero indica saturação do Task Manager.' },
        ],
      },
      {
        id: 'help-kibana-fleet', q: 'Fleet — Agentes',
        summary: 'Resumo da frota de <strong>Elastic Agents</strong> gerenciada pelo Fleet (<code>/api/fleet/agent_status</code>, uma única chamada). Os estados usam os <strong>mesmos rótulos da UI do Fleet</strong>, para o número bater com o que você vê lá. Exige URL cadastrada e o privilégio <code>fleet-agents-read</code>; sem ele o card mostra <strong>—</strong> em vez de alarme falso.',
        data: [
          { label: 'Total', desc: 'Agentes registrados no Fleet, <strong>sem contar os unenrolled</strong> (usa o campo <code>active</code> da API — o <code>all</code> incluiria agentes já removidos da frota e o <code>total</code> está deprecated). Fica <span style="color:var(--red)">vermelho</span> se houver algum <strong>Unhealthy</strong> e <span style="color:var(--yellow)">amarelo</span> se houver <strong>Offline</strong>.' },
          { label: 'Healthy', desc: 'Agentes enrolled, com check-in recente e sem atualização em andamento — operando normalmente. Corresponde ao campo <code>online</code> da API.' },
          { label: 'Unhealthy', desc: 'Agente em execução mas <strong>com erro ou degradado</strong>: política inválida, integração quebrada, permissão insuficiente no host. Costuma significar coleta parcial ou interrompida. Soma os campos <code>error</code> e <code>degraded</code> da API — é assim que a UI do Fleet compõe esse número.' },
          { label: 'Offline', desc: 'Sem check-in há pelo menos <strong>5 minutos</strong>: host desligado, problema de rede ou agente parado. Enquanto isso, os dados daquele host não estão chegando. Passado o timeout de inatividade, o agente vira <em>Inactive</em> e sai da visão padrão do Fleet.' },
          { label: 'Updating', desc: 'Aplicando política, atualizando o binário ou concluindo enrollment/unenrollment. É um estado transitório; se persistir, o processo travou.' },
        ],
      },
      {
        id: 'help-kibana-apm', q: 'APM Server',
        summary: 'Saúde do <strong>APM Server</strong> pela ótica do Fleet: quantos agentes executam a integração <code>apm</code>. Mede a <strong>disponibilidade do coletor</strong> — se ele está de pé para receber os dados enviados pelos agentes APM das aplicações. <strong>Não</strong> analisa os dados de APM em si (serviços, latência, taxa de erro).',
        data: [
          { label: 'Como é descoberto', desc: 'Busca as <strong>package policies</strong> do pacote <code>apm</code> no Fleet e, para cada <strong>agent policy</strong> que as contém, consulta o resumo de agentes com <code>?policyId=</code> — sem varrer a lista inteira de agentes.' },
          { label: 'Total / Healthy / Unhealthy / Offline / Updating', desc: 'Agentes que rodam a integração APM, por estado — mesmos rótulos da UI do Fleet, iguais aos do card do Fleet. Um APM Server <strong>Offline</strong> significa que <strong>nenhum dado novo de APM está sendo ingerido</strong> por aquele coletor, mesmo com as aplicações instrumentadas funcionando; <strong>Unhealthy</strong> costuma indicar ingestão parcial.' },
          { label: 'Detalhe por policy', desc: 'A tabela <strong>"Policies com integração APM"</strong>, logo abaixo na página, lista cada agent policy que inclui a integração: versão do pacote e agentes por estado — útil para notar um grupo onde o coletor não subiu.' },
          { label: 'Não configurado', desc: 'Nenhuma package policy do pacote <code>apm</code> foi encontrada neste Fleet — o APM Server não está sendo gerenciado por aqui (pode estar rodando como binário standalone).' },
        ],
      },
    ],
  },
  {
    label: 'Página Logstash', icon: 'fa-diagram-project',
    topics: [
      {
        id: 'help-logstash-config', q: 'Configuração e de onde vêm os dados',
        summary: 'A página <strong>Logstash</strong> é ativada em <strong>Configuração</strong> e usa <strong>três fontes</strong>: <strong>Elastic Agent</strong> (RAM e disco do host), <strong>self-monitoring</strong> do cluster conectado e a <strong>API de monitoramento</strong> de cada instância (porta 9600). O tooltip de cada célula mostra a origem usada. As instâncias são <strong>descobertas pelo self-monitoring</strong>; cadastrar a URL é o que acrescenta <strong>pipelines, filas, DLQ e o custo por plugin</strong>, que só existem na API.',
        data: [
          { label: 'Ativação', desc: 'O item <strong>Logstash</strong> só aparece na barra lateral com a integração ativada, logo abaixo do Kibana. A configuração é gravada <strong>por conexão salva</strong>: cada cluster tem suas próprias instâncias. Numa conexão ad-hoc que não corresponda a nenhuma salva não há onde gravar — salve a conexão primeiro.' },
          { label: 'Usuário e senha são opcionais', desc: 'A API de monitoramento do Logstash é <strong>aberta por padrão</strong> (<code>api.auth.type: none</code>): sem credencial, as chamadas vão sem autenticação. Preencha só quando o ambiente usar <code>api.auth.type: basic</code>. A senha fica gravada em texto plano no <code>connections.db</code>, mesma condição das credenciais do Elasticsearch.' },
          { label: 'URL da instância', desc: 'É o endereço da <strong>API de monitoramento</strong>, não o do pipeline: normalmente <code>http://host:9600</code>. Sem esquema escrito, assume-se <strong>http</strong> — ao contrário do Kibana, essa API não usa TLS por padrão (só com <code>api.ssl.enabled: true</code>).' },
          { label: 'Sem nenhuma URL cadastrada', desc: 'A página continua listando as instâncias vistas pelo self-monitoring, com CPU, heap, FDs e vazão. Ficam de fora pipelines, filas, DLQ e plugins — o self-monitoring só traz os totais do nó.' },
          { label: 'Versões', desc: 'Feita para <strong>Logstash 8.x e 9.x</strong>. O <code>/_health_report</code>, usado para o status, existe só nas versões mais recentes; sem ele a página cai para o campo <code>status</code> do <code>/_node/stats</code>, sem perder mais nada.' },
        ],
      },
      {
        id: 'help-logstash-instances', q: 'Instâncias Saudáveis',
        summary: 'Card de topo: quantas instâncias estão com status verde, com a <strong>versão</strong> e as inacessíveis no rodapé.',
        data: [
          { label: 'Valor principal', desc: 'Proporção de instâncias com status <strong>verde</strong>. Com URL cadastrada, o status vem do <code>/_health_report</code> — a avaliação do próprio Logstash, que enxerga pipeline parado e falha de reload, coisas que o campo <code>status</code> do <code>/_node/stats</code> ignora. Sem o endpoint (versões antigas) ou sem URL, cai para esse campo ou para o self-monitoring.' },
          { label: 'Versão (rodapé)', desc: 'Versão das instâncias. Mais de uma fica <span style="color:var(--yellow)">amarela</span> — upgrade em andamento ou incompleto. Instâncias em versões diferentes processando o mesmo pipeline podem se comportar de forma distinta.' },
          { label: 'Inacessíveis (rodapé)', desc: 'Instâncias com URL cadastrada que não responderam: timeout, porta 9600 fechada (a API só escuta em <code>127.0.0.1</code> quando <code>api.http.host</code> não é configurado), credencial inválida ou processo fora do ar. O motivo exato fica no tooltip da linha correspondente na tabela.' },
        ],
      },
      {
        id: 'help-logstash-throughput', q: 'Vazão de Eventos',
        summary: 'Vazão somando todas as instâncias. Os contadores do Logstash são <strong>acumulados desde o start</strong> do processo, então o valor é a <strong>média desde o start</strong> (eventos de saída ÷ uptime) — não a taxa deste instante, que exigiria duas coletas. Ler a média como se fosse "agora" é o erro mais comum aqui: um pico de ontem continua diluído nela.',
        data: [
          { label: 'Eventos/s (média desde o start)', desc: 'Eventos de saída divididos pelo uptime da JVM. Serve para dimensionar ordem de grandeza e comparar instâncias entre si, não para detectar um pico agora.' },
          { label: 'Entrada / Saída / Filtrados', desc: 'Totais acumulados. <strong>Saída</strong> bem abaixo da <strong>entrada</strong>, sem um <code>drop</code> intencional no pipeline, significa eventos retidos na fila ou perdidos para a DLQ. <strong>Filtrados</strong> é quanto passou pela seção de filtros.' },
          { label: 'ms/evento', desc: 'Custo médio de processamento por evento (tempo total ÷ eventos de saída). É o número comparável entre pipelines de volumes diferentes: dobrar o volume não muda o ms/evento, mas um <code>grok</code> mal escrito muda. O detalhe por plugin fica na tabela <strong>Plugins mais lentos</strong>.' },
        ],
      },
      {
        id: 'help-logstash-queue', q: 'Fila Persistente',
        summary: 'Situação das filas dos pipelines. A <strong>fila persistente</strong> (PQ) grava os eventos em disco antes de processá-los — absorve picos e sobrevive a restart; a de <strong>memória</strong> não tem teto em bytes e perde o que estiver em trânsito se o processo cair.',
        data: [
          { label: 'Valor principal', desc: 'Ocupação da <strong>fila mais cheia</strong> entre as persistentes (bytes em uso ÷ <code>queue.max_bytes</code>). Só nelas existe um máximo para dividir, por isso é o pior caso entre as persistentes e não uma média.' },
          { label: 'Por que importa', desc: 'Fila persistente cheia faz o Logstash aplicar <strong>backpressure</strong> na entrada: o input para de aceitar eventos e a pressão sobe para quem produz (Beats, Kafka, aplicação). Costuma ser sintoma do <em>output</em> lento ou indisponível, não da fila em si.' },
          { label: 'Persistentes / Em memória', desc: 'Quantos pipelines usam cada tipo. Fila de memória é o padrão (<code>queue.type: memory</code>); persistente exige <code>queue.type: persisted</code>.' },
          { label: 'Ocupado', desc: 'Bytes em uso e o máximo somado de todas as filas persistentes. O espaço livre do disco onde cada fila vive fica no tooltip da coluna <strong>Fila</strong> da tabela de pipelines — a PQ para de aceitar eventos quando o disco enche, mesmo longe do <code>max_bytes</code>.' },
          { label: 'Card neutro (—)', desc: 'Sem nenhuma fila persistente não há o que medir: o card fica neutro informando que tudo está em memória. Não é zero de ocupação.' },
        ],
      },
      {
        id: 'help-logstash-dlq', q: 'Dead Letter Queue',
        summary: 'A <strong>dead letter queue</strong> guarda eventos que o output rejeitou de forma definitiva — tipicamente <em>mapping conflict</em> no Elasticsearch (HTTP 400). Cada evento aqui é um evento que <strong>não chegou ao destino</strong>, e nada o reprocessa sozinho: é preciso lê-la com o input <code>dead_letter_queue</code> e tratar.',
        data: [
          { label: 'Descartados', desc: 'Eventos escritos na DLQ. Qualquer valor acima de zero fica <span style="color:var(--red)">vermelho</span>: é perda de dado silenciosa do ponto de vista do pipeline, que segue verde.' },
          { label: 'Tamanho', desc: 'Espaço ocupado pela DLQ em disco. Cresce até <code>dead_letter_queue.max_bytes</code> (1 GB por padrão) e, ao bater o limite, o comportamento depende do <code>storage_policy</code>.' },
          { label: 'Expirados', desc: 'Eventos que <strong>saíram</strong> da DLQ por idade ou tamanho (<code>dead_letter_queue.retain.age</code>, ou <code>storage_policy: drop_older</code>). Esses estão <strong>perdidos</strong> — não há mais o que reprocessar.' },
          { label: 'Card neutro (—)', desc: 'A DLQ é <strong>desativada por padrão</strong> (<code>dead_letter_queue.enable: false</code>). Sem ela, um evento rejeitado pelo output só aparece no log do Logstash e desaparece: o card neutro não é garantia de que nada foi descartado.' },
        ],
      },
      {
        id: 'help-logstash-reloads', q: 'Reloads com Falha',
        summary: 'Recargas automáticas de configuração (<code>config.reload.automatic</code>) que <strong>falharam</strong>. Uma falha significa que o Logstash continua rodando a configuração <strong>anterior</strong>: a alteração feita não está em vigor, e fora do log nada avisa.',
        data: [
          { label: 'Valor', desc: 'Soma das falhas de recarga de todos os pipelines (ou o total do nó, quando não há URL cadastrada). <span style="color:var(--red)">Vermelho</span> a partir de uma.' },
          { label: 'Causas típicas', desc: 'Erro de sintaxe no arquivo de pipeline, plugin não instalado, credencial inválida em um output, referência a arquivo inexistente. O motivo da última falha fica no tooltip da coluna <strong>Reloads</strong> da tabela de pipelines.' },
        ],
      },
      {
        id: 'help-logstash-utilization', q: 'Utilização por Instância',
        summary: 'Tabela de recursos por instância, no mesmo formato da <strong>Utilização por Nó</strong> dos Sinais Vitais. Cada célula informa no tooltip a <strong>origem</strong> do número; um traço significa <strong>ausência de fonte</strong> para aquela métrica — não é zero.',
        data: [
          { label: 'CPU', desc: 'CPU do <strong>processo</strong> Logstash (<code>process.cpu.percent</code>), não do host. Diferente do Kibana, aqui a API expõe CPU — e é a do processo que responde se o Logstash está no limite. Vem do self-monitoring ou da API.' },
          { label: 'Heap', desc: 'Heap da JVM sobre o máximo configurado (<code>-Xmx</code> no <code>jvm.options</code>). Acima de ~75% de forma sustentada, o GC passa a consumir CPU que seria do pipeline e a vazão cai sem que nada apareça como erro. Heap muito grande também prejudica: aumenta a pausa do GC.' },
          { label: 'RAM e Disco', desc: 'São do <strong>host</strong> e vêm exclusivamente da integração <code>system</code> do <strong>Elastic Agent</strong> (<code>metrics-system.memory-*</code> e <code>metrics-system.filesystem-*</code>), casada pelo nome do host. <strong>A API do Logstash não expõe nenhum dos dois.</strong> Sem agente naquele host, a célula fica com um traço. No disco vale o <strong>ponto de montagem mais cheio</strong>.' },
          { label: 'FDs (file descriptors)', desc: 'Descritores abertos sobre o máximo do processo, com os absolutos abaixo da barra. Logstash com muitos inputs de arquivo ou conexões de saída bate esse teto antes de qualquer outro limite, e o sintoma é <code>too many open files</code> — com o pipeline parando sem erro de configuração.' },
          { label: 'Eventos/s', desc: 'Vazão da instância: média desde o start (eventos de saída ÷ uptime), não taxa instantânea.' },
          { label: 'só self-monitoring', desc: 'Marca instâncias descobertas sem URL cadastrada. Elas não têm pipelines, filas, DLQ nem plugins — cadastre a URL na Configuração para completar.' },
        ],
      },
      {
        id: 'help-logstash-pipelines', q: 'Pipelines, filas e DLQ',
        summary: 'Um pipeline por linha, por instância — a visão onde os problemas de Logstash realmente aparecem. <strong>Só existe com URL cadastrada</strong>: o self-monitoring traz apenas os totais do nó. Os contadores são acumulados desde o start.',
        data: [
          { label: 'Pipeline', desc: 'Nome do pipeline (o <code>pipeline.id</code> do <code>pipelines.yml</code>; <code>main</code> quando há um só) e a instância abaixo. Quando a versão expõe status por pipeline no health report, um badge verde/amarelo/vermelho aparece ao lado do nome, com o sintoma no tooltip.' },
          { label: 'Workers / batch', desc: '<code>pipeline.workers</code> (threads que executam filtros e saídas, por padrão uma por vCPU) e <code>pipeline.batch.size</code>. São os dois parâmetros de tuning: batch maior melhora a vazão e aumenta o uso de heap.' },
          { label: 'Entrada / Saída', desc: 'Eventos acumulados. Uma diferença grande e crescente indica eventos presos na fila ou perdidos para a DLQ — compare com as colunas <strong>Fila</strong> e <strong>DLQ</strong> da mesma linha.' },
          { label: 'ms/evento', desc: 'Custo médio por evento deste pipeline. É o que permite comparar pipelines de volumes diferentes e o primeiro lugar para olhar quando a vazão não acompanha a ingestão.' },
          { label: 'Fila', desc: 'Tipo (<strong>memória</strong> ou <strong>persistente</strong>) e, na persistente, a ocupação em relação ao <code>queue.max_bytes</code>. O tooltip traz bytes em uso, <strong>espaço livre no disco</strong> e o caminho da fila — a PQ para de aceitar eventos quando o disco enche, mesmo longe do máximo configurado.' },
          { label: 'DLQ', desc: 'Eventos rejeitados definitivamente pelo output deste pipeline, com o tamanho abaixo. O tooltip traz o último erro, o <code>storage_policy</code> e os expirados. Traço significa DLQ vazia ou desativada.' },
          { label: 'Reloads', desc: 'Falhas de recarga de configuração (motivo da última no tooltip) e, abaixo, as recargas bem-sucedidas. Falha aqui = configuração antiga ainda em vigor.' },
        ],
      },
      {
        id: 'help-logstash-plugins', q: 'Plugins mais lentos',
        summary: 'Onde o tempo do pipeline é gasto, somando todos os pipelines de todas as instâncias — a resposta direta para "onde está o gargalo". Ordenado pelo <strong>tempo total</strong> acumulado desde o start.',
        data: [
          { label: 'O que entra', desc: 'Só <strong>filtros</strong> e <strong>saídas</strong>. Um <em>input</em> não tem tempo de processamento — o que ele acumula é espera por dados — e apareceria sempre no topo sem significar nada.' },
          { label: 'Eventos e ms/evento', desc: 'Volume que passou pelo plugin e o custo unitário. Um plugin barato com volume enorme aparece aqui <strong>por volume</strong>; o caro de verdade é o que tem <strong>ms/evento</strong> alto. Suspeitos recorrentes: <code>grok</code> com padrão que faz backtracking, <code>dns</code> e qualquer filtro que faça chamada externa, e outputs esperando pelo destino.' },
          { label: 'Tempo total e % do pipeline', desc: 'Tempo acumulado no plugin e a fração do tempo daquele pipeline que ele representa. Um plugin com 60% do tempo do pipeline é onde vale otimizar; abaixo de 10%, ajustá-lo não muda a vazão.' },
          { label: 'Nomes com hash', desc: 'Plugins sem <code>id</code> explícito na configuração aparecem com o hash gerado pelo Logstash. Nomear os plugins (<code>id =&gt; "..."</code>) é o que torna esta tabela — e o Stack Monitoring — legível.' },
        ],
      },
    ],
  },
];

function renderHelpItem(t) {
  const dataText = [t.q, t.summary, ...t.data.map(d => `${d.label} ${d.desc}`)]
    .join(' ').replace(/<[^>]+>/g, '').toLowerCase();
  const dataList = t.data.length ? `
        <div class="help-data-title">Dados apresentados</div>
        <ul class="help-data-list">
          ${t.data.map(d => `<li><span class="help-data-label">${d.label}</span> — ${d.desc}</li>`).join('')}
        </ul>` : '';
  return `<article class="help-article" id="${t.id}" data-text="${escHtml(dataText)}">
      <h3 class="help-article-title">${t.q}</h3>
      <p class="help-summary">${t.summary}</p>${dataList}
    </article>`;
}

function renderHelp() {
  const container = document.getElementById('helpGroups');
  if (!container) return;

  container.innerHTML = HELP_CONTENT.map(group => `
    <section class="help-section">
      <h2 class="help-section-title"><i class="fas ${group.icon}"></i> ${group.label}</h2>
      ${group.topics.map(renderHelpItem).join('')}
    </section>`).join('');

  const toc = document.getElementById('helpToc');
  if (toc) {
    toc.innerHTML = HELP_CONTENT.map(group => `
      <div class="help-toc-section">
        <span class="help-toc-group">${group.label}</span>
        ${group.topics.map(t => `<span class="help-toc-link" data-target="${t.id}" onclick="goToHelp('${t.id}')">${t.q}</span>`).join('')}
      </div>`).join('');
  }

  setupHelpScrollSpy();
}

// Destaca no índice o tópico atualmente visível durante a rolagem.
let helpScrollSpy = null;
function setupHelpScrollSpy() {
  if (helpScrollSpy) helpScrollSpy.disconnect();
  const root = document.querySelector('.page-scroll');
  const articles = document.querySelectorAll('#helpGroups .help-article');
  if (!root || !articles.length) return;
  helpScrollSpy = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (e.isIntersecting) setActiveTocLink(e.target.id);
    }
  }, { root, rootMargin: '0px 0px -72% 0px', threshold: 0 });
  articles.forEach(a => helpScrollSpy.observe(a));
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
  if (currentPage === 'kibana') return loadKibana();
  if (currentPage === 'logstash') return loadLogstash();
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
// infraestrutura/capacidade, não de disponibilidade do cluster.
function cardSnapshotRunning(d) {
  const snapRun = d.snapshots_running || {};
  let color, valueHtml, unit;
  if (!snapRun.available) {
    color = 'muted'; valueHtml = '&mdash;'; unit = 'indisponível (licença/permissão)';
  } else if ((snapRun.running || 0) > 0) {
    color = 'blue'; valueHtml = fmtNum(snapRun.running); unit = 'snapshot(s) em andamento';
  } else {
    color = 'green'; valueHtml = '0'; unit = 'nenhum em execução agora';
  }
  const tip = 'Snapshots em <strong>criação</strong> neste momento — visão ao vivo de qual backup está rodando, em qual repositório, há quanto tempo e o progresso total (bytes e shards).<br><br>' +
    'Clique para abrir o painel com barra de progresso por snapshot em andamento.';
  return cardStat('openSnapshotModal()', 'Snapshot em Execução', 'fa-camera', valueHtml, unit, color, tip, [], 'help-snapshot-running');
}

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

// Rodapé do card de Saúde: tipo da licença + status, com alerta de expiração.
// Retorna um stat {label, val, color} ou null (licença indisponível).
function licenseFooterStat(license) {
  if (!license || !license.available) return null;
  const type = (license.type || '-').toUpperCase();
  const expired = license.status === 'expired';
  const days = license.days_left;
  let color = 'text';
  let suffix = '';
  if (expired) {
    color = 'red';
    suffix = ' · expirada';
  } else if (days != null && days <= 30) {
    color = days <= 7 ? 'red' : 'yellow';
    suffix = ` · expira em ${days}d`;
  }
  return { label: 'Licença', val: `${escHtml(type)}${suffix}`, color };
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
  const lic = licenseFooterStat(license);
  if (lic) stats.push(lic);

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
    // FROZEN fica fora: o disco desses nós é cache, não capacidade (ver isDedicatedFrozen).
    // Somá-lo daria um tier permanentemente "cheio" ao lado de tiers reais.
    if (t === 'FROZEN') continue;
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
  const order = ['HOT', 'WARM', 'COLD'].filter(t => tiers[t]);
  const tip = 'Capacidade de disco por <strong>tier de dados</strong> (HOT / WARM / COLD), somando todos os data nodes de cada tier.<br><br>' +
    'Em cada barra, o trilho <strong>cinza</strong> é a capacidade <strong>total</strong> do tier e o preenchimento <strong>colorido</strong> mostra o quanto está em uso. O <strong>% de uso</strong> fica à direita e os volumes (usado · total · livre) logo abaixo da barra.<br><br>' +
    'Cor por uso: amarelo a partir de <strong>70%</strong>, vermelho a partir de <strong>85%</strong>. Watermarks padrão do ES: low 85% / high 90% / flood 95%.<br><br>' +
    '<strong>FROZEN não entra:</strong> ' + FROZEN_DISK_NOTE;
  const body = order.length
    ? `<div class="tier-disk-list">${order.map(t => tierDiskRow(t, tiers[t])).join('')}</div>`
    : `<div class="empty-state" style="padding:16px"><i class="fas fa-circle-info"></i><p>Sem dados de disco por tier — nenhum data node com role de tier (<code>data_hot/warm/cold</code>) reportou capacidade. Nós <strong>frozen</strong> não entram: o disco deles é cache de searchable snapshots.</p></div>`;
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
  const frozen = isDedicatedFrozen(n.roles);
  // A caixinha é pequena demais para a explicação: ela vai no title (a modal do
  // nó, que abre no clique, traz o texto completo).
  const titleAttr = rolesTitle(n.roles, isMaster) + (frozen ? ` — ${FROZEN_DISK_NOTE_TEXT}` : '');
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
      ${frozen
        ? `<div class="topo-metric-row">
             <span class="topo-metric-label">Disco</span>
             <span class="topo-metric-na">— cache frozen</span>
           </div>`
        : metricRow('Disco', n.disk_used_percent)}
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
      'Soma do tamanho em disco de todos os índices (primários + réplicas, incluindo índices de sistema). ' +
      'No rodapé, o total de <strong>documentos indexados</strong>: a soma de <code>docs.count</code>, ' +
      'que não conta os documentos marcados para exclusão ainda não expurgados por merge.',
      [{ label: 'Documentos', val: fmtNum(d.total_docs || 0), color: null }], 'help-data-volume'),
    cardCount('all_indices', 'Total de Índices', 'fa-layer-group', d.total_indices,
      'índices', 'blue', 'blue',
      'Contagem total de índices do cluster, incluindo índices de sistema (prefixo <code>.</code>). Uma contagem elevada pode impactar o desempenho — avalie o uso de data streams para séries temporais. Clique para listar todos os índices.',
      [],
      'Todos os Índices', 'help-total-indices'),
    cardSnapshotRunning(d),
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
      <td>${isDedicatedFrozen(n.roles) ? frozenDiskMark() : pctBar(n.disk_used_percent)}</td>
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
  cluster_settings: {
    filename: 'Configurações de Cluster de Risco',
    extract: r => ({
      severidade: r.severity,
      escopo: r.scope,
      configuração: r.key,
      valor: r.value,
      motivo: r.message,
    }),
  },
  deprecations: {
    filename: 'Deprecations',
    extract: r => ({
      nível: r.level,
      categoria: r.category_label,
      recurso: r.resource,
      aviso: r.message,
      detalhes: r.details,
      documentação: r.url,
    }),
  },
  allocation_explain: {
    filename: 'Diagnóstico de Alocação',
    extract: r => ({
      índice: r.index,
      shard: r.shard,
      tipo: r.primary ? 'primário' : 'réplica',
      motivo: r.reason,
      pode_alocar: r.can_allocate,
      diagnóstico: r.explanation,
      deciders: (r.decider_messages || []).join(' | '),
    }),
  },
  slm_policies: {
    filename: 'Políticas de Snapshot (SLM)',
    extract: r => ({
      política: r.name,
      estado: r.state,
      repositório: r.repository,
      agendamento: r.schedule,
      último_sucesso: r.last_success_time ? fmtMillisDate(r.last_success_time) : '-',
      último_snapshot: r.last_success_snapshot,
      última_falha: r.last_failure_time ? fmtMillisDate(r.last_failure_time) : '-',
      motivo_da_falha: r.last_failure_reason,
      próxima_execução: r.next_execution_millis ? fmtMillisDate(r.next_execution_millis) : '-',
      snapshots_tirados: r.snapshots_taken,
      snapshots_falhos: r.snapshots_failed,
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
      <button class="btn btn-ghost shards-notice-btn" onclick="openDetail('allocation_explain','Diagnóstico de Alocação','Por que cada shard não aloca')"><i class="fas fa-arrow-right"></i> Ver diagnóstico</button>
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
const SNAPSHOT_STATES = {
  STARTED:      { label: 'Iniciado',      desc: 'Snapshot registrado e aceito, aguardando o início da transferência de dados para o repositório.' },
  IN_PROGRESS:  { label: 'Em progresso',  desc: 'Copiando dados dos shards para o repositório. Este é o estado esperado durante a maior parte da execução.' },
  SUCCESS:      { label: 'Concluído',     desc: 'Snapshot finalizado com sucesso — todos os shards foram copiados para o repositório.' },
  FAILED:       { label: 'Falhou',        desc: 'Ocorreu um erro durante a criação do snapshot. Verifique os logs do nó master e o estado do repositório.' },
  ABORTED:      { label: 'Abortado',      desc: 'Snapshot cancelado (via API DELETE) antes de ser concluído.' },
  MISSING:      { label: 'Ausente',       desc: 'Snapshot não encontrado no repositório configurado — pode ter sido excluído externamente.' },
  INCOMPATIBLE: { label: 'Incompatível',  desc: 'Snapshot criado em uma versão do Elasticsearch incompatível com a versão atual do cluster.' },
};

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
  cluster_settings: tableClusterSettings,
  deprecations: tableDeprecations,
  allocation_explain: tableAllocationExplain,
  slm_policies: tableSlmPolicies,
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

const SEVERITY_BADGE = { red: 'badge-red', yellow: 'badge-yellow', blue: 'badge-blue' };
const SCOPE_BADGE = { persistent: 'badge-blue', transient: 'badge-yellow' };

function tableClusterSettings(rows) {
  return `<table class="data-table">
    <thead><tr>
      <th data-col="severity">Severidade <span class="sort-icon">↕</span></th>
      <th data-col="scope">Escopo <span class="sort-icon">↕</span></th>
      <th data-col="key">Configuração <span class="sort-icon">↕</span></th>
      <th data-col="value">Valor <span class="sort-icon">↕</span></th>
      <th data-col="message">Por que importa</th>
    </tr></thead>
    <tbody>${rows.map(r => `<tr>
      <td><span class="badge ${SEVERITY_BADGE[r.severity] || 'badge-gray'}">${r.severity === 'red' ? 'Crítico' : r.severity === 'yellow' ? 'Atenção' : 'Info'}</span></td>
      <td><span class="badge ${SCOPE_BADGE[r.scope] || 'badge-gray'}">${escHtml(r.scope)}</span></td>
      <td style="font-family:monospace;font-size:12px">${escHtml(r.key)}</td>
      <td style="font-family:monospace;font-size:12px;font-weight:600">${escHtml(r.value)}</td>
      <td style="color:var(--text-muted);font-size:12px;max-width:520px;white-space:normal">${escHtml(r.message)}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

const DEP_LEVEL_BADGE = { critical: 'badge-red', warning: 'badge-yellow' };

function tableDeprecations(rows) {
  return `<table class="data-table">
    <thead><tr>
      <th data-col="level">Nível <span class="sort-icon">↕</span></th>
      <th data-col="category_label">Categoria <span class="sort-icon">↕</span></th>
      <th data-col="resource">Recurso <span class="sort-icon">↕</span></th>
      <th data-col="message">Aviso</th>
    </tr></thead>
    <tbody>${rows.map(r => {
      const details = r.details ? `<div style="color:var(--text-dim);font-size:11px;margin-top:4px">${escHtml(r.details)}</div>` : '';
      const url = r.url ? `<a href="${escHtml(r.url)}" target="_blank" rel="noopener" style="color:var(--blue);font-size:11px;margin-top:4px;display:inline-block"><i class="fas fa-up-right-from-square"></i> Documentação</a>` : '';
      return `<tr>
      <td><span class="badge ${DEP_LEVEL_BADGE[r.level] || 'badge-gray'}">${r.level === 'critical' ? 'Crítico' : 'Aviso'}</span></td>
      <td><span class="badge badge-blue">${escHtml(r.category_label)}</span></td>
      <td style="font-family:monospace;font-size:12px">${escHtml(r.resource)}</td>
      <td style="max-width:560px;white-space:normal"><div>${escHtml(r.message)}</div>${details}${url}</td>
    </tr>`;
    }).join('')}</tbody>
  </table>`;
}

function tableAllocationExplain(rows) {
  return `<table class="data-table">
    <thead><tr>
      <th data-col="index">Índice <span class="sort-icon">↕</span></th>
      <th data-col="shard" data-type="num">Shard <span class="sort-icon">↕</span></th>
      <th data-col="primary">Tipo <span class="sort-icon">↕</span></th>
      <th data-col="reason">Motivo <span class="sort-icon">↕</span></th>
      <th data-col="can_allocate">Pode Alocar <span class="sort-icon">↕</span></th>
      <th data-col="explanation">Diagnóstico</th>
      <th></th>
    </tr></thead>
    <tbody>${rows.map(r => {
      const deciders = (r.decider_messages || []).length
        ? `<ul style="margin:6px 0 0;padding-left:16px;color:var(--text-dim);font-size:11px">${r.decider_messages.map(m => `<li>${escHtml(m)}</li>`).join('')}</ul>`
        : '';
      const canColor = r.can_allocate === 'yes' ? 'green' : (r.can_allocate === 'no' ? 'red' : 'yellow');
      return `<tr class="task-row" data-idx="${escHtml(r.index)}" data-shard="${escHtml(r.shard)}" data-pri="${escHtml(r.primary)}" onclick="showAllocationJson(this.dataset.idx, this.dataset.shard, this.dataset.pri)">
      <td style="font-family:monospace;font-size:12px"><span class="index-link" data-index="${escHtml(r.index)}" onclick="event.stopPropagation();openIndexShards(this.dataset.index)">${escHtml(r.index)}</span></td>
      <td style="font-weight:700;color:var(--text-muted)">${r.shard ?? '-'}</td>
      <td>${shardTypeBadge(r.primary ? 'p' : 'r')}</td>
      <td><span class="badge badge-gray">${escHtml(r.reason)}</span></td>
      <td><span class="badge badge-${canColor}">${escHtml(r.can_allocate)}</span></td>
      <td style="max-width:560px;white-space:normal;font-size:12px"><div>${escHtml(r.explanation)}</div>${deciders}</td>
      <td style="text-align:right;color:var(--text-dim)" title="Ver JSON completo"><i class="fas fa-code"></i></td>
    </tr>`;
    }).join('')}</tbody>
  </table>`;
}

function showAllocationJson(idx, shard, pri) {
  const row = currentRows.find(r =>
    r.index === idx && String(r.shard) === String(shard) && String(r.primary) === String(pri));
  if (!row) return;
  showJsonModal('Diagnóstico de Alocação', `${idx} [shard ${shard}]`, row.raw || row);
}

const SLM_STATE_BADGE = { ok: ['badge-green', 'OK'], failed: ['badge-red', 'Falha'], never: ['badge-gray', 'Nunca executou'] };

function slmStateBadge(state) {
  const [cls, label] = SLM_STATE_BADGE[state] || ['badge-gray', state || '-'];
  return `<span class="badge ${cls}">${label}</span>`;
}

function tableSlmPolicies(rows) {
  return `<table class="data-table">
    <thead><tr>
      <th data-col="name">Política <span class="sort-icon">↕</span></th>
      <th data-col="state">Estado <span class="sort-icon">↕</span></th>
      <th data-col="repository">Repositório <span class="sort-icon">↕</span></th>
      <th data-col="last_success_time" data-type="num">Último Sucesso <span class="sort-icon">↕</span></th>
      <th data-col="last_failure_time" data-type="num">Última Falha <span class="sort-icon">↕</span></th>
      <th data-col="next_execution_millis" data-type="num">Próx. Execução <span class="sort-icon">↕</span></th>
      <th data-col="snapshots_taken" data-type="num">Snapshots <span class="sort-icon">↕</span></th>
    </tr></thead>
    <tbody>${rows.map(r => {
      const success = r.last_success_time
        ? `<span style="color:var(--green)">${fmtMillisDate(r.last_success_time)}</span>`
        : '<span style="color:var(--text-dim)">—</span>';
      const successTitle = r.last_success_time && r.last_success_snapshot && r.last_success_snapshot !== '-'
        ? ` title="Snapshot: ${escHtml(r.last_success_snapshot)}"` : '';
      const failure = r.last_failure_time
        ? `<span style="color:var(--red)">${fmtMillisDate(r.last_failure_time)}</span>`
        : '<span style="color:var(--text-dim)">—</span>';
      const failureTitle = r.last_failure_time && r.last_failure_reason && r.last_failure_reason !== '-'
        ? ` title="${escHtml(r.last_failure_reason)}"` : '';
      const snaps = `<span style="color:var(--green)">${fmtNum(r.snapshots_taken)}</span>${r.snapshots_failed > 0 ? ` / <span style="color:var(--red)">${fmtNum(r.snapshots_failed)}</span>` : ''}`;
      return `<tr class="task-row" data-name="${escHtml(r.name)}" onclick="showSlmJson(this.dataset.name)">
        <td style="font-family:monospace;font-size:12px;font-weight:600">${escHtml(r.name)}${r.in_progress ? ' <span class="badge badge-blue" style="font-size:10px">em execução</span>' : ''}</td>
        <td>${slmStateBadge(r.state)}</td>
        <td style="font-family:monospace;font-size:12px">${escHtml(r.repository)}</td>
        <td style="font-size:12px"${successTitle}>${success}</td>
        <td style="font-size:12px"${failureTitle}>${failure}</td>
        <td style="font-size:12px;color:var(--text-muted)">${r.next_execution_millis ? fmtMillisDate(r.next_execution_millis) : '—'}</td>
        <td style="font-size:12px">${snaps}</td>
      </tr>`;
    }).join('')}</tbody>
  </table>`;
}

function showSlmJson(name) {
  const row = currentRows.find(r => r.name === name);
  if (!row) return;
  showJsonModal('Detalhes da Política SLM', name, row.raw || row);
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

// Nó dedicado ao tier frozen. O disco desses nós NÃO é capacidade de armazenamento:
// é o cache local dos searchable snapshots (xpack.searchable.snapshot.shared_cache.size),
// pré-alocado num tamanho fixo e mantido cheio pelo ES. Fica perto de 100% em operação
// normal, mesmo com o repositório inteiro à disposição — ler isso como "disco no limite"
// é falso alarme. Por isso o disco é omitido das visões de capacidade destes nós.
const NON_FROZEN_DATA_ROLES = ['data', 'data_hot', 'data_warm', 'data_cold', 'data_content'];
function isDedicatedFrozen(roles) {
  const r = Array.isArray(roles) ? roles : [];
  return r.includes('data_frozen') && !NON_FROZEN_DATA_ROLES.some(x => r.includes(x));
}

// Texto único da explicação acima, reaproveitado em todo ponto que omite o disco.
const FROZEN_DISK_NOTE = 'Nós do tier <strong>frozen</strong> não expõem capacidade de armazenamento: ' +
  'o disco local é o <strong>cache dos searchable snapshots</strong>, de tamanho fixo e mantido cheio ' +
  'pelo Elasticsearch. Os dados ficam no repositório de snapshots. O percentual reflete a ocupação ' +
  'desse cache — <strong>não</strong> falta de espaço.';
// Mesma explicação sem marcação, para atributos title="" (caixinha da topologia).
const FROZEN_DISK_NOTE_TEXT = FROZEN_DISK_NOTE.replace(/<[^>]+>/g, '');

// Marca que substitui a barra de disco de um nó frozen em tabelas e cards.
function frozenDiskMark() {
  return `<div class="tooltip-wrap" style="display:inline-flex;align-items:center;gap:6px;cursor:help">
    <span style="color:var(--text-dim)">—</span>
    <span style="font-size:11px;color:var(--text-dim)">cache frozen</span>
    <div class="tooltip-box" style="width:340px;font-weight:400;text-transform:none;letter-spacing:0">${FROZEN_DISK_NOTE}</div>
  </div>`;
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
    // Nó frozen opera com o cache cheio por design: alertaria sempre, e o texto
    // ("flood-stage", "read-only") seria falso — não há watermark sobre cache.
    if (isDedicatedFrozen(n.roles)) continue;
    (byTier[tier] = byTier[tier] || []).push(n);
  }
  for (const tier of ['HOT', 'WARM', 'COLD']) {
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
    .filter(n => (n.disk_used_percent ?? 0) >= 70 && !isDedicatedFrozen(n.roles))
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

// ─── Modal: Snapshots em Execução ────────────────────────
function openSnapshotModal() {
  document.getElementById('snapshotModalBody').innerHTML =
    `<div class="loading-state section-loading"><i class="fas fa-circle-notch fa-spin"></i><span>Carregando...</span></div>`;
  document.getElementById('snapshotModal').style.display = 'flex';
  document.body.style.overflow = 'hidden';
  loadSnapshots();
}

function closeSnapshotModal() {
  document.getElementById('snapshotModal').style.display = 'none';
  document.body.style.overflow = '';
}

async function loadSnapshots() {
  const body = document.getElementById('snapshotModalBody');
  if (!body) return;
  try {
    const res = await fetch('/api/snapshots');
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    renderSnapshots(data);
  } catch (e) {
    body.innerHTML = `<div class="error-state"><i class="fas fa-triangle-exclamation"></i><p>${e.message}</p></div>`;
  }
}

function renderSnapshots(rows) {
  const body = document.getElementById('snapshotModalBody');
  if (!body) return;

  if (!rows || rows.length === 0) {
    body.innerHTML = `<div class="empty-state" style="padding:28px 16px">
      <i class="fas fa-circle-check"></i>
      <p>Nenhum snapshot em execução no momento.</p></div>`;
    return;
  }

  body.innerHTML = `<div class="recovery-list">${rows.map(r => {
    const pct = Math.min(100, Math.max(0, r.percent || 0));
    const fillColor = pct >= 100 ? 'green' : 'blue';
    const stateMeta = SNAPSHOT_STATES[r.state] || { label: r.state || 'Em andamento', desc: '' };
    const stateTitle = `Estado: ${r.state}${stateMeta.desc ? ` — ${stateMeta.desc}` : ''}`;
    const failedNote = r.shards_failed > 0
      ? ` · <span style="color:var(--red)">${fmtNum(r.shards_failed)} falharam</span>`
      : '';
    return `
      <div class="recovery-item">
        <div class="recovery-head">
          <span class="recovery-index">${escHtml(r.snapshot)}</span>
          <span class="recovery-shard">repo: ${escHtml(r.repository)}</span>
          <span class="recovery-op" title="${escHtml(stateTitle)}">${stateMeta.label}</span>
          <span class="recovery-time"><i class="far fa-clock"></i> ${r.time_ms ? fmtDuration(r.time_ms) : '—'}</span>
        </div>
        <div class="recovery-progress">
          <div class="recovery-track"><div class="recovery-fill" style="width:${pct}%;background:var(--${fillColor})"></div></div>
          <span class="recovery-pct">${pct.toFixed(1)}%</span>
          <span class="recovery-bytes">${formatBytes(r.bytes_processed)} / ${formatBytes(r.bytes_total)}</span>
        </div>
        <div class="recovery-sub">
          <span>Shards ${fmtNum(r.shards_done)} / ${fmtNum(r.shards_total)}${failedNote}</span>
          <span>${fmtNum(r.indices_count)} índice(s) / data stream(s)</span>
        </div>
      </div>`;
  }).join('')}</div>`;
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
      <td>${isDedicatedFrozen(r.roles)
        ? frozenDiskMark()
        : `<div style="display:flex;align-items:center;gap:10px">
        <div style="flex:1;min-width:90px">${pctBar(r['disk.used_percent'])}</div>
        <span style="flex-shrink:0;width:120px;color:var(--text-muted);font-variant-numeric:tabular-nums;white-space:nowrap">${r['disk.used'] || '-'} / ${r['disk.total'] || '-'}</span>
      </div>`}</td>
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
  // Em nó frozen o uso do disco é a ocupação do cache, não capacidade — mostrar a
  // barra aqui induziria à leitura de "disco cheio". Explica em vez de medir.
  const frozenNode = isDedicatedFrozen(id.roles);
  const dskRows = frozenNode ? [
    `<div class="nd-note"><i class="fas fa-snowflake"></i><span>${FROZEN_DISK_NOTE}</span></div>`,
  ] : [
    dsk.total ? pctRow('Uso geral', dg.pct,
      `${singleType ? fsTypeTag(singleType) + ' · ' : ''}${formatBytes(dg.used ?? 0)} de ${formatBytes(dsk.total)} · livre ${formatBytes(dg.avail ?? 0)}`) : '',
  ];
  if (showMounts && !frozenNode) {
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

// ═══════════════ INTEGRAÇÕES (KIBANA E LOGSTASH) ═══════════
// As duas páginas têm fonte própria (/api/<integração>/dashboard) e não
// dependem do dashboardData do cluster; a Configuração edita as duas no mesmo
// formato. Ver docs/kibana.md e docs/logstash.md.

// Metadados por integração: o que muda entre elas está todo aqui, e o resto do
// código (nav, config, teste de URL, salvamento) é comum.
const INTEGRATIONS = {
  kibana: {
    label: 'Kibana',
    icon: 'fa-chart-line',
    urlPlaceholder: 'https://kibana.exemplo:5601',
    helpTopic: 'help-kibana-config',
    // A API do Kibana sempre exige credencial.
    userRequired: true,
    switchDesc: 'Monitoramento das instâncias de Kibana desta conexão. Desativado, o item some da barra lateral e nenhuma consulta é feita.',
    switchTip: 'Ativa a página <strong>Kibana</strong> na barra lateral. As instâncias são descobertas automaticamente pelo <strong>self-monitoring</strong> do cluster conectado; as URLs cadastradas aqui acrescentam o que só a API do Kibana entrega: <strong>Task Manager</strong>, <strong>Fleet</strong> e <strong>APM Server</strong>.',
    accessDesc: 'Credenciais usadas nas chamadas à API do Kibana. Todas as instâncias usam o mesmo usuário e senha.',
    instancesDesc: 'URLs de cada Kibana do ambiente. O botão <strong>Testar</strong> valida a URL sem gravar nada.',
    emptyInstances: 'Nenhuma instância cadastrada. Sem URL, a página Kibana ainda funciona com o que vier do <strong>self-monitoring</strong> — mas fica sem Task Manager, Fleet e APM Server.',
  },
  logstash: {
    label: 'Logstash',
    icon: 'fa-diagram-project',
    urlPlaceholder: 'http://logstash.exemplo:9600',
    helpTopic: 'help-logstash-config',
    // A API de monitoramento do Logstash é aberta por padrão
    // (`api.auth.type: none`): exigir usuário barraria o caso mais comum.
    userRequired: false,
    switchDesc: 'Monitoramento das instâncias de Logstash desta conexão. Desativado, o item some da barra lateral e nenhuma consulta é feita.',
    switchTip: 'Ativa a página <strong>Logstash</strong> na barra lateral. As instâncias são descobertas pelo <strong>self-monitoring</strong> do cluster conectado; as URLs cadastradas aqui acrescentam o que só a API de monitoramento entrega: <strong>pipelines</strong>, <strong>filas</strong>, <strong>DLQ</strong> e o custo por <strong>plugin</strong>.',
    accessDesc: 'Credenciais da API de monitoramento (porta 9600). <strong>Opcionais</strong>: a API é aberta por padrão — preencha só se o ambiente tiver <code>api.auth.type: basic</code>.',
    instancesDesc: 'URLs da API de monitoramento de cada Logstash — normalmente <code>http://host:9600</code>. O botão <strong>Testar</strong> valida a URL sem gravar nada.',
    emptyInstances: 'Nenhuma instância cadastrada. Sem URL, a página Logstash só mostra o que vier do <strong>self-monitoring</strong> — fica sem pipelines, filas, DLQ e plugins.',
  },
};

// Estado por integração: config salva, draft em edição e último dashboard.
const integrationConfig = { kibana: null, logstash: null };
const integrationDraft = { kibana: null, logstash: null };
const integrationData = { kibana: null, logstash: null };

// Rótulo da origem de cada métrica, exibido no title da célula. A precedência
// é resolvida no backend, por métrica.
const SOURCE_LABELS = {
  kibana: {
    agent: 'Elastic Agent (metrics-system.*)',
    monitoring: 'Self-monitoring (.monitoring-kibana-*)',
    api: 'API do Kibana (/api/stats)',
  },
  logstash: {
    agent: 'Elastic Agent (metrics-system.*)',
    monitoring: 'Self-monitoring (.monitoring-logstash-*)',
    api: 'API do Logstash (/_node/stats)',
  },
};

// Motivo da ausência de fonte, por métrica que não existe em toda fonte.
// Traço em vez de zero: ausência de dado não é dado zerado.
const NO_AGENT_HINT = 'Sem fonte: CPU e disco vêm da integração "system" do ' +
  'Elastic Agent no host desta instância. A API do Kibana não expõe esses dados.';
const LS_NO_AGENT_HINT = 'Sem fonte: RAM e disco são do host e vêm da integração ' +
  '"system" do Elastic Agent. A API do Logstash não expõe nenhum dos dois.';
const LS_NO_API_HINT = 'Sem fonte: esta métrica vem da API de monitoramento do ' +
  'Logstash (/_node/stats) ou do self-monitoring do cluster.';

const SERVICE_STATUS_BADGE = {
  green: ['badge-green', 'Disponível'],
  available: ['badge-green', 'Disponível'],
  yellow: ['badge-yellow', 'Degradado'],
  degraded: ['badge-yellow', 'Degradado'],
  red: ['badge-red', 'Crítico'],
  critical: ['badge-red', 'Crítico'],
  unavailable: ['badge-red', 'Indisponível'],
  unknown: ['badge-gray', 'desconhecido'],
};

// Status considerado saudável nas duas páginas (Kibana usa 'available', o
// health report do Logstash usa 'green').
const HEALTHY_STATUS = ['green', 'available'];

function serviceStatusBadge(status) {
  const [cls, label] = SERVICE_STATUS_BADGE[status] || ['badge-gray', status || 'desconhecido'];
  return `<span class="badge ${cls}">${escHtml(label)}</span>`;
}

// Célula percentual com a origem no tooltip nativo; traço quando não há fonte.
function svcMetricCell(key, metric, emptyHint) {
  if (!metric || metric.value == null) {
    return `<span class="kb-no-source" title="${escHtml(emptyHint || 'Sem dado disponível')}">&mdash;</span>`;
  }
  const src = SOURCE_LABELS[key][metric.source] || metric.source;
  return `<div title="Fonte: ${escHtml(src)}">${pctBar(metric.value)}</div>`;
}

function svcNumCell(key, metric, suffix, digits = 1) {
  if (!metric || metric.value == null) return '<span class="kb-no-source">&mdash;</span>';
  const src = SOURCE_LABELS[key][metric.source] || metric.source;
  const val = Number(metric.value).toFixed(digits).replace(/\.0+$/, '');
  return `<span title="Fonte: ${escHtml(src)}">${val}${suffix || ''}</span>`;
}

async function fetchIntegrationConfig(key) {
  const res = await fetch(`/api/${key}/config`);
  if (res.status === 401) { location.reload(); throw new Error('unauthorized'); }
  integrationConfig[key] = await res.json();
  return integrationConfig[key];
}

// Mostra/esconde o item da sidebar conforme a integração está ativa.
function applyIntegrationNav(key) {
  const nav = document.getElementById('nav-' + key);
  const cfg = integrationConfig[key];
  if (nav) nav.style.display = (cfg && cfg.enabled) ? '' : 'none';
}

// Carrega a config das duas integrações e aplica a sidebar. Falha em uma não
// pode impedir a outra — nem o dashboard do cluster — de funcionar.
function loadIntegrations() {
  for (const key of Object.keys(INTEGRATIONS)) {
    fetchIntegrationConfig(key).then(() => applyIntegrationNav(key)).catch(() => {});
  }
}

// Zera o estado das integrações ao trocar de cluster (a config é por conexão).
function resetIntegrations() {
  for (const key of Object.keys(INTEGRATIONS)) {
    integrationConfig[key] = integrationDraft[key] = integrationData[key] = null;
  }
}

// Busca o dashboard de uma integração e delega a renderização ao `render`.
async function loadIntegrationPage(key, render) {
  const page = document.getElementById('page-' + key);
  const icon = document.getElementById('refreshIcon');
  if (icon) icon.classList.add('spin');
  page.innerHTML = `<div class="loading-state">
    <i class="fas fa-circle-notch fa-spin"></i>
    <span>Carregando dados do ${INTEGRATIONS[key].label}...</span>
  </div>`;

  try {
    const res = await fetch(`/api/${key}/dashboard`);
    if (res.status === 401) { location.reload(); return; }
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    integrationData[key] = data;
    render(data);
    document.getElementById('lastUpdated').textContent =
      'Atualizado: ' + new Date().toLocaleTimeString('pt-BR');
  } catch (e) {
    page.innerHTML = `<div class="error-state">
      <i class="fas fa-triangle-exclamation"></i>
      <p>${escHtml(e.message)}</p>
    </div>`;
  } finally {
    if (icon) icon.classList.remove('spin');
  }
}

// Empty-state comum: nenhuma instância encontrada por nenhuma fonte.
function integrationEmptyState(key, hasUrls, extra) {
  const meta = INTEGRATIONS[key];
  return `<div class="empty-state" style="padding:40px">
    <i class="fas ${meta.icon}"></i>
    <p>Nenhuma instância ${meta.label} encontrada.</p>
    <p style="font-size:13px;color:var(--text-dim);max-width:520px;margin:8px auto 0">
      ${hasUrls
        ? 'As URLs cadastradas não responderam e não há dados de self-monitoring recentes neste cluster.'
        : extra}
    </p>
    <button class="btn btn-ghost btn-sm" style="margin-top:14px" onclick="showPage('config')">
      <i class="fas fa-sliders"></i> Abrir Configuração
    </button>
  </div>`;
}

// Card "Instâncias Saudáveis", igual nas duas páginas: proporção de instâncias
// disponíveis, com versões e inacessíveis no rodapé.
function healthyInstancesCard(d, key, tip) {
  const instances = d.instances || [];
  const healthy = instances.filter(i => HEALTHY_STATUS.includes(i.status)).length;
  const allOk = healthy === instances.length;
  const statusColor = instances.length === 0 ? 'muted' : (allOk ? 'green' : 'yellow');
  const unreachable = instances.filter(i => i.configured && !i.reachable).length;
  const versions = d.versions || [];
  // Mais de uma versão indica upgrade em andamento ou incompleto — instâncias
  // em versões diferentes divergem de comportamento.
  const versionStat = versions.length
    ? [{
        label: versions.length > 1 ? 'Versões' : 'Versão',
        val: escHtml(versions.join(' · ')),
        color: versions.length > 1 ? 'yellow' : null,
      }]
    : [];

  return cardStat(null, 'Instâncias Saudáveis', 'fa-circle-check',
    `${healthy}/${instances.length}`, allOk ? 'todas disponíveis' : 'alguma degradada',
    statusColor, tip,
    [
      ...versionStat,
      ...(unreachable > 0 ? [{ label: 'Inacessíveis', val: fmtNum(unreachable), color: 'red' }] : []),
    ],
    `help-${key}-instances`);
}

// Coluna de identificação da instância: nome + versão/host e as marcações de
// "inacessível" (URL cadastrada que não respondeu) e "só self-monitoring".
function instanceNameCell(inst) {
  const offline = inst.configured && !inst.reachable;
  const sub = [inst.version, inst.host].filter(Boolean).map(escHtml).join(' · ');
  const errorNote = offline
    ? `<div class="kb-inst-error" title="${escHtml(inst.error || '')}"><i class="fas fa-triangle-exclamation"></i> inacessível</div>`
    : '';
  const noUrlNote = !inst.configured
    ? '<div class="kb-inst-note" title="Descoberta pelo self-monitoring. Cadastre a URL para ver o que só a API entrega.">só self-monitoring</div>'
    : '';
  return `<div class="kb-inst-name">${escHtml(inst.name || '(sem nome)')}</div>
    ${sub ? `<div class="kb-inst-sub">${sub}</div>` : ''}
    ${errorNote}${noUrlNote}`;
}

// Card de largura total com uma tabela — o formato das tabelas das duas páginas.
function tableCard(icon, title, tip, topic, head, rows) {
  return `<div class="metric-card metric-card-static card-full">
    <div class="card-header">
      <div class="card-icon-title">
        <div class="card-icon"><i class="fas ${icon}"></i></div>
        <div class="card-title">${title}</div>
      </div>
      ${tip ? tooltip(tip, topic) : ''}
    </div>
    <div class="resource-table-wrap">
      <table class="data-table resource-table">
        <thead><tr>${head}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`;
}

// ═══════════════════ KIBANA ════════════════════════════════
function loadKibana() {
  return loadIntegrationPage('kibana', renderKibana);
}

function renderKibana(d = integrationData.kibana) {
  const page = document.getElementById('page-kibana');
  if (!page || !d) return;

  if (!d.instances.length) {
    page.innerHTML = integrationEmptyState('kibana', d.has_urls,
      'Cadastre a URL de uma instância na <strong>Configuração</strong>, ou habilite o self-monitoring do Kibana para que as instâncias sejam descobertas automaticamente.');
    return;
  }

  page.innerHTML = `<div class="metrics-grid">
    ${section('Visão Geral')}
    <!-- auto-fit em vez das 4 colunas fixas: são 3 cards e o grid rígido deixaria buraco -->
    <div class="section-signals-cards">${kibanaOverviewCards(d)}</div>

    ${section('Utilização por Instância')}
    ${kibanaInstancesTable(d)}

    ${kibanaTaskManagerSection(d)}
    ${kibanaFleetSection(d)}
  </div>`;
}

function kibanaOverviewCards(d) {
  const tip = 'Instâncias cujo status geral é <strong>disponível</strong>. O status vem do ' +
    '<code>/api/status</code> quando a URL está cadastrada; caso contrário, do self-monitoring.<br><br>' +
    'O rodapé traz a <strong>versão</strong> das instâncias — quando aparece mais de uma, fica ' +
    '<span style="color:var(--yellow)">amarela</span>: é sinal de upgrade em andamento ou incompleto.';

  return [
    healthyInstancesCard(d, 'kibana', tip),
    kibanaFleetCard(d.fleet || {}),
    kibanaApmCard(d.apm || {}),
  ].join('');
}

// Card da frota do Fleet: total de agentes com o detalhamento por estado no
// rodapé — online, offline, error e updating.
function kibanaFleetCard(fleet) {
  const tip = 'Resumo da frota de <strong>Elastic Agents</strong> gerenciada pelo Fleet ' +
    '(<code>/api/fleet/agent_status</code>). Os estados usam os mesmos rótulos da <strong>UI do ' +
    'Fleet</strong>.<br><br>' +
    '<strong>Healthy</strong>: agentes com check-in recente e sem problema. ' +
    '<strong>Unhealthy</strong>: agente rodando mas com erro ou degradado (política inválida, ' +
    'integração quebrada, permissão insuficiente). <strong>Offline</strong>: sem check-in há pelo ' +
    'menos 5 minutos — host desligado, rede ou agente parado. ' +
    '<strong>Updating</strong>: aplicando política, atualizando o binário ou concluindo ' +
    'enrollment.<br><br>' +
    'Exige a URL de uma instância cadastrada e o privilégio <code>fleet-agents-read</code>.';

  if (!fleet.available) {
    return cardStat(null, 'Fleet — Agentes', 'fa-satellite-dish', '&mdash;',
      fleet.error ? 'indisponível' : 'não configurado', 'muted',
      tip + (fleet.error ? `<br><br><strong>Motivo:</strong> ${escHtml(fleet.error)}` : ''),
      [], 'help-kibana-fleet');
  }

  return cardStat(null, 'Fleet — Agentes', 'fa-satellite-dish', fmtNum(fleet.total || 0),
    ...agentSummary(fleet), tip, agentFooterStats(fleet), 'help-kibana-fleet');
}

// Legenda + cor compartilhadas pelos cards de Fleet e APM Server.
// Retorna [unidade, cor] para o cardStat.
function agentSummary(a) {
  const problem = (a.offline || 0) + (a.unhealthy || 0);
  const color = a.unhealthy > 0 ? 'red' : (a.offline > 0 ? 'yellow' : 'green');
  return [problem > 0 ? `${fmtNum(problem)} fora de operação` : 'todos operacionais', color];
}

// Rodapé no vocabulário da UI do Fleet (Healthy / Unhealthy / Offline / Updating).
function agentFooterStats(a) {
  return [
    { label: 'Healthy', val: fmtNum(a.healthy || 0), color: 'green' },
    { label: 'Unhealthy', val: fmtNum(a.unhealthy || 0), color: a.unhealthy > 0 ? 'red' : null },
    { label: 'Offline', val: fmtNum(a.offline || 0), color: a.offline > 0 ? 'yellow' : null },
    { label: 'Updating', val: fmtNum(a.updating || 0), color: a.updating > 0 ? 'blue' : null },
  ];
}

// APM Server pela ótica do Fleet: agentes que rodam a integração `apm`.
function kibanaApmCard(apm) {
  const tip = 'Saúde do <strong>APM Server</strong> vista pelo Fleet: agentes que executam a ' +
    'integração <code>apm</code>. Descobre as package policies do pacote e conta os agentes de ' +
    'cada agent policy que a contém.<br><br>' +
    'Mede a <strong>disponibilidade do coletor</strong> — se ele está de pé para receber dados dos ' +
    'agentes APM das aplicações. Não analisa os dados de APM em si.';

  if (!apm.available) {
    return cardStat(null, 'APM Server', 'fa-diagram-project', '&mdash;',
      apm.error ? 'indisponível' : 'não configurado', 'muted',
      tip + (apm.error ? `<br><br><strong>Motivo:</strong> ${escHtml(apm.error)}` : ''),
      [], 'help-kibana-apm');
  }
  if (!apm.configured) {
    return cardStat(null, 'APM Server', 'fa-diagram-project', '0',
      'nenhuma integração APM', 'muted',
      tip + '<br><br>Nenhuma package policy do pacote <code>apm</code> foi encontrada neste Fleet.',
      [], 'help-kibana-apm');
  }

  const [, color] = agentSummary(apm);
  return cardStat(null, 'APM Server', 'fa-diagram-project', fmtNum(apm.total || 0),
    'agente(s) com a integração APM', color, tip,
    agentFooterStats(apm), 'help-kibana-apm');
}

// Tabela de utilização — mesmo layout do card "Utilização por Nó" dos Sinais
// Vitais, com as colunas possíveis para o Kibana.
function kibanaInstancesTable(d) {
  const tip = 'Utilização por instância do Kibana. Cada célula mostra no tooltip a <strong>origem</strong> ' +
    'do número, seguindo a precedência <strong>Elastic Agent → self-monitoring → API</strong>.<br><br>' +
    '<strong>CPU</strong> e <strong>Disco</strong> são do <em>host</em> e só existem quando há a integração ' +
    '<code>system</code> do Elastic Agent nele — a API do Kibana não expõe nenhum dos dois. Sem agente, a ' +
    'célula fica com um traço.<br>' +
    '<strong>RAM</strong>: memória do host onde a instância roda.<br>' +
    '<strong>Heap</strong>: heap do processo Node.js sobre o <code>size_limit</code> (o ' +
    '<code>--max-old-space-size</code>) — o denominador correto, já que o V8 cresce o heap sob demanda.<br>' +
    '<strong>ELU</strong> (Event Loop Utilization): fração do intervalo de coleta em que o event loop ficou ' +
    'ativo. Como o Kibana é single-threaded, é o indicador mais fiel de saturação de CPU do processo — ' +
    'acima de ~80% as requisições começam a enfileirar.<br>' +
    '<strong>Delay</strong>: atraso do event loop em milissegundos. Valores altos indicam bloqueio do loop.';

  const rows = (d.instances || []).map(inst => `<tr>
      <td>${instanceNameCell(inst)}</td>
      <td>${serviceStatusBadge(inst.status)}</td>
      <td>${svcMetricCell('kibana', inst.metrics.cpu, NO_AGENT_HINT)}</td>
      <td>${svcMetricCell('kibana', inst.metrics.disk, NO_AGENT_HINT)}</td>
      <td>${svcMetricCell('kibana', inst.metrics.ram)}</td>
      <td>${svcMetricCell('kibana', inst.metrics.heap)}</td>
      <td>${svcMetricCell('kibana', inst.metrics.elu)}</td>
      <td style="text-align:right">${svcNumCell('kibana', inst.metrics.event_loop_delay, ' ms')}</td>
    </tr>`).join('');

  return tableCard('fa-gauge-high', 'Utilização por Instância', tip, 'help-kibana-utilization',
    `<th>Instância</th><th>Status</th><th>CPU</th><th>Disco</th><th>RAM</th>
     <th>Heap</th><th>ELU</th><th style="text-align:right">Delay</th>`,
    rows);
}

// Task Manager: só existe via API, então aparece apenas para instâncias com URL.
function kibanaTaskManagerSection(d) {
  const withTm = (d.instances || []).filter(i => i.task_manager);
  if (!withTm.length) return '';

  const tip = 'Saúde do <strong>Task Manager</strong> de cada instância ' +
    '(<code>/api/task_manager/_health</code>) — o motor por trás de <strong>Alerting</strong>, ' +
    '<strong>Actions</strong> e <strong>Reporting</strong>. Consultar não gera carga: o Kibana devolve ' +
    'o último health check já calculado.<br><br>' +
    '<strong>Load</strong>: ocupação dos workers de tarefas <em>do Kibana</em> (não é o load average do ' +
    'host). Perto de 100% significa que não há capacidade sobrando para executar tarefas no horário.<br>' +
    '<strong>Drift</strong>: atraso entre o horário agendado da tarefa e sua execução real. Drift alto ' +
    'significa alertas e relatórios saindo atrasados.<br>' +
    '<strong>Capacidade</strong>: estimativa do próprio Kibana sobre a suficiência da capacidade atual.<br>' +
    '<strong>Atrasadas</strong>: tarefas que já passaram do horário e ainda não rodaram.';

  const rows = withTm.map(inst => {
    const tm = inst.task_manager;
    if (!tm.available) {
      return `<tr>
        <td><div class="kb-inst-name">${escHtml(inst.name || inst.url)}</div></td>
        <td colspan="5" style="color:var(--text-dim)">
          <i class="fas fa-circle-info"></i> indisponível${tm.error ? ` — ${escHtml(tm.error)}` : ''}
        </td>
      </tr>`;
    }
    const statusCls = { OK: 'badge-green', Warning: 'badge-yellow', Error: 'badge-red' }[tm.status] || 'badge-gray';
    return `<tr>
      <td><div class="kb-inst-name">${escHtml(inst.name || inst.url)}</div></td>
      <td><span class="badge ${statusCls}">${escHtml(tm.status || '-')}</span></td>
      <td>${tm.load_pct != null ? pctBar(tm.load_pct) : '<span class="kb-no-source">&mdash;</span>'}</td>
      <td>${tm.drift_p50 != null ? fmtDuration(tm.drift_p50) : '<span class="kb-no-source">&mdash;</span>'}
          ${tm.drift_p99 != null ? `<span class="kb-inst-sub">p99 ${fmtDuration(tm.drift_p99)}</span>` : ''}</td>
      <td>${tm.capacity_status
            ? `<span class="badge ${{ OK: 'badge-green', Warning: 'badge-yellow', Error: 'badge-red' }[tm.capacity_status] || 'badge-gray'}">${escHtml(tm.capacity_status)}</span>`
            : '<span class="kb-no-source">&mdash;</span>'}</td>
      <td style="text-align:right;${tm.overdue > 0 ? 'color:var(--yellow);font-weight:700' : ''}">${tm.overdue != null ? fmtNum(tm.overdue) : '—'}</td>
    </tr>`;
  }).join('');

  return section('Task Manager') +
    tableCard('fa-list-check', 'Alerting, Actions e Reporting', tip, 'help-kibana-task-manager',
      `<th>Instância</th><th>Status</th><th>Load</th><th>Drift</th>
       <th>Capacidade</th><th style="text-align:right">Atrasadas</th>`,
      rows);
}

// Detalhamento das policies com integração APM (só quando há mais de uma).
function kibanaFleetSection(d) {
  const apm = d.apm || {};
  if (!apm.available || !apm.configured || !(apm.policies || []).length) return '';

  const rows = apm.policies.map(p => `<tr>
    <td><div class="kb-inst-name">${escHtml(p.name || '(sem nome)')}</div>
        <div class="kb-inst-sub">${escHtml(p.policy_id)}</div></td>
    <td>${escHtml(p.package_version || '-')}</td>
    <td style="text-align:right">${fmtNum(p.total || 0)}</td>
    <td style="text-align:right;color:var(--green)">${fmtNum(p.healthy || 0)}</td>
    <td style="text-align:right;${p.unhealthy > 0 ? 'color:var(--red);font-weight:700' : ''}">${fmtNum(p.unhealthy || 0)}</td>
    <td style="text-align:right;${p.offline > 0 ? 'color:var(--yellow)' : ''}">${fmtNum(p.offline || 0)}</td>
  </tr>`).join('');

  return section('APM Server por Policy') +
    tableCard('fa-diagram-project', 'Policies com integração APM',
      'Cada <strong>agent policy</strong> que contém a integração <code>apm</code> e quantos agentes a executam. Útil para saber se o coletor de APM está de pé em todos os grupos esperados.',
      'help-kibana-apm',
      `<th>Policy</th><th>Versão do pacote</th>
       <th style="text-align:right">Agentes</th><th style="text-align:right">Healthy</th>
       <th style="text-align:right">Unhealthy</th><th style="text-align:right">Offline</th>`,
      rows);
}

// ═══════════════════ LOGSTASH ══════════════════════════════
// Os contadores de eventos do Logstash são **acumulados desde o start** do
// processo, não taxas: o throughput exibido é a média desde o start
// (eventos ÷ uptime), e é assim que ele é rotulado em toda a página.

function loadLogstash() {
  return loadIntegrationPage('logstash', renderLogstash);
}

function renderLogstash(d = integrationData.logstash) {
  const page = document.getElementById('page-logstash');
  if (!page || !d) return;

  if (!d.instances.length) {
    page.innerHTML = integrationEmptyState('logstash', d.has_urls,
      'Cadastre a URL da API de monitoramento (normalmente <code>http://host:9600</code>) na <strong>Configuração</strong>, ou habilite o monitoramento do Logstash para que as instâncias sejam descobertas automaticamente.');
    return;
  }

  page.innerHTML = `<div class="metrics-grid">
    ${section('Visão Geral')}
    <div class="section-signals-cards">${logstashOverviewCards(d)}</div>

    ${section('Utilização por Instância')}
    ${logstashInstancesTable(d)}

    ${logstashPipelinesSection(d)}
    ${logstashPluginsSection(d)}
  </div>`;
}

function logstashOverviewCards(d) {
  const tip = 'Instâncias cujo status é <strong>verde</strong>. Com URL cadastrada, o status vem do ' +
    '<code>/_health_report</code> — a avaliação do próprio Logstash, que enxerga pipeline parado e ' +
    'falha de reload; em versões sem esse endpoint, do campo <code>status</code> do ' +
    '<code>/_node/stats</code>. Sem URL, do self-monitoring.<br><br>' +
    'O rodapé traz a <strong>versão</strong> das instâncias — mais de uma fica ' +
    '<span style="color:var(--yellow)">amarela</span>: sinal de upgrade em andamento ou incompleto.';

  return [
    healthyInstancesCard(d, 'logstash', tip),
    logstashThroughputCard(d),
    logstashQueueCard(d),
    logstashDlqCard(d),
    logstashReloadCard(d),
  ].join('');
}

// Throughput: média desde o start, nunca taxa instantânea — os contadores da
// API são acumulados e uma taxa real exigiria duas coletas.
function logstashThroughputCard(d) {
  const ev = d.events || {};
  const tip = 'Vazão de eventos somando todas as instâncias. Os contadores do Logstash são ' +
    '<strong>acumulados desde o start</strong> do processo, então o valor é a <strong>média desde ' +
    'o start</strong> (eventos de saída ÷ uptime) — não a taxa deste instante, que exigiria duas ' +
    'coletas.<br><br>' +
    '<strong>Entrada / Filtrados / Saída</strong>: totais acumulados. Saída bem abaixo da entrada, ' +
    'sem <code>drop</code> no pipeline, indica eventos retidos na fila ou perdidos para a DLQ.<br>' +
    '<strong>ms/evento</strong>: custo médio de processamento por evento (tempo total ÷ eventos de ' +
    'saída). É o número comparável entre pipelines de volumes diferentes — o detalhe por plugin ' +
    'fica na tabela <strong>Plugins mais lentos</strong>.';

  if (ev.per_sec == null) {
    return cardStat(null, 'Vazão de Eventos', 'fa-right-left', '&mdash;',
      'sem uptime para calcular', 'muted', tip, [], 'help-logstash-throughput');
  }

  return cardStat(null, 'Vazão de Eventos', 'fa-right-left', fmtNum(ev.per_sec),
    'eventos/s (média desde o start)', 'blue', tip,
    [
      { label: 'Entrada', val: fmtNum(ev.in || 0) },
      { label: 'Saída', val: fmtNum(ev.out || 0) },
      { label: 'Filtrados', val: fmtNum(ev.filtered || 0) },
      ...(ev.avg_event_ms != null
        ? [{ label: 'ms/evento', val: fmtMs(ev.avg_event_ms) }] : []),
    ],
    'help-logstash-throughput');
}

// Fila: a ocupação só é calculável na fila persistente (a de memória não tem
// teto em bytes), então o valor é o pior caso entre as persistentes.
function logstashQueueCard(d) {
  const q = d.queues || {};
  const tip = 'Situação das filas dos pipelines. A <strong>fila persistente</strong> (PQ) grava os ' +
    'eventos em disco antes de processá-los, absorvendo picos e sobrevivendo a restart; a de ' +
    '<strong>memória</strong> não tem teto em bytes e perde o que estiver em trânsito se o processo ' +
    'cair.<br><br>' +
    'O valor é a <strong>ocupação da fila mais cheia</strong> entre as persistentes — só nelas há ' +
    'um máximo (<code>queue.max_bytes</code>) para dividir. Fila persistente cheia faz o Logstash ' +
    'aplicar <strong>backpressure</strong> na entrada: o input para de aceitar eventos.<br><br>' +
    'Sem nenhuma fila persistente o card fica neutro — não há o que medir, não é zero.';

  if (!q.persisted) {
    return cardStat(null, 'Fila Persistente', 'fa-layer-group', '&mdash;',
      q.memory ? 'todas as filas em memória' : 'sem pipeline com fila', 'muted', tip,
      [
        ...(q.memory ? [{ label: 'Em memória', val: fmtNum(q.memory) }] : []),
        ...(q.events ? [{ label: 'Eventos na fila', val: fmtNum(q.events) }] : []),
      ],
      'help-logstash-queue');
  }

  const pct = q.max_pct;
  const color = pct == null ? 'blue' : pctColor(pct);
  return cardStat(null, 'Fila Persistente', 'fa-layer-group',
    pct == null ? '&mdash;' : `${pct}%`, 'ocupação da fila mais cheia', color, tip,
    [
      { label: 'Persistentes', val: fmtNum(q.persisted) },
      { label: 'Em memória', val: fmtNum(q.memory || 0) },
      { label: 'Ocupado', val: `${formatBytes(q.bytes || 0)} / ${formatBytes(q.max_bytes || 0)}` },
      { label: 'Eventos na fila', val: fmtNum(q.events || 0) },
    ],
    'help-logstash-queue');
}

// DLQ: qualquer evento aqui é evento que não chegou ao destino.
function logstashDlqCard(d) {
  const dlq = d.dlq || {};
  const tip = 'A <strong>dead letter queue</strong> guarda os eventos que o output rejeitou de forma ' +
    'definitiva — tipicamente mapping conflict no Elasticsearch (HTTP 400). Cada evento aqui é um ' +
    'evento que <strong>não chegou ao destino</strong> e que ninguém reprocessa sozinho: é preciso ' +
    'ler a DLQ (input <code>dead_letter_queue</code>) e tratar.<br><br>' +
    '<strong>Descartados</strong>: eventos escritos na DLQ. <strong>Expirados</strong>: eventos que ' +
    'saíram da DLQ por idade ou tamanho (<code>dead_letter_queue.retain.age</code> / ' +
    '<code>storage_policy: drop_older</code>) — esses estão <strong>perdidos</strong>.<br><br>' +
    'A DLQ é desativada por padrão; sem ela, um evento rejeitado só aparece no log do Logstash.';

  if (!dlq.enabled) {
    return cardStat(null, 'Dead Letter Queue', 'fa-inbox', '&mdash;',
      'sem eventos descartados', 'muted', tip, [], 'help-logstash-dlq');
  }

  const dropped = dlq.dropped || 0;
  return cardStat(null, 'Dead Letter Queue', 'fa-inbox', fmtNum(dropped),
    'eventos descartados', dropped > 0 ? 'red' : 'green', tip,
    [
      { label: 'Tamanho', val: formatBytes(dlq.bytes || 0) },
      ...(dlq.expired ? [{ label: 'Expirados', val: fmtNum(dlq.expired), color: 'red' }] : []),
      { label: 'Pipelines', val: fmtNum((dlq.pipelines || []).length) },
    ],
    'help-logstash-dlq');
}

// Reloads com falha: configuração recarregada que não subiu.
function logstashReloadCard(d) {
  const failures = d.reload_failures || 0;
  const tip = 'Recargas de configuração que <strong>falharam</strong> ' +
    '(<code>config.reload.automatic</code>). Uma falha significa que o Logstash continua rodando ' +
    'a configuração <strong>anterior</strong>: a alteração que você fez não está em vigor, e o ' +
    'processo não reclama além do log.<br><br>' +
    'Causas típicas: erro de sintaxe no pipeline, plugin ausente, credencial inválida em um output. ' +
    'O motivo da última falha fica no tooltip da coluna <strong>Reloads</strong> da tabela de pipelines.';

  return cardStat(null, 'Reloads com Falha', 'fa-rotate-left', fmtNum(failures),
    failures > 0 ? 'configuração não aplicada' : 'nenhuma falha de recarga',
    failures > 0 ? 'red' : 'green', tip, [], 'help-logstash-reloads');
}

function logstashInstancesTable(d) {
  const tip = 'Utilização por instância do Logstash. Cada célula mostra no tooltip a ' +
    '<strong>origem</strong> do número.<br><br>' +
    '<strong>CPU</strong>: CPU do <em>processo</em> Logstash (<code>process.cpu.percent</code>), não do ' +
    'host — é a que a API expõe, e a que importa para saber se o Logstash está no limite.<br>' +
    '<strong>Heap</strong>: heap da JVM sobre o máximo configurado (<code>-Xmx</code>). Acima de 75% ' +
    'de forma sustentada, o GC passa a consumir CPU que seria do pipeline.<br>' +
    '<strong>RAM</strong> e <strong>Disco</strong> são do <em>host</em> e só existem com a integração ' +
    '<code>system</code> do Elastic Agent nele — a API do Logstash não expõe nenhum dos dois. Sem ' +
    'agente, a célula fica com um traço (ausência de fonte, não zero).<br>' +
    '<strong>FDs</strong>: file descriptors abertos sobre o máximo do processo. Logstash com muitos ' +
    'inputs de arquivo ou conexões de saída bate esse teto antes de qualquer outro limite, e o ' +
    'sintoma é "too many open files".<br>' +
    '<strong>Eventos/s</strong>: média desde o start (eventos de saída ÷ uptime).';

  const rows = (d.instances || []).map(inst => `<tr>
      <td>${instanceNameCell(inst)}</td>
      <td>${serviceStatusBadge(inst.status)}</td>
      <td>${svcMetricCell('logstash', inst.metrics.cpu, LS_NO_API_HINT)}</td>
      <td>${svcMetricCell('logstash', inst.metrics.heap, LS_NO_API_HINT)}</td>
      <td>${svcMetricCell('logstash', inst.metrics.ram, LS_NO_AGENT_HINT)}</td>
      <td>${svcMetricCell('logstash', inst.metrics.disk, LS_NO_AGENT_HINT)}</td>
      <td>${logstashFdCell(inst)}</td>
      <td style="text-align:right">${svcNumCell('logstash', inst.metrics.events_per_sec, '')}</td>
    </tr>`).join('');

  return tableCard('fa-gauge-high', 'Utilização por Instância', tip, 'help-logstash-utilization',
    `<th>Instância</th><th>Status</th><th>CPU</th><th>Heap</th><th>RAM</th>
     <th>Disco</th><th>FDs</th><th style="text-align:right">Eventos/s</th>`,
    rows);
}

// FDs: a barra é o percentual, mas o número absoluto (aberto/máx) é o que
// permite julgar, então vai logo abaixo.
function logstashFdCell(inst) {
  const cell = svcMetricCell('logstash', inst.metrics.fd, LS_NO_API_HINT);
  if (inst.fd_open == null || inst.fd_max == null) return cell;
  return `${cell}<div class="kb-inst-sub">${fmtNum(inst.fd_open)} / ${fmtNum(inst.fd_max)}</div>`;
}

// Pipelines, filas e DLQ só existem na API: sem URL cadastrada a seção explica
// o que falta, em vez de simplesmente não existir.
function logstashPipelinesSection(d) {
  const pipes = d.pipelines || [];
  if (!pipes.length) {
    return section('Pipelines') +
      `<div class="metric-card metric-card-static card-full">
        <div class="cfg-empty">
          Detalhamento por pipeline (eventos, fila, DLQ e reloads) vem da <strong>API de
          monitoramento</strong> de cada instância. Cadastre a URL na
          <strong>Configuração</strong> para vê-lo — o self-monitoring só traz os totais do nó.
        </div>
      </div>`;
  }

  const tip = 'Um pipeline por linha, por instância. Os contadores são <strong>acumulados desde o ' +
    'start</strong>.<br><br>' +
    '<strong>Workers</strong>: threads de filtro/saída (<code>pipeline.workers</code>) e o ' +
    '<code>batch.size</code> abaixo. São os dois parâmetros de tuning do pipeline.<br>' +
    '<strong>ms/evento</strong>: custo médio de processamento por evento — o comparável entre ' +
    'pipelines.<br>' +
    '<strong>Fila</strong>: tipo (memória ou persistente) e, na persistente, a ocupação em relação ' +
    'ao <code>queue.max_bytes</code>. O tooltip traz bytes, espaço livre e o caminho no disco.<br>' +
    '<strong>DLQ</strong>: eventos rejeitados definitivamente pelo output deste pipeline.<br>' +
    '<strong>Reloads</strong>: falhas de recarga de configuração (com o motivo da última no ' +
    'tooltip) e, abaixo, as recargas bem-sucedidas.';

  const rows = pipes.map(p => `<tr>
    <td>
      <div class="kb-inst-name">${escHtml(p.id)}${p.health_status ? ' ' + pipelineHealthBadge(p) : ''}</div>
      <div class="kb-inst-sub">${escHtml(p.instance)}</div>
    </td>
    <td>${p.workers != null ? fmtNum(p.workers) : '<span class="kb-no-source">&mdash;</span>'}
        ${p.batch_size != null ? `<div class="kb-inst-sub">batch ${fmtNum(p.batch_size)}</div>` : ''}</td>
    <td style="text-align:right">${fmtNum(p.events_in)}</td>
    <td style="text-align:right">${fmtNum(p.events_out)}</td>
    <td style="text-align:right">${p.avg_event_ms != null ? fmtMs(p.avg_event_ms) : '<span class="kb-no-source">&mdash;</span>'}</td>
    <td>${logstashQueueCell(p)}</td>
    <td style="text-align:right">${logstashDlqCell(p)}</td>
    <td style="text-align:right">${logstashReloadCell(p)}</td>
  </tr>`).join('');

  return section('Pipelines') +
    tableCard('fa-bezier-curve', 'Pipelines, filas e DLQ', tip, 'help-logstash-pipelines',
      `<th>Pipeline</th><th>Workers</th><th style="text-align:right">Entrada</th>
       <th style="text-align:right">Saída</th><th style="text-align:right">ms/evento</th>
       <th>Fila</th><th style="text-align:right">DLQ</th>
       <th style="text-align:right">Reloads</th>`,
      rows);
}

function pipelineHealthBadge(p) {
  const cls = { green: 'badge-green', yellow: 'badge-yellow', red: 'badge-red' }[p.health_status] || 'badge-gray';
  const title = p.health_symptom || p.health_status;
  return `<span class="badge ${cls}" title="${escHtml(title)}">${escHtml(p.health_status)}</span>`;
}

function logstashQueueCell(p) {
  const persisted = p.queue_type === 'persisted';
  const label = `<span class="badge ${persisted ? 'badge-blue' : 'badge-gray'}">${persisted ? 'persistente' : 'memória'}</span>`;
  if (!persisted) {
    // Fila de memória não tem máximo em bytes: só a contagem de eventos faz sentido.
    return `${label}${p.queue_events ? `<div class="kb-inst-sub">${fmtNum(p.queue_events)} eventos</div>` : ''}`;
  }
  const detail = [
    p.queue_bytes != null ? `${formatBytes(p.queue_bytes)} de ${formatBytes(p.queue_max_bytes || 0)}` : '',
    p.queue_free_bytes != null ? `${formatBytes(p.queue_free_bytes)} livres no disco` : '',
    p.queue_path ? `caminho: ${p.queue_path}` : '',
  ].filter(Boolean).join(' · ');
  return `<div title="${escHtml(detail)}">${label}
    ${p.queue_pct != null ? pctBar(p.queue_pct) : ''}
    ${p.queue_events ? `<div class="kb-inst-sub">${fmtNum(p.queue_events)} eventos</div>` : ''}</div>`;
}

function logstashDlqCell(p) {
  if (!p.dlq_dropped && !p.dlq_bytes && !p.dlq_expired) {
    return '<span class="kb-no-source" title="Nenhum evento na DLQ deste pipeline (ou DLQ desativada)">&mdash;</span>';
  }
  const title = [p.dlq_last_error ? `Último erro: ${p.dlq_last_error}` : '',
                 p.dlq_storage_policy ? `storage_policy: ${p.dlq_storage_policy}` : '',
                 p.dlq_expired ? `${p.dlq_expired} expirados (perdidos)` : ''].filter(Boolean).join(' · ');
  return `<span title="${escHtml(title)}" style="${p.dlq_dropped > 0 ? 'color:var(--red);font-weight:700' : ''}">
    ${fmtNum(p.dlq_dropped || 0)}</span>
    ${p.dlq_bytes ? `<div class="kb-inst-sub">${formatBytes(p.dlq_bytes)}</div>` : ''}`;
}

function logstashReloadCell(p) {
  const failures = p.reload_failures || 0;
  return `<span title="${escHtml(p.reload_last_error || '')}" style="${failures > 0 ? 'color:var(--red);font-weight:700' : ''}">
    ${fmtNum(failures)}</span>
    ${p.reload_successes ? `<div class="kb-inst-sub">${fmtNum(p.reload_successes)} ok</div>` : ''}`;
}

// Gargalo por plugin: onde o tempo do pipeline está sendo gasto.
function logstashPluginsSection(d) {
  const plugins = d.slow_plugins || [];
  if (!plugins.length) return '';

  const tip = 'Plugins que mais consomem tempo, somando todos os pipelines — a resposta direta para ' +
    '"onde está o gargalo". Ordenado pelo <strong>tempo total</strong> acumulado desde o start.<br><br>' +
    'Só <strong>filtros</strong> e <strong>saídas</strong> entram: um <em>input</em> não tem tempo de ' +
    'processamento (o que ele acumula é espera por dados) e apareceria sempre no topo, sem significar ' +
    'nada.<br><br>' +
    '<strong>ms/evento</strong> é o custo unitário — um plugin barato com volume enorme aparece aqui ' +
    'por volume, não por ineficiência; o caro de verdade é o que tem ms/evento alto. ' +
    '<strong>% do pipeline</strong> mostra quanto do tempo daquele pipeline é esse plugin.<br><br>' +
    'Plugins sem <code>id</code> explícito no arquivo de configuração aparecem com o hash gerado ' +
    'pelo Logstash — nomear os plugins (<code>id => "..."</code>) torna esta tabela legível.';

  const rows = plugins.map(p => `<tr>
    <td><div class="kb-inst-name">${escHtml(p.name)}</div>
        ${p.id ? `<div class="kb-inst-sub">${escHtml(p.id)}</div>` : ''}</td>
    <td><span class="badge ${p.type === 'filter' ? 'badge-blue' : 'badge-gray'}">${escHtml(p.type)}</span></td>
    <td><div class="kb-inst-name">${escHtml(p.pipeline)}</div>
        <div class="kb-inst-sub">${escHtml(p.instance)}</div></td>
    <td style="text-align:right">${fmtNum(p.events)}</td>
    <td style="text-align:right">${p.avg_event_ms != null ? fmtMs(p.avg_event_ms) : '-'}</td>
    <td style="text-align:right">${fmtDuration(p.duration_ms)}</td>
    <td style="text-align:right">${p.share_pct != null ? `${p.share_pct}%` : '-'}</td>
  </tr>`).join('');

  return section('Plugins mais lentos') +
    tableCard('fa-stopwatch', 'Onde o tempo do pipeline é gasto', tip, 'help-logstash-plugins',
      `<th>Plugin</th><th>Tipo</th><th>Pipeline</th>
       <th style="text-align:right">Eventos</th><th style="text-align:right">ms/evento</th>
       <th style="text-align:right">Tempo total</th><th style="text-align:right">% do pipeline</th>`,
      rows);
}

// ═══════════════════ CONFIGURAÇÃO ═════════════════════════
// Uma seção por integração, cada uma com seu próprio rodapé de Salvar: são
// configurações independentes e salvar uma não deve arrastar a outra.
async function renderConfig() {
  const page = document.getElementById('page-config');
  if (!page) return;
  const keys = Object.keys(INTEGRATIONS);

  if (keys.some(k => !integrationConfig[k])) {
    page.innerHTML = `<div class="loading-state"><i class="fas fa-circle-notch fa-spin"></i><span>Carregando configuração...</span></div>`;
    try {
      await Promise.all(keys.filter(k => !integrationConfig[k]).map(fetchIntegrationConfig));
    } catch (e) {
      page.innerHTML = `<div class="error-state"><i class="fas fa-triangle-exclamation"></i><p>${escHtml(e.message)}</p></div>`;
      return;
    }
  }
  // Draft parte da config salva; edições ficam nele até o Salvar.
  for (const key of keys) {
    if (!integrationDraft[key]) {
      integrationDraft[key] = {
        enabled: integrationConfig[key].enabled,
        username: integrationConfig[key].username,
        instances: (integrationConfig[key].instances || []).map(i => ({ url: i.url })),
        passwordDirty: false,
        password: '',
      };
    }
  }

  // O aviso de "conexão não salva" vale para as duas: fica uma vez, no topo.
  const notPersistable = keys.some(k => integrationConfig[k].persistable === false)
    ? `<div class="kb-warning">
         <i class="fas fa-circle-info"></i>
         <div>${escHtml(integrationConfig[keys[0]].reason || '')}</div>
       </div>`
    : '';

  page.innerHTML = `<div class="config-page">
    ${notPersistable}
    ${keys.map(integrationConfigHtml).join('')}
  </div>`;
}

function integrationConfigHtml(key) {
  const meta = INTEGRATIONS[key];
  const cfg = integrationConfig[key] || {};
  const draft = integrationDraft[key];
  const locked = cfg.has_password && !draft.passwordDirty;

  const urlRows = draft.instances.length
    ? draft.instances.map((inst, idx) => `
      <div class="cfg-instance">
        <div class="cfg-instance-row">
          <span class="cfg-instance-num">${idx + 1}</span>
          <input type="text" value="${escHtml(inst.url)}" data-url-key="${key}" data-url-idx="${idx}"
            placeholder="${escHtml(meta.urlPlaceholder)}"
            oninput="cfgUrlChanged('${key}', ${idx}, this.value)">
          <button class="btn btn-ghost btn-sm" onclick="cfgTestUrl('${key}', ${idx})" title="Testar esta instância">
            <i class="fas fa-vial"></i> Testar
          </button>
          <button class="btn-icon" onclick="cfgRemoveUrl('${key}', ${idx})" title="Remover">
            <i class="fas fa-trash"></i>
          </button>
        </div>
        <div class="kb-url-result" id="urlResult-${key}-${idx}"></div>
      </div>`).join('')
    : `<div class="cfg-empty">${meta.emptyInstances}</div>`;

  return `<section class="cfg-section">
      <div class="cfg-section-info">
        <div class="cfg-section-title">
          <i class="fas ${meta.icon}"></i>
          <span>${meta.label}</span>
          ${tooltip(meta.switchTip, meta.helpTopic)}
        </div>
        <p class="cfg-section-desc">${meta.switchDesc}</p>
      </div>
      <div class="cfg-section-fields">
        <label class="cfg-switch">
          <input type="checkbox" id="${key}Enabled" ${draft.enabled ? 'checked' : ''}
            onchange="cfgToggleEnabled('${key}', this.checked)">
          <span class="cfg-switch-track"></span>
          <span class="cfg-switch-text" id="${key}EnabledLabel">${draft.enabled ? 'Ativado' : 'Desativado'}</span>
        </label>
      </div>
    </section>

    <div id="${key}Fields" ${draft.enabled ? '' : 'hidden'}>
      <section class="cfg-section">
        <div class="cfg-section-info">
          <div class="cfg-section-title"><i class="fas fa-key"></i><span>Acesso</span></div>
          <p class="cfg-section-desc">${meta.accessDesc}</p>
        </div>
        <div class="cfg-section-fields">
          <div class="form-row">
            <div class="form-group">
              <label>Usuário${meta.userRequired ? '' : ' <span style="font-weight:400;text-transform:none;letter-spacing:0">(opcional)</span>'}</label>
              <input type="text" id="${key}Username" value="${escHtml(draft.username || '')}"
                placeholder="elastic" autocomplete="username"
                oninput="integrationDraft['${key}'].username = this.value">
            </div>
            <div class="form-group">
              <label>Senha</label>
              ${locked
                ? `<button type="button" class="btn btn-ghost btn-full" onclick="cfgEnablePasswordChange('${key}')">
                     <i class="fas fa-key"></i> Alterar senha
                   </button>`
                : `<input type="password" id="${key}Password" value="${escHtml(draft.password || '')}"
                     placeholder="••••••••" autocomplete="current-password"
                     oninput="integrationDraft['${key}'].password = this.value; integrationDraft['${key}'].passwordDirty = true">`}
            </div>
          </div>
        </div>
      </section>

      <section class="cfg-section">
        <div class="cfg-section-info">
          <div class="cfg-section-title"><i class="fas fa-server"></i><span>Instâncias</span></div>
          <p class="cfg-section-desc">${meta.instancesDesc}</p>
        </div>
        <div class="cfg-section-fields">
          <div class="cfg-instance-list">${urlRows}</div>
          <button class="btn btn-ghost btn-sm cfg-add-btn" onclick="cfgAddUrl('${key}')">
            <i class="fas fa-plus"></i> Adicionar instância
          </button>
        </div>
      </section>
    </div>

    <div class="cfg-footer">
      <div class="error-msg" id="${key}ConfigMsg"></div>
      <div class="cfg-footer-actions">
        <button class="btn btn-ghost" onclick="cfgResetDraft('${key}')">
          <i class="fas fa-rotate-left"></i> Descartar alterações
        </button>
        <button class="btn btn-primary" id="${key}SaveBtn" onclick="saveIntegrationConfig('${key}')">
          <i class="fas fa-floppy-disk"></i> Salvar ${meta.label}
        </button>
      </div>
    </div>`;
}

function cfgToggleEnabled(key, checked) {
  integrationDraft[key].enabled = checked;
  const fields = document.getElementById(`${key}Fields`);
  if (fields) fields.hidden = !checked;
  const label = document.getElementById(`${key}EnabledLabel`);
  if (label) label.textContent = checked ? 'Ativado' : 'Desativado';
}

function cfgEnablePasswordChange(key) {
  integrationDraft[key].passwordDirty = true;
  integrationDraft[key].password = '';
  renderConfig();
}

function cfgUrlChanged(key, idx, value) {
  if (integrationDraft[key].instances[idx]) integrationDraft[key].instances[idx].url = value;
}

function cfgAddUrl(key) {
  integrationDraft[key].instances.push({ url: '' });
  renderConfig();
  // foco no campo recém-criado (o último daquela integração)
  const inputs = document.querySelectorAll(`[data-url-key="${key}"]`);
  if (inputs.length) inputs[inputs.length - 1].focus();
}

async function cfgRemoveUrl(key, idx) {
  const inst = integrationDraft[key].instances[idx];
  const url = inst ? inst.url : '';
  const ok = !url || await showConfirm({
    title: 'Remover instância',
    message: `Remover "${url}" da lista? A alteração só vale depois de salvar.`,
    confirmLabel: 'Remover',
    danger: true,
  });
  if (!ok) return;
  integrationDraft[key].instances.splice(idx, 1);
  renderConfig();
}

function cfgResetDraft(key) {
  integrationDraft[key] = null;
  renderConfig();
}

async function cfgTestUrl(key, idx) {
  const inst = integrationDraft[key].instances[idx];
  const out = document.getElementById(`urlResult-${key}-${idx}`);
  if (!inst || !out) return;
  if (!inst.url.trim()) {
    out.className = 'kb-url-result error';
    out.textContent = 'Informe a URL antes de testar.';
    return;
  }
  out.className = 'kb-url-result';
  out.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Testando...';

  try {
    const res = await fetch(`/api/${key}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: inst.url,
        username: integrationDraft[key].username,
        // Senha só vai quando foi digitada agora; senão o back usa a salva.
        ...(integrationDraft[key].passwordDirty ? { password: integrationDraft[key].password } : {}),
      }),
    });
    const data = await res.json();
    if (data.success) {
      out.className = 'kb-url-result success';
      out.innerHTML = `<i class="fas fa-circle-check"></i> ${escHtml(data.name || 'instância')} · v${escHtml(data.version || '?')} · ${escHtml(data.status || '')}`;
    } else {
      out.className = 'kb-url-result error';
      out.innerHTML = `<i class="fas fa-circle-xmark"></i> ${escHtml(data.error || 'falhou')}`;
    }
  } catch (e) {
    out.className = 'kb-url-result error';
    out.innerHTML = `<i class="fas fa-circle-xmark"></i> ${escHtml(e.message)}`;
  }
}

async function saveIntegrationConfig(key) {
  const btn = document.getElementById(`${key}SaveBtn`);
  const msg = document.getElementById(`${key}ConfigMsg`);
  const draft = integrationDraft[key];
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Salvando...';

  const payload = {
    enabled: draft.enabled,
    username: draft.username,
    instances: draft.instances.filter(i => i.url.trim()).map(i => ({ url: i.url.trim() })),
  };
  if (draft.passwordDirty) payload.password = draft.password;

  try {
    const res = await fetch(`/api/${key}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.success) {
      showMsg(msg, data.error || 'Não foi possível salvar', 'error');
      return;
    }
    integrationConfig[key] = data.config;
    integrationDraft[key] = null;
    applyIntegrationNav(key);
    // renderConfig recria o DOM da página: só depois dá para escrever a mensagem.
    await renderConfig();
    showTempMsg(document.getElementById(`${key}ConfigMsg`), 'Configuração salva', 'success');
    // A página da integração precisa refletir as URLs novas na próxima visita.
    integrationData[key] = null;
  } catch (e) {
    showMsg(msg, e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

// ─── Keyboard Shortcuts ───────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    const jm = document.getElementById('jsonModal');
    if (jm && jm.style.display === 'flex') { closeJsonModal(); return; }
    const dm = document.getElementById('diskModal');
    if (dm && dm.style.display === 'flex') { closeDiskModal(); return; }
    const sm = document.getElementById('snapshotModal');
    if (sm && sm.style.display === 'flex') { closeSnapshotModal(); return; }
    const nm = document.getElementById('nodeModal');
    if (nm && nm.style.display === 'flex') { closeNodeModal(); return; }
    closeDetailModal(); closeTaskJsonModal(); closeAliasModal(); closeConfirmModal();
  }
  // Só faz sentido onde há dado ao vivo — a mesma lista da topbar, para uma
  // página refreshável nova não ficar de fora do atalho por esquecimento.
  if (e.key === 'r' && !e.ctrlKey && !e.metaKey && document.activeElement.tagName !== 'INPUT' &&
      REFRESHABLE_PAGES.has(currentPage)) {
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
renderHelp();

(async () => {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();

    if (data.connected) {
      document.getElementById('connectModal').style.display = 'none';
      document.getElementById('app').style.display = 'flex';
      setClusterInfo(data.info);
      loadDashboard();
      // A config de cada integração decide se o item dela aparece na sidebar.
      // Falha aqui não pode impedir o dashboard do cluster de carregar.
      loadIntegrations();
      showPage(pageFromHash());
    } else {
      loadConnections();
    }
  } catch (e) {
    loadConnections();
  }
})();
