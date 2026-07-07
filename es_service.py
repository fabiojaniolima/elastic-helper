"""Camada de acesso ao Elasticsearch.

Concentra todo o estado e a lógica de coleta de dados do cluster:
  - ciclo de vida do cliente (connect/test/disconnect) e seu estado de módulo;
  - coleta do dashboard em blocos, para que um refresh de seção consulte no ES
    apenas o que aquela seção mostra;
  - construção das métricas do dashboard e de cada métrica de detalhe.

**Não há cache.** Toda requisição consulta o cluster — o que a tela mostra é
sempre o estado do momento em que o botão de atualizar foi clicado.

As rotas Flask em `app.py` apenas validam a requisição, chamam estas funções e
serializam o retorno (dados Python nativos) — nenhuma lógica de ES vive lá.
"""
from concurrent.futures import ThreadPoolExecutor
import logging
import warnings

from elasticsearch import Elasticsearch, ElasticsearchWarning
from elasticsearch.exceptions import GeneralAvailabilityWarning

warnings.filterwarnings('ignore', category=ElasticsearchWarning)
warnings.filterwarnings('ignore', category=GeneralAvailabilityWarning)

logger = logging.getLogger('elastic-helper')

# Colunas do cat.indices reutilizadas entre dashboard e detalhes
CAT_INDICES_COLS = 'index,health,status,pri,rep,store.size,pri.store.size,docs.count'
GB_1 = 1024 ** 3      # limite abaixo do qual um shard primário médio é "pequeno demais"

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


# Fetchers do dashboard: cada um é uma chamada ao ES, feita na hora. São as
# fontes declaradas em DASHBOARD_SOURCES e coletadas em paralelo por _collect(),
# que garante uma única chamada por fonte dentro de uma mesma requisição.
def fetch_cluster_health():
    """Saúde básica do cluster (status, contadores de shards, data nodes…).
    Crítica: deixa a exceção propagar (o dashboard depende dela)."""
    return _client.cluster.health().body


def fetch_cluster_health_indices():
    """Saúde por índice (level=indices) — base do detalhe de Saúde do Cluster."""
    return _client.cluster.health(level='indices').body


def fetch_cat_indices():
    """cat.indices em bytes (colunas canônicas). Compartilhado entre o dashboard e
    os detalhes que trabalham com tamanhos em bytes (oversharding)."""
    return list(_client.cat.indices(
        h=CAT_INDICES_COLS, format='json', expand_wildcards='all', s='index', bytes='b'))


def fetch_cat_nodes():
    """cat.nodes com as colunas da tabela "Utilização por Nó" (bytes crus)."""
    return list(_client.cat.nodes(
        h='name,ip,version,cpu,heap.percent,heap.max,ram.max,disk.used_percent,'
          'disk.used,disk.total,master',
        format='json', bytes='b'))


def fetch_nodes_info():
    return _client.nodes.info(metric='settings,os').body


# ─── Helpers ──────────────────────────────────────────────
def safe_int(val, default=0):
    try:
        return int(val) if val is not None and str(val).strip() not in ('', 'null') else default
    except (ValueError, TypeError):
        return default


def safe_float(val, default=0.0):
    try:
        return float(val) if val is not None and str(val).strip() not in ('', 'null') else default
    except (ValueError, TypeError):
        return default


def safe_result(future, default=None):
    try:
        return future.result()
    except Exception:
        return default


DATA_ROLES = {'data', 'data_hot', 'data_warm', 'data_cold', 'data_frozen', 'data_content'}

DASHBOARD_SOURCES = {
    'health':           (fetch_cluster_health, None),
    'cat_indices':      (fetch_cat_indices, []),
    'cat_nodes':        (fetch_cat_nodes, []),
    'nodes_info':       (fetch_nodes_info, {}),
}


def _collect(sources):
    """Busca em paralelo as fontes pedidas, uma chamada por fonte. Devolve
    {nome: payload}; falhas viram o default declarado (exceto `health`)."""
    names = [n for n in DASHBOARD_SOURCES if n in sources]
    with ThreadPoolExecutor(max_workers=max(1, len(names))) as pool:
        futures = {n: pool.submit(DASHBOARD_SOURCES[n][0]) for n in names}
    raw = {}
    for name, future in futures.items():
        default = DASHBOARD_SOURCES[name][1]
        raw[name] = future.result() if name == 'health' else safe_result(future, default)
    return raw


