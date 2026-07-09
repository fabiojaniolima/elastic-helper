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
GB_50 = 50 * 1024 ** 3
GB_1 = 1024 ** 3      # limite abaixo do qual um shard primário médio é "pequeno demais"
CB_USAGE_ALERT = 65  # % do limite a partir do qual um circuit breaker já interessa

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


# Só estas chaves de settings são usadas (ILM + blocos de escrita). Buscar o
# settings inteiro de todos os índices é caro em clusters grandes; filter_path
# corta o payload na origem. `index.uuid` entra apenas para garantir que TODO
# índice apareça na resposta — filter_path omite índices sem nenhuma chave casada,
# e a contagem de índices SEM ILM depende de enumerar todos eles.
INDEX_SETTINGS_FILTER = (
    '*.settings.index.uuid',
    '*.settings.index.lifecycle.name',
    '*.settings.index.blocks.read_only',
    '*.settings.index.blocks.read_only_allow_delete',
    '*.settings.index.blocks.write',
    '*.settings.index.blocks.metadata',
)


def _load_index_settings():
    """Busca apenas as settings usadas (ILM + blocos) e reachata para o formato de
    chaves pontilhadas que os consumidores esperam (como o antigo flat_settings):
    {índice: {'settings': {'index.lifecycle.name': ..., 'index.blocks.*': ...}}}.

    filter_path não combina com flat_settings (os pontos da chave plana viram
    separadores de caminho), por isso buscamos aninhado e achatamos aqui."""
    raw = _client.indices.get_settings(
        expand_wildcards='all', filter_path=','.join(INDEX_SETTINGS_FILTER)).body
    result = {}
    for name, cfg in raw.items():
        idx = cfg.get('settings', {}).get('index', {})
        flat = {}
        lifecycle_name = idx.get('lifecycle', {}).get('name')
        if lifecycle_name is not None:
            flat['index.lifecycle.name'] = lifecycle_name
        for bkey, bval in idx.get('blocks', {}).items():
            flat[f'index.blocks.{bkey}'] = bval
        result[name] = {'settings': flat}
    return result


def fetch_index_settings():
    return _load_index_settings()


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


def fetch_cat_shards():
    """cat.shards (index/prirep/store em bytes) — uma das chamadas mais caras do ES.
    Compartilhada entre o dashboard e o detalhe de shards primários grandes."""
    return list(_client.cat.shards(h='index,prirep,store', format='json', bytes='b'))


def fetch_cat_nodes():
    """cat.nodes com as colunas da tabela "Utilização por Nó" (bytes crus)."""
    return list(_client.cat.nodes(
        h='name,ip,version,cpu,heap.percent,heap.max,ram.max,disk.used_percent,'
          'disk.used,disk.total,master',
        format='json', bytes='b'))


def fetch_ilm_lifecycle():
    return _client.ilm.get_lifecycle()


def fetch_ilm_errors():
    return _client.ilm.explain_lifecycle(index='*', only_errors=True).body


def fetch_nodes_info():
    return _client.nodes.info(metric='settings,os').body


def fetch_nodes_stats():
    return _client.nodes.stats(metric='jvm,thread_pool,breaker,indexing_pressure').body


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


def build_jvm_map(nodes_stats_body):
    """Return {node_name: {mem_pressure, gc_overhead}} from nodes.stats jvm data."""
    jvm_map = {}
    for node_data in nodes_stats_body.get('nodes', {}).values():
        name = node_data.get('name', '')
        jvm = node_data.get('jvm', {})
        uptime_ms = jvm.get('uptime_in_millis', 0)
        pools = jvm.get('mem', {}).get('pools', {})
        old_used = pools.get('old', {}).get('used_in_bytes', 0)
        old_max = pools.get('old', {}).get('max_in_bytes', 0)
        gc = jvm.get('gc', {}).get('collectors', {})
        total_gc_ms = (gc.get('young', {}).get('collection_time_in_millis', 0) +
                       gc.get('old', {}).get('collection_time_in_millis', 0))
        jvm_map[name] = {
            'mem_pressure': round(old_used / old_max * 100, 1) if old_max > 0 else 0,
            'gc_overhead': round(total_gc_ms / uptime_ms * 100, 1) if uptime_ms > 0 else 0,
        }
    return jvm_map


