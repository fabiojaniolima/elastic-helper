'use strict';

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

// ─── Init ─────────────────────────────────────────────────
(async () => {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();

    if (data.connected) {
      document.getElementById('connectModal').style.display = 'none';
      document.getElementById('app').style.display = 'flex';
    }
  } catch (e) {
  }
})();