# ─── Blocos do dashboard ──────────────────────────────────
# Cada bloco produz um subconjunto de chaves do resultado a partir das fontes
# que declara. É o que permite ao refresh de uma seção consultar só o que ela
# mostra: a rota traduz as seções pedidas em blocos, e os blocos em fontes.
def _block_health(raw):
    health = raw['health']
    return {'cluster_health': {
        'status': health['status'],
        'number_of_nodes': health['number_of_nodes'],
        'number_of_data_nodes': health['number_of_data_nodes'],
        'active_primary_shards': health['active_primary_shards'],
        'active_shards': health['active_shards'],
        'unassigned_shards': health['unassigned_shards'],
        'initializing_shards': health['initializing_shards'],
        'relocating_shards': health['relocating_shards'],
        'delayed_unassigned_shards': health.get('delayed_unassigned_shards', 0),
        'active_shards_percent': round(health.get('active_shards_percent_as_number', 100.0), 1),
        'number_of_pending_tasks': health.get('number_of_pending_tasks', 0),
        'task_max_waiting_in_queue_millis': health.get('task_max_waiting_in_queue_millis', 0),
    }}


def _block_indices(raw):
    """Totais e contagens derivados do cat.indices. Depende de `health` só para
    o nº de data nodes (base da regra de réplicas que nunca alocam)."""
    indices = raw['cat_indices']
    data_nodes = raw['health']['number_of_data_nodes']

    # Totais de volume (cat.indices já vem em bytes via bytes='b')
    total_store = total_docs = total_shards = 0
    unassignable_replicas = oversharded = 0
    for i in indices:
        pri = safe_int(i.get('pri'))
        rep = safe_int(i.get('rep'))
        total_store += safe_int(i.get('store.size'))
        total_docs += safe_int(i.get('docs.count'))
        total_shards += pri * (1 + rep)
        # Réplica não aloca quando nº de réplicas >= nº de data nodes
        if rep > 0 and data_nodes > 0 and rep >= data_nodes:
            unassignable_replicas += 1
        # Oversharding: vários primários com tamanho médio por shard < 1 GB
        pri_store = safe_int(i.get('pri.store.size'))
        if pri > 1 and pri_store > 0 and (pri_store / pri) < GB_1:
            oversharded += 1

    return {
        'total_indices': len(indices),
        'indices_without_replicas': sum(1 for i in indices if i.get('rep') == '0'),
        'total_store_bytes': total_store,
        'total_docs': total_docs,
        'total_shards': total_shards,
        'unassignable_replicas': unassignable_replicas,
        'oversharded_indices': oversharded,
    }


def _block_nodes(raw):
    """Tabela de utilização por nó + contagens de topologia.
    Combina cat.nodes (recursos) e nodes.info (roles)."""
    nodes = raw['cat_nodes']
    nodes_info_body = raw['nodes_info']

    node_roles_map = {
        info.get('name', ''): list(info.get('roles', []))
        for info in nodes_info_body.get('nodes', {}).values()
    }

    return {
        'total_nodes': len(nodes),
        'dedicated_master_nodes': sum(
            1 for roles in node_roles_map.values()
            if 'master' in roles and not DATA_ROLES.intersection(roles)
        ),
        'master_eligible_nodes': sum(
            1 for roles in node_roles_map.values() if 'master' in roles
        ),
        # Per-node summary for dashboard resource table
        'nodes_summary': [
            {
                'name': n.get('name', ''),
                'ip': n.get('ip', ''),
                'version': n.get('version', ''),
                'is_master': n.get('master') == '*',
                'roles': node_roles_map.get(n.get('name', ''), []),
                'cpu': safe_float(n.get('cpu')),
                'heap_percent': safe_float(n.get('heap.percent')),
                'heap_max': safe_int(n.get('heap.max')),
                'ram_total': safe_int(n.get('ram.max')),
                'disk_used_percent': safe_float(n.get('disk.used_percent')),
                'disk_used': safe_int(n.get('disk.used')),
                'disk_total': safe_int(n.get('disk.total')),
            }
            for n in nodes
        ],
        # Versões distintas em uso (detecta rolling upgrade em andamento/incompleto)
        'node_versions': sorted({n.get('version', '') for n in nodes if n.get('version')}),
    }