def _primary_shard_stats(shards):
    """{index: {max, total, count}} dos shards primários a partir de cat.shards.

    `max` é o maior shard primário individual (critério correto para o limite de
    50 GB — a boa prática do ES é por shard, não pela soma do índice)."""
    stats = {}
    for s in shards:
        if s.get('prirep') != 'p':
            continue
        idx = s.get('index')
        size = safe_int(s.get('store'))
        entry = stats.setdefault(idx, {'max': 0, 'total': 0, 'count': 0})
        entry['max'] = max(entry['max'], size)
        entry['total'] += size
        entry['count'] += 1
    return stats


def build_breaker_map(nodes_stats_body):
    """Return {node_name: {trips_total, parent_trips, parent_pct}} from nodes.stats breakers."""
    bmap = {}
    for node_data in nodes_stats_body.get('nodes', {}).values():
        name = node_data.get('name', '')
        breakers = node_data.get('breakers', {})
        trips_total = sum(safe_int(b.get('tripped')) for b in breakers.values())
        parent = breakers.get('parent', {})
        p_est = safe_int(parent.get('estimated_size_in_bytes'))
        p_lim = safe_int(parent.get('limit_size_in_bytes'))
        bmap[name] = {
            'trips_total': trips_total,
            'parent_trips': safe_int(parent.get('tripped')),
            'parent_pct': round(p_est / p_lim * 100, 1) if p_lim > 0 else 0,
        }
    return bmap


def build_indexing_pressure_map(nodes_stats_body):
    """Return {node_name: {pressure_pct, rejections}} from nodes.stats indexing_pressure.

    `pressure_pct` é a memória de buffer de indexação em uso AGORA sobre o limite
    (`current.combined_coordinating_and_primary / limit`) — indicador antecipado e ao
    vivo de saturação de escrita; a 100% o nó passa a rejeitar escrita (HTTP 429).
    `rejections` é o acumulado desde o boot (coordinating + primary + replica) —
    indicador tardio. Nós sem o bloco (versão antiga/sem role de escrita) → zeros."""
    imap = {}
    for node_data in nodes_stats_body.get('nodes', {}).values():
        name = node_data.get('name', '')
        mem = node_data.get('indexing_pressure', {}).get('memory', {})
        current = safe_int(mem.get('current', {}).get('combined_coordinating_and_primary_in_bytes'))
        limit = safe_int(mem.get('limit_in_bytes'))
        total = mem.get('total', {})
        rejections = (safe_int(total.get('coordinating_rejections')) +
                      safe_int(total.get('primary_rejections')) +
                      safe_int(total.get('replica_rejections')))
        imap[name] = {
            'pressure_pct': round(current / limit * 100, 1) if limit > 0 else 0,
            'rejections': rejections,
        }
    return imap


def _is_true(v):
    return v in (True, 'true', 'True')


# ─── Blocos de escrita por índice (read-only) ─────────────
READ_ONLY_BLOCKS = (
    ('index.blocks.read_only_allow_delete', 'read_only_allow_delete (flood-stage)'),
    ('index.blocks.read_only', 'read_only'),
    ('index.blocks.write', 'write'),
    ('index.blocks.metadata', 'metadata'),
)


def index_block_labels(flat_settings):
    """Rótulos dos blocos de escrita ativos num índice (de index.get_settings flat)."""
    return [label for key, label in READ_ONLY_BLOCKS if _is_true(flat_settings.get(key))]


def classify_index_block(flat_settings):
    """Classifica o bloqueio de escrita de um índice. Retorna (categoria, rótulos):
      'flood'    → `read_only_allow_delete` (flood-stage de disco; sempre um problema)
      'manual'   → `read_only`/`write`/`metadata` em índice SEM ILM (bloqueio manual,
                   pode ser intencional ou esquecido)
      'expected' → mesmos blocos, mas em índice gerenciado por ILM (a ação `readonly`,
                   `shrink`, `forcemerge` ou searchable snapshot deixa o índice read-only
                   de propósito — não é alerta)
      None       → sem bloqueio
    """
    labels = index_block_labels(flat_settings)
    if not labels:
        return None, labels
    if _is_true(flat_settings.get('index.blocks.read_only_allow_delete')):
        return 'flood', labels
    ilm_managed = bool(flat_settings.get('index.lifecycle.name'))
    return ('expected' if ilm_managed else 'manual'), labels


