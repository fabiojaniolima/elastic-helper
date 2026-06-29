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

async function disconnect() {
  await fetch('/api/disconnect', { method: 'POST' });
  location.reload();
}

function setClusterInfo(info) {
  const el = document.getElementById('sidebarCluster');
  if (!el) return;
  const deployment = info.cluster_name || info.host;
  const name = deployment;
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
    }
  } catch (e) {
  }
})();
