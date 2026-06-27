from flask import Flask, render_template, jsonify, request
from dotenv import load_dotenv
import logging
import re
import os

import es_service

load_dotenv()

# ─── Logging ──────────────────────────────────────────────
# Nível controlado por LOG_LEVEL no .env (DEBUG/INFO/WARNING/ERROR).
# Default INFO. Aplica-se ao app e ao logger do Werkzeug (requisições).
LOG_LEVEL = os.getenv('LOG_LEVEL', 'INFO').upper()
_log_level = getattr(logging, LOG_LEVEL, logging.INFO)
logging.basicConfig(
    level=_log_level,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s',
)
logging.getLogger('werkzeug').setLevel(_log_level)
logger = logging.getLogger('elastic-helper')
logger.info('Nível de log definido para %s', logging.getLevelName(_log_level))

app = Flask(__name__)
app.secret_key = os.urandom(24)


def require_es():
    if not es_service.is_connected():
        return jsonify({'error': 'Not connected to Elasticsearch'}), 401
    return None


# ─── Routes ───────────────────────────────────────────────
@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/status')
def api_status():
    return jsonify({
        'connected': es_service.is_connected(),
        'info': es_service.get_info(),
    })


def _resolve_params(data):
    """Valida e normaliza os campos de conexão recebidos do formulário.
    Retorna (params, None) se válido ou (None, (response, status)) em caso de erro."""
    host = (data.get('host') or '').strip()
    # Salvaguarda: o front já normaliza o Host, mas remove protocolo/caminho
    # remanescente para nunca montar uma URL quebrada (https://https://...).
    host = re.sub(r'^https?://', '', host, flags=re.I).split('/')[0]
    port_raw = data.get('port')
    username = (data.get('username') or '').strip()
    password = (data.get('password') or '').strip()
    use_ssl = data.get('use_ssl', False)

    missing = [n for n, v in (('host', host), ('porta', port_raw), ('usuário', username)) if not v]
    if missing:
        return None, (jsonify({'success': False, 'error': 'Campos obrigatórios: ' + ', '.join(missing)}), 400)
    try:
        port = int(port_raw)
    except (ValueError, TypeError):
        return None, (jsonify({'success': False, 'error': 'Porta inválida'}), 400)

    return {'host': host, 'port': port, 'username': username,
            'password': password, 'use_ssl': use_ssl}, None


@app.route('/api/connect', methods=['POST'])
def api_connect():
    params, err = _resolve_params(request.get_json() or {})
    if err:
        return err
    try:
        info = es_service.connect(params)
        return jsonify({'success': True, **info})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 400


@app.route('/api/test_connection', methods=['POST'])
def api_test_connection():
    """Testa as credenciais sem alterar a conexão ativa (não entra no dashboard)."""
    params, err = _resolve_params(request.get_json() or {})
    if err:
        return err
    try:
        return jsonify({'success': True, **es_service.test_connection(params)})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 400


@app.route('/api/disconnect', methods=['POST'])
def api_disconnect():
    es_service.disconnect()
    return jsonify({'success': True})


if __name__ == '__main__':
    port = int(os.getenv('PORT', 5001))
    # Debugger/reloader do Flask só quando LOG_LEVEL=DEBUG.
    debug = _log_level <= logging.DEBUG
    app.run(debug=debug, host='0.0.0.0', port=port)