# Bloco → (fontes que ele consome, builder).
DASHBOARD_BLOCKS = {
    'health':           (('health',), _block_health),
    'indices':          (('health', 'cat_indices'), _block_indices),
    'nodes':            (('cat_nodes', 'nodes_info'), _block_nodes),
}

# Seção da interface → blocos que a alimentam. É o contrato de ?sections= da
# rota /api/dashboard; os nomes espelham os ids de seção do frontend
# (refreshSection / SECTION_RENDERERS em static/js/app.js).
DASHBOARD_SECTIONS = {
    # Página Sinais Vitais
    'health':    ('health', 'indices'),
    'resources': ('nodes',),
}


def dashboard(sections=None):
    """Coleta e resume as métricas do dashboard, sempre com dados frescos.

    `sections=None` coleta tudo (carga inicial e refresh global). Com uma lista
    de seções, só os blocos daquelas seções são coletados — é o que faz o
    refresh de uma seção consultar apenas os endpoints que ela usa.

    Pode levantar exceção apenas em cluster.health (crítico); o restante degrada
    para defaults."""
    if sections is None:
        blocks = list(DASHBOARD_BLOCKS)
    else:
        blocks = []
        for name in sections:
            for block in DASHBOARD_SECTIONS[name]:
                if block not in blocks:
                    blocks.append(block)

    sources = {src for b in blocks for src in DASHBOARD_BLOCKS[b][0]}
    raw = _collect(sources)

    result = {}
    for block in blocks:
        result.update(DASHBOARD_BLOCKS[block][1](raw))

    result['es_version'] = _info.get('version', '')
    return result


# ─── Detalhes por métrica ─────────────────────────────────
def _detail_cluster_health():
    health = fetch_cluster_health_indices()
    result = [{'index': name, **dict(stats)} for name, stats in health.get('indices', {}).items()]
    result.sort(key=lambda x: (['red', 'yellow', 'green'].index(x.get('status', 'green')), x['index']))
    return result


def _detail_all_indices():
    return [dict(i) for i in _client.cat.indices(
        h=CAT_INDICES_COLS, format='json', expand_wildcards='all', s='index')]


def _detail_indices_without_replicas():
    indices = [dict(i) for i in _client.cat.indices(
        h=CAT_INDICES_COLS, format='json', expand_wildcards='all')]
    result = [i for i in indices if i.get('rep') == '0']
    result.sort(key=lambda x: x.get('index', ''))
    return result


def _detail_unassignable_replicas():
    """Índices cujo nº de réplicas >= nº de data nodes — réplicas que nunca alocam."""
    data_nodes = fetch_cluster_health()['number_of_data_nodes']
    indices = [dict(i) for i in _client.cat.indices(
        h=CAT_INDICES_COLS, format='json', expand_wildcards='all')]
    result = [i for i in indices
              if safe_int(i.get('rep')) > 0 and data_nodes > 0 and safe_int(i.get('rep')) >= data_nodes]
    result.sort(key=lambda x: x.get('index', ''))
    return result


def _detail_oversharded_indices():
    """Índices com vários primários e tamanho médio por shard < 1 GB."""
    indices = fetch_cat_indices()
    result = []
    for i in indices:
        pri = safe_int(i.get('pri'))
        pri_store = safe_int(i.get('pri.store.size'))
        if pri > 1 and pri_store > 0 and (pri_store / pri) < GB_1:
            result.append({
                'index': i.get('index'),
                'pri': pri,
                'rep': safe_int(i.get('rep')),
                'pri_store_bytes': pri_store,
                'avg_shard_bytes': pri_store / pri,
                'docs': safe_int(i.get('docs.count')),
            })
    result.sort(key=lambda x: x['avg_shard_bytes'])
    return result


_DETAIL_DISPATCH = {
    'cluster_health': _detail_cluster_health,
    'all_indices': _detail_all_indices,
    'indices_without_replicas': _detail_indices_without_replicas,
    'unassignable_replicas': _detail_unassignable_replicas,
    'oversharded_indices': _detail_oversharded_indices,
}


def detail(metric):
    """Retorna os dados de uma métrica de detalhe, ou None se a métrica é desconhecida."""
    fn = _DETAIL_DISPATCH.get(metric)
    return fn() if fn else None
