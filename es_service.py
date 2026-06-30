"""Camada de acesso ao Elasticsearch.

Concentra todo o estado e a lógica de coleta de dados do cluster:
  - ciclo de vida do cliente (connect/test/disconnect) e seu estado de módulo;

As rotas Flask em `app.py` apenas validam a requisição, chamam estas funções e
serializam o retorno (dados Python nativos) — nenhuma lógica de ES vive lá.
"""
import logging
import warnings

from elasticsearch import Elasticsearch, ElasticsearchWarning
from elasticsearch.exceptions import GeneralAvailabilityWarning

warnings.filterwarnings('ignore', category=ElasticsearchWarning)
warnings.filterwarnings('ignore', category=GeneralAvailabilityWarning)

logger = logging.getLogger('elastic-helper')

# ─── Estado do cliente ────────────────────────────────────
_client = None
_info = {}


def is_connected():
    return _client is not None


def get_info():
    return dict(_info)


def _make_client(p):
    scheme = 'https' if p['use_ssl'] else 'http'
    kwargs = {
        'hosts': [f"{scheme}://{p['host']}:{p['port']}"],
        'verify_certs': False,
        'ssl_show_warn': False,
        'request_timeout': 15,
    }
    if p['username'] and p['password']:
        kwargs['basic_auth'] = (p['username'], p['password'])
    return Elasticsearch(**kwargs)


def connect(params):
    """Conecta e ativa o cliente. Retorna o dict de info do cluster.
    Levanta exceção em caso de falha (deixada para a rota tratar)."""
    global _client, _info
    client = _make_client(params)
    info = client.info()
    _client = client
    _info = {
        'host': params['host'],
        'port': params['port'],
        'alias': params.get('alias', ''),
        'cluster_name': info['cluster_name'],
        'version': info['version']['number'],
    }
    return dict(_info)


def test_connection(params):
    """Valida credenciais sem ativar a conexão. Retorna {cluster_name, version}."""
    info = _make_client(params).info()
    return {
        'cluster_name': info['cluster_name'],
        'version': info['version']['number'],
    }


def disconnect():
    global _client, _info
    _client = None
    _info = {}