# ─── Dashboard ────────────────────────────────────────────
DATA_ROLES = {'data', 'data_hot', 'data_warm', 'data_cold', 'data_frozen', 'data_content'}

# Fontes de dados do dashboard: nome interno → (fetcher, default quando falha).
# `health` é a única sem default: é crítica e a exceção propaga para a rota.
DASHBOARD_SOURCES = {
    'health':           (fetch_cluster_health, None),
    'cat_indices':      (fetch_cat_indices, []),
    'cat_shards':       (fetch_cat_shards, []),
    'cat_nodes':        (fetch_cat_nodes, []),
    'ilm':              (fetch_ilm_lifecycle, {}),
    'ilm_errors':       (fetch_ilm_errors, {}),
    'index_settings':   (fetch_index_settings, {}),
    'nodes_info':       (fetch_nodes_info, {}),
    'nodes_stats':      (fetch_nodes_stats, {}),
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


def _block_shards(raw):
    # Flag por shard primário individual > 50 GB (não pela soma do índice)
    shard_stats = _primary_shard_stats(raw['cat_shards'])
    return {'large_primary_shards': sum(1 for st in shard_stats.values() if st['max'] > GB_50)}


def _block_ilm(raw):
    try:
        count = sum(1 for p in raw['ilm'].values()
                    if 'delete' not in p.get('policy', {}).get('phases', {}))
    except Exception:
        count = 0
    return {'ilm_without_delete': count}


def _block_ilm_errors(raw):
    # Índices parados num passo de ERRO do ILM
    try:
        count = len(raw['ilm_errors'].get('indices', {}))
    except Exception:
        count = 0
    return {'ilm_errors': count}


def _block_index_settings(raw):
    settings = raw['index_settings']
    try:
        without_ilm = sum(1 for cfg in settings.values()
                          if 'index.lifecycle.name' not in cfg.get('settings', {}))
    except Exception:
        without_ilm = 0

    # Índices com bloqueio de escrita, separados por categoria. Flood-stage (disco)
    # é problema; read-only via ILM é esperado; read-only manual (sem ILM) é atenção.
    ro = {'flood': 0, 'manual': 0, 'expected': 0}
    try:
        for cfg in settings.values():
            cat, _ = classify_index_block(cfg.get('settings', {}))
            if cat in ro:
                ro[cat] += 1
    except Exception:
        pass

    return {'indices_without_ilm': without_ilm, 'read_only_indices': ro}


def _block_nodes(raw):
    """Tabela de utilização por nó + contagens de topologia e circuit breakers.
    Combina cat.nodes (recursos), nodes.info (roles) e nodes.stats (JVM, filas)."""
    nodes = raw['cat_nodes']
    nodes_info_body = raw['nodes_info']
    nodes_stats_body = raw['nodes_stats']

    # Thread pool rejections (lagging) + current queue (leading) per node
    node_rejections = {}
    node_tp_queue = {}
    for node_data in nodes_stats_body.get('nodes', {}).values():
        name = node_data.get('name', '')
        rejected = queued = 0
        for pool_data in node_data.get('thread_pool', {}).values():
            rejected += safe_int(pool_data.get('rejected'))
            queued += safe_int(pool_data.get('queue'))
        node_rejections[name] = node_rejections.get(name, 0) + rejected
        node_tp_queue[name] = node_tp_queue.get(name, 0) + queued

    node_roles_map = {
        info.get('name', ''): list(info.get('roles', []))
        for info in nodes_info_body.get('nodes', {}).values()
    }

    # JVM memory pressure / GC overhead and circuit breakers per node
    node_jvm_map = build_jvm_map(nodes_stats_body)
    node_breaker_map = build_breaker_map(nodes_stats_body)
    node_indexing_map = build_indexing_pressure_map(nodes_stats_body)

    return {
        'total_nodes': len(nodes),
        'dedicated_master_nodes': sum(
            1 for roles in node_roles_map.values()
            if 'master' in roles and not DATA_ROLES.intersection(roles)
        ),
        'master_eligible_nodes': sum(
            1 for roles in node_roles_map.values() if 'master' in roles
        ),
        'circuit_breaker_trips': sum(b['trips_total'] for b in node_breaker_map.values()),
        'circuit_breaker_parent_trips': sum(b['parent_trips'] for b in node_breaker_map.values()),
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
                'rejections': node_rejections.get(n.get('name', ''), 0),
                'tp_queue': node_tp_queue.get(n.get('name', ''), 0),
                'mem_pressure': node_jvm_map.get(n.get('name', ''), {}).get('mem_pressure', 0),
                'gc_overhead': node_jvm_map.get(n.get('name', ''), {}).get('gc_overhead', 0),
                'parent_cb_pct': node_breaker_map.get(n.get('name', ''), {}).get('parent_pct', 0),
                'write_pressure_pct': node_indexing_map.get(n.get('name', ''), {}).get('pressure_pct', 0),
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
    'shards':           (('cat_shards',), _block_shards),
    'ilm':              (('ilm',), _block_ilm),
    'ilm_errors':       (('ilm_errors',), _block_ilm_errors),
    'index_settings':   (('index_settings',), _block_index_settings),
    'nodes':            (('cat_nodes', 'nodes_info', 'nodes_stats'), _block_nodes),
}

# Seção da interface → blocos que a alimentam. É o contrato de ?sections= da
# rota /api/dashboard; os nomes espelham os ids de seção do frontend
# (refreshSection / SECTION_RENDERERS em static/js/app.js).
DASHBOARD_SECTIONS = {
    # Página Sinais Vitais
    'health':    ('health', 'indices'),
    'signals':   ('health', 'ilm_errors', 'index_settings', 'nodes'),
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


def _detail_large_primary_shards():
    shards = fetch_cat_shards()
    stats = _primary_shard_stats(shards)
    result = [
        {
            'index': idx,
            'shard_count': st['count'],
            'total_size_bytes': st['total'],
            'max_shard_bytes': st['max'],
        }
        for idx, st in stats.items() if st['max'] > GB_50
    ]
    result.sort(key=lambda x: x['max_shard_bytes'], reverse=True)
    return result


def _detail_indices_without_ilm():
    settings = fetch_index_settings()
    idx_map = {i['index']: i for i in _client.cat.indices(
        h='index,health,status,pri,rep,store.size,docs.count',
        format='json', expand_wildcards='all')}
    result = []
    for name, cfg in settings.items():
        if 'index.lifecycle.name' not in cfg.get('settings', {}):
            info = idx_map.get(name, {})
            result.append({
                'index': name,
                'health': info.get('health', '-'),
                'status': info.get('status', '-'),
                'pri': info.get('pri', '-'),
                'rep': info.get('rep', '-'),
                'store.size': info.get('store.size', '-'),
                'docs.count': info.get('docs.count', '-'),
            })
    result.sort(key=lambda x: x['index'])
    return result


def _detail_ilm_without_delete():
    policies = fetch_ilm_lifecycle()

    policy_index_counts = {}
    try:
        for cfg in fetch_index_settings().values():
            p = cfg.get('settings', {}).get('index.lifecycle.name', '')
            if p:
                policy_index_counts[p] = policy_index_counts.get(p, 0) + 1
    except Exception:
        pass

    result = []
    for name, policy in policies.items():
        phases = policy.get('policy', {}).get('phases', {})
        if 'delete' not in phases:
            result.append({
                'name': name,
                'phases': list(phases.keys()),
                'modified_date': policy.get('modified_date', '-'),
                'index_count': policy_index_counts.get(name, 0),
            })
    result.sort(key=lambda x: x['name'])
    return result


def _detail_ilm_errors():
    explain = fetch_ilm_errors()
    result = []
    for name, info in explain.get('indices', {}).items():
        step_info = info.get('step_info', {}) or {}
        result.append({
            'index': name,
            'policy': info.get('policy', '-'),
            'phase': info.get('phase', '-'),
            'action': info.get('action', '-'),
            'failed_step': info.get('failed_step', info.get('step', '-')),
            'error_type': step_info.get('type', '-'),
            'error_reason': step_info.get('reason') or step_info.get('message') or '-',
            'age': info.get('age', '-'),
            'failed_step_retry_count': info.get('failed_step_retry_count', '-'),
            'step_info': step_info,
        })
    result.sort(key=lambda x: x['index'])
    return result


def _detail_nodes():
    """Coleta paralela: cat.nodes, nodes.info, cat.shards (caro), nodes.stats e
    cat.thread_pool são independentes — rodam juntos em vez de sequencialmente."""
    with ThreadPoolExecutor(max_workers=5) as pool:
        f_nodes = pool.submit(lambda: [dict(n) for n in _client.cat.nodes(
            h='name,ip,cpu,heap.percent,heap.current,heap.max,disk.used_percent,disk.used,'
              'disk.avail,disk.total,node.role,master,load_1m,load_5m,load_15m',
            format='json', s='name')])
        f_info = pool.submit(fetch_nodes_info)
        f_shards = pool.submit(lambda: list(_client.cat.shards(h='node,prirep,state', format='json')))
        f_stats = pool.submit(fetch_nodes_stats)
        f_tp = pool.submit(lambda: list(_client.cat.thread_pool(
            h='node_name,rejected,queue', format='json')))

    nodes = safe_result(f_nodes, [])
    nodes_info_body = safe_result(f_info, {})

    roles_map = {}
    processors_map = {}
    for info in nodes_info_body.get('nodes', {}).values():
        node_name = info.get('name', '')
        roles_map[node_name] = list(info.get('roles', []))
        processors_map[node_name] = info.get('os', {}).get('available_processors', 0)

    shard_counts = {}
    for s in safe_result(f_shards, []):
        node_name = s.get('node', '')
        counts = shard_counts.setdefault(node_name, {'primary': 0, 'replica': 0})
        if s.get('state') in ('STARTED', 'RELOCATING'):
            if s.get('prirep') == 'p':
                counts['primary'] += 1
            elif s.get('prirep') == 'r':
                counts['replica'] += 1

    stats_body = safe_result(f_stats, {})
    jvm_map = build_jvm_map(stats_body)
    indexing_map = build_indexing_pressure_map(stats_body)

    node_rejections = {}
    node_tp_queue = {}
    for tp in safe_result(f_tp, []):
        name = tp.get('node_name', '')
        node_rejections[name] = node_rejections.get(name, 0) + safe_int(tp.get('rejected'))
        node_tp_queue[name] = node_tp_queue.get(name, 0) + safe_int(tp.get('queue'))

    for node in nodes:
        name = node.get('name', '')
        counts = shard_counts.get(name, {'primary': 0, 'replica': 0})
        node['shards_primary'] = counts['primary']
        node['shards_replica'] = counts['replica']
        node['roles'] = roles_map.get(name, [])
        nd = jvm_map.get(name, {})
        node['mem_pressure'] = nd.get('mem_pressure', 0)
        node['gc_overhead'] = nd.get('gc_overhead', 0)
        node['available_processors'] = processors_map.get(name, 0)
        node['rejections'] = node_rejections.get(name, 0)
        node['tp_queue'] = node_tp_queue.get(name, 0)
        ip = indexing_map.get(name, {})
        node['write_pressure_pct'] = ip.get('pressure_pct', 0)
        node['indexing_rejections'] = ip.get('rejections', 0)

    return nodes


def _detail_circuit_breakers():
    # Só os breakers que importam: já derrubaram requisições (tripped > 0)
    # ou estão perto do limite (uso >= CB_USAGE_ALERT, faixa amarela no front).
    result = []
    for node_data in fetch_nodes_stats().get('nodes', {}).values():
        node_name = node_data.get('name', '')
        for bname, b in node_data.get('breakers', {}).items():
            est = safe_int(b.get('estimated_size_in_bytes'))
            lim = safe_int(b.get('limit_size_in_bytes'))
            tripped = safe_int(b.get('tripped'))
            usage_pct = round(est / lim * 100, 1) if lim > 0 else 0
            if tripped == 0 and usage_pct < CB_USAGE_ALERT:
                continue
            result.append({
                'node': node_name,
                'breaker': bname,
                'tripped': tripped,
                'estimated_size_in_bytes': est,
                'limit_size_in_bytes': lim,
                'usage_pct': usage_pct,
            })
    result.sort(key=lambda x: (x['tripped'], x['usage_pct']), reverse=True)
    return result


def _detail_pending_tasks():
    resp = _client.cluster.pending_tasks()
    tasks = [dict(t) for t in resp.body.get('tasks', [])]
    tasks.sort(key=lambda x: safe_int(x.get('time_in_queue_millis')), reverse=True)
    return tasks


def _detail_read_only_indices():
    """Índices com bloqueio de escrita que merecem atenção — flood-stage (disco) e
    read-only manual (sem ILM). Bloqueios read-only definidos pelo ILM (esperados)
    não entram na lista."""
    settings = fetch_index_settings()
    idx_map = {i['index']: i for i in _client.cat.indices(
        h='index,health,status,pri,rep,store.size,docs.count',
        format='json', expand_wildcards='all')}
    result = []
    for name, cfg in settings.items():
        cat, labels = classify_index_block(cfg.get('settings', {}))
        if cat not in ('flood', 'manual'):
            continue
        info = idx_map.get(name, {})
        result.append({
            'index': name,
            'category': cat,
            'blocks': ', '.join(labels),
            'health': info.get('health', '-'),
            'status': info.get('status', '-'),
            'store.size': info.get('store.size', '-'),
            'docs.count': info.get('docs.count', '-'),
        })
    order = {'flood': 0, 'manual': 1}
    result.sort(key=lambda x: (order.get(x['category'], 2), x['index']))
    return result


_DETAIL_DISPATCH = {
    'cluster_health': _detail_cluster_health,
    'all_indices': _detail_all_indices,
    'indices_without_replicas': _detail_indices_without_replicas,
    'unassignable_replicas': _detail_unassignable_replicas,
    'oversharded_indices': _detail_oversharded_indices,
    'large_primary_shards': _detail_large_primary_shards,
    'indices_without_ilm': _detail_indices_without_ilm,
    'ilm_without_delete': _detail_ilm_without_delete,
    'ilm_errors': _detail_ilm_errors,
    'nodes': _detail_nodes,
    'circuit_breakers': _detail_circuit_breakers,
    'pending_tasks': _detail_pending_tasks,
    'read_only_indices': _detail_read_only_indices,
}


def detail(metric):
    """Retorna os dados de uma métrica de detalhe, ou None se a métrica é desconhecida."""
    fn = _DETAIL_DISPATCH.get(metric)
    return fn() if fn else None


# ─── Detalhe de um nó específico ──────────────────────────
def node_detail(node_name):
    """Coleta paralela de nodes.info + nodes.stats filtrados para um único nó.

    Chamado sob demanda (clique na caixinha da Topologia), fora dos blocos do
    dashboard. Retorna um dict limpo com seções identity/os/cpu/memory/
    jvm/disk/process com valores em tipos Python nativos.
    """
    with ThreadPoolExecutor(max_workers=2) as pool:
        f_info  = pool.submit(lambda: _client.nodes.info(
            node_id=node_name, metric='os,jvm,process,settings').body)
        f_stats = pool.submit(lambda: _client.nodes.stats(
            node_id=node_name, metric='os,jvm,fs,process').body)

    info_body  = safe_result(f_info,  {})
    stats_body = safe_result(f_stats, {})

    # Ambas as respostas têm a mesma estrutura {'nodes': {'<id>': {...}}}
    info_node  = next(iter(info_body.get('nodes',  {}).values()), {})
    stats_node = next(iter(stats_body.get('nodes', {}).values()), {})

    os_info  = info_node.get('os', {})
    jvm_info = info_node.get('jvm', {})
    os_stat  = stats_node.get('os', {})
    jvm_stat = stats_node.get('jvm', {})
    fs_stat  = stats_node.get('fs', {})
    proc     = stats_node.get('process', {})
    info_proc = info_node.get('process', {})  # mlockall (heap travado na RAM) vem daqui

    os_mem   = os_stat.get('mem', {})
    os_swap  = os_stat.get('swap', {})
    os_cpu   = os_stat.get('cpu', {})
    os_load  = os_cpu.get('load_average', {})
    jvm_mem  = jvm_stat.get('mem', {})
    jvm_info_mem = jvm_info.get('mem', {})
    fs_total = fs_stat.get('total', {})

    # Mounts por caminho (fs.data[])
    mounts = [
        {
            'path':      m.get('path', ''),
            'mount':     m.get('mount', ''),
            'type':      m.get('type', ''),
            'total':     safe_int(m.get('total_in_bytes')),
            'free':      safe_int(m.get('free_in_bytes')),
            'available': safe_int(m.get('available_in_bytes')),
        }
        for m in fs_stat.get('data', [])
    ]

    return {
        'identity': {
            'name':              info_node.get('name', node_name),
            'ip':                info_node.get('ip', ''),
            'host':              info_node.get('host', ''),
            'transport_address': info_node.get('transport_address', ''),
            'version':           info_node.get('version', ''),
            'build_flavor':      info_node.get('build_flavor', ''),
            'build_type':        info_node.get('build_type', ''),
            'build_hash':        info_node.get('build_hash', ''),
            'roles':             list(info_node.get('roles', [])),
        },
        'os': {
            'name':                  os_info.get('name', ''),
            'pretty_name':           os_info.get('pretty_name', ''),
            'arch':                  os_info.get('arch', ''),
            'version':               os_info.get('version', ''),
            'available_processors':  safe_int(os_info.get('available_processors')),
            'allocated_processors':  safe_int(os_info.get('allocated_processors')),
        },
        'cpu': {
            'percent':      safe_int(os_cpu.get('percent')),
            'load_1m':      safe_float(os_load.get('1m')),
            'load_5m':      safe_float(os_load.get('5m')),
            'load_15m':     safe_float(os_load.get('15m')),
            'proc_percent': safe_int(proc.get('cpu', {}).get('percent')),
        },
        'memory': {
            'total':        safe_int(os_mem.get('total_in_bytes')),
            'used':         safe_int(os_mem.get('used_in_bytes')),
            'free':         safe_int(os_mem.get('free_in_bytes')),
            'used_percent': safe_int(os_mem.get('used_percent')),
            'swap_total':   safe_int(os_swap.get('total_in_bytes')),
            'swap_used':    safe_int(os_swap.get('used_in_bytes')),
            'swap_free':    safe_int(os_swap.get('free_in_bytes')),
            'mlockall':     info_proc.get('mlockall'),
        },
        'jvm': {
            'version':             jvm_info.get('version', ''),
            'vm_name':             jvm_info.get('vm_name', ''),
            'vm_vendor':           jvm_info.get('vm_vendor', ''),
            'heap_max':            safe_int(jvm_info_mem.get('heap_max_in_bytes')),
            'heap_init':           safe_int(jvm_info_mem.get('heap_init_in_bytes')),
            'heap_used':           safe_int(jvm_mem.get('heap_used_in_bytes')),
            'heap_used_percent':   safe_int(jvm_mem.get('heap_used_percent')),
            'non_heap_used':       safe_int(jvm_mem.get('non_heap_used_in_bytes')),
            'uptime_millis':       safe_int(jvm_stat.get('uptime_in_millis')),
            'threads':             safe_int(jvm_stat.get('threads', {}).get('count')),
            'start_time_millis':   safe_int(jvm_info.get('start_time_in_millis')),
        },
        'disk': {
            'total':     safe_int(fs_total.get('total_in_bytes')),
            'free':      safe_int(fs_total.get('free_in_bytes')),
            'available': safe_int(fs_total.get('available_in_bytes')),
            'mounts':    mounts,
        },
        'process': {
            'open_fds': safe_int(proc.get('open_file_descriptors')),
            'max_fds':  safe_int(proc.get('max_file_descriptors')),
        },
    }
