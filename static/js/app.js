'use strict';

// ─── Utilities ───────────────────────────────────────────
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

// ─── Init ─────────────────────────────────────────────────
(async () => {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();

    if (data.connected) {
      document.getElementById('connectModal').style.display = 'none';
      document.getElementById('app').style.display = 'flex';
      setClusterInfo(data.info);
      showPage(pageFromHash());
    } else {
      loadConnections();
    }
  } catch (e) {
    loadConnections();
  }
})();
