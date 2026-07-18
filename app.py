from flask import Flask, render_template, jsonify, request
from dotenv import load_dotenv
import logging
import re
import sqlite3
import os

import db
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

db.init_db()

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
    """Mescla os campos enviados com uma conexão salva (connection_id como base).
    Retorna (params, None) se válido ou (None, (response, status)) em caso de erro."""
    saved = {}
    conn_id = data.get('connection_id')
    if conn_id:
        saved = db.get_connection_full(conn_id) or {}

    host = (data.get('host') or saved.get('host') or '').strip()
    # Salvaguarda: o front já normaliza o Host, mas remove protocolo/caminho
    # remanescente para nunca montar uma URL quebrada (https://https://...).
    host = re.sub(r'^https?://', '', host, flags=re.I).split('/')[0]
    port_raw = data.get('port') or saved.get('port')
    username = (data.get('username') or saved.get('username') or '').strip()
    # Senha: prioriza a digitada agora; senão a salva
    password = (data.get('password') or '').strip() or saved.get('password') or ''
    if 'use_ssl' in data:
        use_ssl = data.get('use_ssl')
    else:
        use_ssl = saved.get('use_ssl', False)

    missing = [n for n, v in (('host', host), ('porta', port_raw), ('usuário', username)) if not v]
    if missing:
        return None, (jsonify({'success': False, 'error': 'Campos obrigatórios: ' + ', '.join(missing)}), 400)
    try:
        port = int(port_raw)
    except (ValueError, TypeError):
        return None, (jsonify({'success': False, 'error': 'Porta inválida'}), 400)

    # Alias da conexão salva (via connection_id ou casando host+porta+usuário)
    alias = (saved.get('alias') or '').strip() or (db.find_duplicate(host, port, username) or '')

    return {'host': host, 'port': port, 'username': username,
            'password': password, 'use_ssl': use_ssl, 'alias': alias}, None


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


# ─── Conexões salvas (SQLite) ─────────────────────────────
DUP_MSG = 'Já existe uma conexão ("{alias}") cadastrada para esse host, porta e usuário'


def _validate_connection_payload(data):
    """Retorna (None) se válido ou uma mensagem de erro."""
    if not (data.get('alias') or '').strip():
        return 'O alias/nome da conexão é obrigatório'
    if not (data.get('host') or '').strip():
        return 'O host é obrigatório'
    if not str(data.get('port') or '').strip():
        return 'A porta é obrigatória'
    if not (data.get('username') or '').strip():
        return 'O usuário é obrigatório'
    try:
        int(data['port'])
    except (ValueError, TypeError):
        return 'A porta deve ser um número'
    return None


@app.route('/api/connections', methods=['GET'])
def api_connections_list():
    return jsonify(db.list_connections())


@app.route('/api/connections', methods=['POST'])
def api_connections_create():
    data = request.get_json() or {}
    err = _validate_connection_payload(data)
    if err:
        return jsonify({'success': False, 'error': err}), 400
    dup = db.find_duplicate(data['host'], data['port'], data.get('username'))
    if dup:
        return jsonify({'success': False, 'error': DUP_MSG.format(alias=dup)}), 409
    try:
        conn = db.create_connection(data)
    except sqlite3.IntegrityError:
        return jsonify({'success': False, 'error': 'Já existe uma conexão com esse alias'}), 409
    return jsonify({'success': True, 'connection': conn})


@app.route('/api/connections/<int:conn_id>', methods=['PUT'])
def api_connections_update(conn_id):
    data = request.get_json() or {}
    err = _validate_connection_payload(data)
    if err:
        return jsonify({'success': False, 'error': err}), 400
    dup = db.find_duplicate(data['host'], data['port'], data.get('username'), exclude_id=conn_id)
    if dup:
        return jsonify({'success': False, 'error': DUP_MSG.format(alias=dup)}), 409
    try:
        conn = db.update_connection(conn_id, data)
    except sqlite3.IntegrityError:
        return jsonify({'success': False, 'error': 'Já existe uma conexão com esse alias'}), 409
    if conn is None:
        return jsonify({'success': False, 'error': 'Conexão não encontrada'}), 404
    return jsonify({'success': True, 'connection': conn})


@app.route('/api/connections/<int:conn_id>', methods=['DELETE'])
def api_connections_delete(conn_id):
    if db.delete_connection(conn_id):
        return jsonify({'success': True})
    return jsonify({'success': False, 'error': 'Conexão não encontrada'}), 404


# ─── Dados do cluster (exigem conexão ativa) ──────────────
@app.route('/api/dashboard')
def api_dashboard():
    """Métricas do dashboard, sempre coletadas na hora (não há cache).

    `?sections=a,b` limita a coleta às seções pedidas — é o que faz o refresh de
    uma seção consultar no ES apenas o que aquela seção mostra. Sem o parâmetro,
    coleta tudo (carga inicial e refresh global).
    """
    err = require_es()
    if err:
        return err

    raw = (request.args.get('sections') or '').strip()
    sections = [s for s in (p.strip() for p in raw.split(',')) if s] if raw else None
    if sections is not None:
        unknown = [s for s in sections if s not in es_service.DASHBOARD_SECTIONS]
        if unknown:
            return jsonify({'error': 'Seção desconhecida: ' + ', '.join(unknown)}), 400

    try:
        return jsonify(es_service.dashboard(sections))
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/detail/<metric>')
def api_detail(metric):
    err = require_es()
    if err:
        return err
    try:
        result = es_service.detail(metric)
        if result is None:
            return jsonify({'error': 'Unknown metric'}), 404
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/tasks')
def api_tasks():
    err = require_es()
    if err:
        return err
    try:
        return jsonify(es_service.tasks())
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/tasks/cancel', methods=['POST'])
def api_cancel_task():
    err = require_es()
    if err:
        return err
    task_id = (request.get_json() or {}).get('task_id', '')
    if not task_id:
        return jsonify({'success': False, 'error': 'task_id is required'}), 400
    try:
        es_service.cancel_task(task_id)
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/index_shards/<path:index_name>')
def api_index_shards(index_name):
    err = require_es()
    if err:
        return err
    try:
        return jsonify(es_service.index_shards(index_name))
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/recovery')
def api_recovery():
    err = require_es()
    if err:
        return err
    try:
        return jsonify(es_service.recovery())
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/node/<path:node_name>')
def api_node(node_name):
    err = require_es()
    if err:
        return err
    try:
        return jsonify(es_service.node_detail(node_name))
    except Exception as e:
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    port = int(os.getenv('PORT', 5001))
    # Debugger/reloader do Flask só quando LOG_LEVEL=DEBUG.
    debug = _log_level <= logging.DEBUG
    app.run(debug=debug, host='0.0.0.0', port=port)
