"""Camada de acesso ao Logstash (instâncias, pipelines, filas, DLQ e plugins).

Mesma estrutura de `kibana_service.py` — estado em variáveis de módulo, coleta
paralela e **sem cache** — sobre a base comum de `monitoring_common.py`.

Três fontes alimentam as métricas, com precedência **por métrica**:

  1. **Elastic Agent** — `metrics-system.*`: RAM e disco **do host**;
  2. **Self-monitoring** — `.monitoring-logstash-*` e
     `metrics-logstash.stack_monitoring.node_stats-*` no cluster ES conectado;
  3. **API de monitoramento do Logstash** — `/_node/stats` de cada URL cadastrada.

Diferenças que importam em relação ao Kibana:

- **CPU existe na API** (`process.cpu.percent`) — é a CPU do *processo* Logstash,
  e é ela que a tabela mostra. RAM e disco continuam sendo do *host* e só vêm do
  Elastic Agent (a API do Logstash não expõe nenhum dos dois).
- **Pipelines, filas, DLQ e plugins só existem na fonte 3.** O self-monitoring
  traz totais do nó; o detalhamento por pipeline exige URL cadastrada.
- Os contadores de eventos são **acumulados desde o start** do processo, não
  taxas. O throughput exibido é a média desde o start (eventos ÷ uptime) — sem
  duas coletas não há como calcular a taxa instantânea, e inventar uma seria
  pior do que rotular a média honestamente.

Ver `docs/logstash.md`.
"""
from concurrent.futures import ThreadPoolExecutor
import logging

import monitoring_common as mc
from monitoring_common import dig

logger = logging.getLogger('elastic-helper')

MAX_INSTANCES = mc.MAX_INSTANCES
MAX_SLOW_PLUGINS = 12      # linhas da tabela de gargalos

# A API de monitoramento (9600) atende em HTTP salvo `api.ssl.enabled: true`.
DEFAULT_SCHEME = 'http'

# Índices de monitoramento do Logstash: legacy + Elastic Agent.
MONITORING_INDICES = ('.monitoring-logstash-*,'
                      'metrics-logstash.stack_monitoring.node_stats-*')


def normalize_url(raw):
    """URL da instância Logstash (HTTP quando o esquema não vem escrito)."""
    return mc.normalize_url(raw, DEFAULT_SCHEME)


def _http_get(base_url, path, auth, params=None):
    """GET na API de monitoramento; (dados, None) ou (None, motivo)."""
    return mc.http_get(base_url, path, auth, params, default_scheme=DEFAULT_SCHEME)


def test_instance(url, username, password):
    """Valida URL + credenciais numa instância. Retorna nome/versão/status.

    A API do Logstash é aberta por padrão (`api.auth.type: none`), então
    credenciais vazias são um caso normal, não um erro de preenchimento.
    """
    auth = (username, password) if username else None
    data, err = _http_get(url, '/', auth)
    if err:
        raise RuntimeError(err)
    return {
        'name': (data or {}).get('name', ''),
        'version': (data or {}).get('version', ''),
        'status': (data or {}).get('status', ''),
        'host': (data or {}).get('host', ''),
    }


# ─── Extratores (servem à API e ao self-monitoring) ───────
def _events(ev):
    """Contadores de eventos, **acumulados desde o start**.

    `duration_in_millis` é o tempo total gasto processando; dividido pelos
    eventos de saída dá o custo médio por evento, que é comparável entre
    pipelines de volumes diferentes.
    """
    ev = ev or {}
    out = {
        'in': mc.num(mc.scalar(ev.get('in'))),
        'filtered': mc.num(mc.scalar(ev.get('filtered'))),
        'out': mc.num(mc.scalar(ev.get('out'))),
        'duration_ms': mc.num(mc.scalar(ev.get('duration_in_millis'))
                              or mc.scalar(ev.get('duration'), 'ms')),
        'queue_push_duration_ms': mc.num(
            mc.scalar(ev.get('queue_push_duration_in_millis'))
            or mc.scalar(ev.get('queue_push_duration'), 'ms')),
    }
    out['avg_event_ms'] = (round(out['duration_ms'] / out['out'], 3)
                           if out['out'] else None)
    return out


def _per_sec(events_out, uptime_ms):
    """Eventos por segundo médios desde o start (None sem uptime utilizável)."""
    if not uptime_ms or uptime_ms <= 0:
        return None
    return round(events_out / (uptime_ms / 1000.0), 1)


def _iter_pipelines(pipelines):
    """(id, stats) de cada pipeline, nos dois formatos.

    A API devolve um dicionário indexado pelo nome do pipeline; o
    self-monitoring legacy grava uma **lista** com o nome no campo `id`.
    """
    if isinstance(pipelines, dict):
        for pid, stats in pipelines.items():
            if isinstance(stats, dict):
                yield pid, stats
    elif isinstance(pipelines, list):
        for stats in pipelines:
            if isinstance(stats, dict):
                yield stats.get('id') or '(sem id)', stats


def _plugin_rows(pid, pipeline_stats, pipeline_duration_ms):
    """Plugins de um pipeline com o custo de cada um, para achar o gargalo.

    Só `filters` e `outputs` entram: um `input` não tem `duration_in_millis` —
    o tempo dele é espera por dados, não processamento, e apareceria como
    gargalo permanente.
    """
    rows = []
    plugins = pipeline_stats.get('plugins') or {}
    for kind, label in (('filters', 'filter'), ('outputs', 'output')):
        for plugin in plugins.get(kind) or []:
            if not isinstance(plugin, dict):
                continue
            ev = _events(plugin.get('events'))
            # Para filtros o denominador natural é a entrada; para outputs, o
            # que efetivamente saiu. Um dos dois sempre serve.
            events = ev['in'] or ev['out']
            duration = ev['duration_ms']
            rows.append({
                'pipeline': pid,
                'type': label,
                'name': plugin.get('name') or '(sem nome)',
                'id': plugin.get('id') or '',
                'events': events,
                'duration_ms': duration,
                'avg_event_ms': round(duration / events, 3) if events else None,
                'share_pct': mc.pct(duration, pipeline_duration_ms),
            })
    return rows


def _pipeline_fields(pid, stats, config, health):
    """Uma linha da tabela de pipelines, já com fila, DLQ e reloads."""
    ev = _events(stats.get('events'))
    queue = stats.get('queue') or {}
    capacity = queue.get('capacity') or {}
    queue_bytes = (mc.scalar(queue.get('queue_size_in_bytes'))
                   or mc.scalar(capacity.get('queue_size_in_bytes')))
    queue_max = (mc.scalar(queue.get('max_queue_size_in_bytes'))
                 or mc.scalar(capacity.get('max_queue_size_in_bytes')))
    dlq = stats.get('dead_letter_queue') or {}
    reloads = stats.get('reloads') or {}
    cfg = config or {}

    return {
        'id': pid,
        'workers': mc.scalar(cfg.get('workers')),
        'batch_size': mc.scalar(cfg.get('batch_size')),
        'events_in': ev['in'],
        'events_out': ev['out'],
        'events_filtered': ev['filtered'],
        'duration_ms': ev['duration_ms'],
        'avg_event_ms': ev['avg_event_ms'],
        # Tempo médio empurrando para a fila: sobe quando a fila é o gargalo
        # (disco lento na PQ, ou saída travando e a fila enchendo).
        'queue_push_avg_ms': (round(ev['queue_push_duration_ms'] / ev['in'], 3)
                              if ev['in'] else None),
        'queue_type': queue.get('type') or 'memory',
        'queue_events': mc.num(mc.scalar(queue.get('events_count'))
                               or mc.scalar(queue.get('events'))),
        'queue_bytes': queue_bytes,
        'queue_max_bytes': queue_max,
        'queue_pct': mc.pct(queue_bytes, queue_max),
        'queue_free_bytes': mc.scalar(dig(queue, 'data', 'free_space_in_bytes')),
        'queue_path': dig(queue, 'data', 'path'),
        'dlq_bytes': mc.scalar(dlq.get('queue_size_in_bytes')),
        'dlq_dropped': mc.num(mc.scalar(dlq.get('dropped_events'))),
        'dlq_expired': mc.num(mc.scalar(dlq.get('expired_events'))),
        'dlq_last_error': dlq.get('last_error') or '',
        'dlq_storage_policy': dlq.get('storage_policy') or '',
        'reload_successes': mc.num(mc.scalar(reloads.get('successes'))),
        'reload_failures': mc.num(mc.scalar(reloads.get('failures'))),
        'reload_last_error': reloads.get('last_error') or '',
        # Status por pipeline só existe no health report de versões recentes.
        'health_status': (health or {}).get('status'),
        'health_symptom': (health or {}).get('symptom', ''),
        'plugins': _plugin_rows(pid, stats, ev['duration_ms']),
    }


def _node_metrics(stats):
    """Métricas do nó a partir de um payload no formato de `/_node/stats`.

    O self-monitoring grava o mesmo desenho de objeto (sob `logstash_stats`),
    então o extrator serve às duas fontes — só a identidade fica em lugar
    diferente em cada uma.
    """
    jvm = stats.get('jvm') or {}
    mem = jvm.get('mem') or {}
    proc = stats.get('process') or {}

    heap_used = (mc.scalar(mem.get('heap_used_in_bytes'))
                 or mc.scalar(mem.get('heap_used'), 'bytes'))
    heap_max = (mc.scalar(mem.get('heap_max_in_bytes'))
                or mc.scalar(mem.get('heap_max'), 'bytes'))
    fd_open = mc.scalar(proc.get('open_file_descriptors'))
    fd_max = mc.scalar(proc.get('max_file_descriptors'))
    uptime_ms = (mc.scalar(jvm.get('uptime_in_millis'))
                 or mc.scalar(jvm.get('uptime'), 'ms'))
    ev = _events(stats.get('events'))
    reloads = stats.get('reloads') or {}

    return {
        # CPU do **processo** Logstash, não do host.
        'cpu_pct': mc.scalar(dig(proc, 'cpu', 'percent')),
        'load_1m': mc.scalar(dig(proc, 'cpu', 'load_average', '1m')),
        'heap_pct': mc.scalar(mem.get('heap_used_percent')) or mc.pct(heap_used, heap_max),
        'heap_used': heap_used,
        'heap_max': heap_max,
        'fd_open': fd_open,
        'fd_max': fd_max,
        'fd_pct': mc.pct(fd_open, fd_max),
        'threads': mc.scalar(dig(jvm, 'threads', 'count')),
        'uptime_ms': uptime_ms,
        'events': ev,
        'events_per_sec': _per_sec(ev['out'], uptime_ms),
        'reload_failures': mc.num(mc.scalar(reloads.get('failures'))),
        'queue_events': mc.num(mc.scalar(dig(stats, 'queue', 'events_count'))),
    }


# ─── Detalhe de uma instância (modal) ─────────────────────
# A tabela da página mostra o que é comparável entre instâncias; o resto do que
# o Logstash expõe sobre JVM, SO e processo só faz sentido olhando **uma**
# instância por vez, e é o que este bloco monta.

_POOL_ORDER = ('young', 'survivor', 'old')


def _positive(val):
    """Valor só quando positivo: a JVM usa **-1 para "sem limite"** (pools do G1,
    `non_heap_max`, `cfs_quota_micros` fora de container) e -1 num denominador
    viraria percentual negativo em vez de "não se aplica"."""
    return val if isinstance(val, (int, float)) and not isinstance(val, bool) and val > 0 else None


def _jvm_pools(mem):
    """Pools da heap na ordem do ciclo de vida do objeto (young → survivor → old)."""
    pools = mem.get('pools') or {}
    out = []
    for name in _POOL_ORDER:
        pool = pools.get(name)
        if not isinstance(pool, dict):
            continue
        used = (mc.scalar(pool.get('used_in_bytes'))
                or mc.scalar(pool.get('used'), 'bytes'))
        limit = _positive(mc.scalar(pool.get('max_in_bytes'))
                          or mc.scalar(pool.get('max'), 'bytes'))
        if used is None and limit is None:
            continue
        out.append({
            'name': name,
            'used': used,
            'max': limit,
            'peak_used': (mc.scalar(pool.get('peak_used_in_bytes'))
                          or mc.scalar(pool.get('peak_used'), 'bytes')),
            'pct': mc.pct(used, limit),
        })
    return out


def _jvm_gc(jvm, uptime_ms):
    """Coletas de GC **acumuladas desde o start**, com o overhead sobre o uptime.

    Tempo de GC ÷ uptime é a fração da vida do processo gasta coletando — um
    número honesto mesmo acumulado, porque numerador e denominador começam no
    mesmo instante. É o sinal de heap apertada que a barra de heap não dá: 40%
    de heap com 20% de overhead é pior do que 80% de heap sem GC.
    """
    collectors = []
    total_ms = 0
    total_count = 0
    for name, info in (dig(jvm, 'gc', 'collectors') or {}).items():
        if not isinstance(info, dict):
            continue
        count = mc.num(mc.scalar(info.get('collection_count')))
        time_ms = mc.num(mc.scalar(info.get('collection_time_in_millis'))
                         or mc.scalar(info.get('collection_time'), 'ms'))
        collectors.append({'name': name, 'count': count, 'time_ms': time_ms,
                           'avg_ms': round(time_ms / count, 1) if count else None})
        total_ms += time_ms
        total_count += count
    if not collectors:
        return None
    collectors.sort(key=lambda c: c['name'])
    return {'collectors': collectors, 'count': total_count, 'time_ms': total_ms,
            'overhead_pct': mc.pct(total_ms, uptime_ms)}


def _cgroup(os_stats):
    """Limite de CPU e throttling do cgroup — existe só em container.

    Com `cfs_quota` abaixo dos vCPUs do host, o Logstash tem menos CPU do que a
    contagem de processadores sugere (e `pipeline.workers`, que segue essa
    contagem, fica superdimensionado). O throttling é o sintoma direto: o
    processo é parado ao fim de cada período em que estourou a cota.
    """
    cpu = dig(os_stats, 'cgroup', 'cpu') or {}
    stat = cpu.get('stat') or {}
    quota = _positive(mc.scalar(cpu.get('cfs_quota_micros')))
    period = _positive(mc.scalar(cpu.get('cfs_period_micros')))
    throttled = mc.scalar(stat.get('number_of_times_throttled'))
    throttled_ns = mc.scalar(stat.get('time_throttled_nanos'))
    if quota is None and throttled is None:
        return None
    return {
        'control_group': cpu.get('control_group') or '',
        'cpu_limit': round(quota / period, 2) if quota and period else None,
        'throttled_pct': mc.pct(throttled, mc.scalar(stat.get('number_of_elapsed_periods'))),
        'throttled_times': mc.num(throttled),
        'throttled_ms': round(throttled_ns / 1e6) if throttled_ns else 0,
    }


# `flow` (Logstash 8.6+) é a **única taxa instantânea** que a API entrega
# pronta: `current` é a janela recente calculada pelo próprio Logstash, ao lado
# do `lifetime`, que é a média desde o start. É o que permite a modal mostrar
# "agora" sem inventar uma taxa em cima de contador acumulado.
_FLOW_KEYS = ('input_throughput', 'filter_throughput', 'output_throughput',
              'queue_backpressure', 'worker_concurrency')


def _flow(stats):
    """Taxas da seção `flow`, quando a versão a expõe (vazio nas antigas)."""
    flow = stats.get('flow') or {}
    out = {}
    for key in _FLOW_KEYS:
        node = flow.get(key)
        if not isinstance(node, dict):
            continue
        current = mc.scalar(node.get('current'))
        lifetime = mc.scalar(node.get('lifetime'))
        if current is None and lifetime is None:
            continue
        out[key] = {'current': current, 'lifetime': lifetime}
    return out


def _node_detail(stats):
    """Detalhe do nó a partir de um payload no formato `/_node/stats`.

    Como `_node_metrics`, serve às duas fontes — o self-monitoring grava o mesmo
    desenho de objeto. O que só a API tem (SO, JVM estática) entra depois, por
    `_node_info`.
    """
    jvm = stats.get('jvm') or {}
    mem = jvm.get('mem') or {}
    proc = stats.get('process') or {}
    cpu = proc.get('cpu') or {}
    load = cpu.get('load_average') or {}
    reloads = stats.get('reloads') or {}
    uptime_ms = (mc.scalar(jvm.get('uptime_in_millis'))
                 or mc.scalar(jvm.get('uptime'), 'ms'))

    return {
        'jvm': {
            'threads': mc.scalar(dig(jvm, 'threads', 'count')),
            'threads_peak': mc.scalar(dig(jvm, 'threads', 'peak_count')),
            'heap_committed': (mc.scalar(mem.get('heap_committed_in_bytes'))
                               or mc.scalar(mem.get('heap_committed'), 'bytes')),
            'non_heap_used': (mc.scalar(mem.get('non_heap_used_in_bytes'))
                              or mc.scalar(mem.get('non_heap_used'), 'bytes')),
            'non_heap_committed': (mc.scalar(mem.get('non_heap_committed_in_bytes'))
                                   or mc.scalar(mem.get('non_heap_committed'), 'bytes')),
            'pools': _jvm_pools(mem),
            'gc': _jvm_gc(jvm, uptime_ms),
        },
        'process': {
            'open_fds': mc.scalar(proc.get('open_file_descriptors')),
            'peak_fds': mc.scalar(proc.get('peak_open_file_descriptors')),
            'max_fds': mc.scalar(proc.get('max_file_descriptors')),
            'virtual_bytes': mc.scalar(dig(proc, 'mem', 'total_virtual_in_bytes')),
            'cpu_total_ms': (mc.scalar(cpu.get('total_in_millis'))
                             or mc.scalar(cpu.get('total'), 'ms')),
            'load_1m': mc.scalar(load.get('1m')),
            'load_5m': mc.scalar(load.get('5m')),
            'load_15m': mc.scalar(load.get('15m')),
        },
        'cgroup': _cgroup(stats.get('os') or {}),
        'flow': _flow(stats),
        'reload_successes': mc.num(mc.scalar(reloads.get('successes'))),
        'reload_failures': mc.num(mc.scalar(reloads.get('failures'))),
    }


def _node_info(body):
    """SO e JVM estáticos, de `GET /_node/os,jvm` — nenhuma outra fonte os tem.

    A variante com os tipos na URL evita trazer a configuração completa dos
    pipelines, que o `/_node` sem argumento devolve junto e não é usada aqui.
    """
    if not body:
        return {}
    os_info = body.get('os') or {}
    jvm = body.get('jvm') or {}
    mem = jvm.get('mem') or {}
    return {
        'os': {
            'name': os_info.get('name') or '',
            'arch': os_info.get('arch') or '',
            'version': os_info.get('version') or '',
            'processors': mc.scalar(os_info.get('available_processors')),
        },
        'jvm_info': {
            'version': jvm.get('version') or '',
            'vm_name': jvm.get('vm_name') or '',
            'vm_vendor': jvm.get('vm_vendor') or '',
            'vm_version': jvm.get('vm_version') or '',
            'pid': mc.scalar(jvm.get('pid')),
            'start_time_ms': mc.scalar(jvm.get('start_time_in_millis')),
            'gc_collectors': [c for c in (jvm.get('gc_collectors') or [])
                              if isinstance(c, str)],
            # `heap_init` é o -Xms e `heap_max` o -Xmx: o Logstash recomenda os
            # dois iguais, e é a comparação que o front faz.
            'heap_init': mc.scalar(mem.get('heap_init_in_bytes')),
            'heap_max': mc.scalar(mem.get('heap_max_in_bytes')),
            'non_heap_init': mc.scalar(mem.get('non_heap_init_in_bytes')),
            'non_heap_max': _positive(mc.scalar(mem.get('non_heap_max_in_bytes'))),
        },
        'pipeline_defaults': {
            'workers': mc.scalar(dig(body, 'pipeline', 'workers')),
            'batch_size': mc.scalar(dig(body, 'pipeline', 'batch_size')),
            'batch_delay': mc.scalar(dig(body, 'pipeline', 'batch_delay')),
        },
        'ephemeral_id': body.get('ephemeral_id') or '',
    }


# ─── Coletores da API do Logstash ─────────────────────────
def _collect_health(url, auth):
    """`/_health_report` — avaliação do próprio Logstash (8.x recentes).

    Versões sem o endpoint respondem 404 e a instância cai para o campo
    `status` do `/_node/stats`; a página não perde nada além do detalhamento.
    """
    body, err = _http_get(url, '/_health_report', auth)
    if body is None:
        return {'available': False, 'error': err}

    indicators = []
    for name, info in (dig(body, 'indicators') or {}).items():
        status = (info or {}).get('status')
        if status and status != 'green':
            indicators.append({
                'name': name,
                'status': status,
                'symptom': (info or {}).get('symptom', ''),
            })
    return {
        'available': True,
        'status': body.get('status'),
        'symptom': body.get('symptom', ''),
        'indicators': sorted(indicators, key=lambda i: (i['status'] != 'red', i['name'])),
        'pipelines': _health_pipelines(body),
    }


def _health_pipelines(body):
    """Status por pipeline dentro do health report, quando a versão o expõe."""
    out = {}
    details = dig(body, 'indicators', 'pipelines', 'details', 'pipelines') or {}
    for pid, info in details.items():
        status = (info or {}).get('status')
        if status:
            out[pid] = {'status': status, 'symptom': (info or {}).get('symptom', '')}
    return out


def _collect_instance(url, auth):
    """`/_node/stats` + `/_node/pipelines` + `/_health_report` de uma instância."""
    stats, err = _http_get(url, '/_node/stats', auth)
    result = {'url': normalize_url(url), 'reachable': stats is not None, 'error': err}
    if stats is None:
        return result

    result.update({
        'id': stats.get('id', ''),
        'name': stats.get('name', ''),
        'version': stats.get('version', ''),
        'status': stats.get('status', ''),
        'host': stats.get('host', ''),
        'http_address': stats.get('http_address', ''),
        'snapshot': bool(stats.get('snapshot')),
        'default_workers': dig(stats, 'pipeline', 'workers'),
        'default_batch_size': dig(stats, 'pipeline', 'batch_size'),
    })
    result.update(_node_metrics(stats))

    health = _collect_health(url, auth)
    result['health'] = health
    # O health report é a avaliação oficial do próprio Logstash: quando
    # disponível, ele manda no status exibido (o campo `status` do /_node/stats
    # não conhece pipelines parados nem falha de reload).
    if health.get('available') and health.get('status'):
        result['status'] = health['status']

    # SO e JVM estáticos para a modal de detalhe: falha aqui só deixa a modal
    # sem essas seções, sem afetar nada da página.
    detail = _node_detail(stats)
    info, _ = _http_get(url, '/_node/os,jvm', auth)
    detail.update(_node_info(info))
    result['detail'] = detail

    # Configuração por pipeline (workers/batch) não vem no /_node/stats.
    config, _ = _http_get(url, '/_node/pipelines', auth)
    configs = dict(_iter_pipelines(dig(config, 'pipelines'))) if config else {}
    health_pipelines = health.get('pipelines') or {}

    result['pipelines'] = [
        _pipeline_fields(pid, pstats, configs.get(pid), health_pipelines.get(pid))
        for pid, pstats in _iter_pipelines(stats.get('pipelines'))
    ]
    result['pipelines'].sort(key=lambda p: p['id'])
    return result


# ─── Self-monitoring / Elastic Agent ──────────────────────
def _monitoring_doc_fields(hit):
    """Campos de um doc de monitoramento, nos dois layouts.

    `logstash_stats.*` é o self-monitoring legacy e `logstash.node.stats.*` o da
    integração do Elastic Agent; o conteúdo abaixo do prefixo é o mesmo desenho
    do `/_node/stats`, daí o extrator compartilhado.
    """
    src = hit.get('_source') or {}
    stats = dig(src, 'logstash_stats') or dig(src, 'logstash', 'node', 'stats')
    if not stats:
        return None

    index = hit.get('_index') or ''
    source = 'agent' if index.startswith('metrics-') or '.ds-metrics-' in index else 'monitoring'
    node = stats.get('logstash') or {}

    doc = {
        'source': source,
        'id': node.get('uuid', '') or node.get('id', ''),
        'name': node.get('name', '') or dig(src, 'host', 'name') or '',
        'version': node.get('version', '') or dig(src, 'service', 'version') or '',
        'status': node.get('status', ''),
        'host': node.get('host', '') or dig(src, 'host', 'hostname') or '',
        'http_address': node.get('http_address', ''),
        'default_workers': dig(node, 'pipeline', 'workers'),
        'default_batch_size': dig(node, 'pipeline', 'batch_size'),
        'timestamp': src.get('timestamp') or src.get('@timestamp'),
    }
    doc.update(_node_metrics(stats))

    detail = _node_detail(stats)
    # O doc do Elastic Agent carrega o SO do host em ECS (`host.os.*`), que a
    # API não é a única a saber: é o que dá a seção de SO à modal de uma
    # instância sem URL cadastrada. O layout legacy não tem esses campos.
    host_os = dig(src, 'host', 'os') or {}
    arch = dig(src, 'host', 'architecture')
    if host_os or arch:
        detail['os'] = {
            'name': host_os.get('name') or host_os.get('platform') or '',
            'arch': arch or '',
            'version': host_os.get('version') or '',
            'processors': None,   # não vem no doc do serviço, só no do `system`
        }
    doc['detail'] = detail
    return doc


def fetch_monitoring_logstash():
    """Doc mais recente por instância nos índices de monitoramento.

    Deduplicação em Python (e não por agregação) pelo mesmo motivo do Kibana: o
    campo de identidade muda de nome entre os layouts, e a janela recente
    ordenada por tempo funciona igual nos dois.
    """
    by_instance = {}
    for hit in mc.recent_hits(MONITORING_INDICES, 500):
        doc = _monitoring_doc_fields(hit)
        if not doc:
            continue
        key = doc['id'] or doc['name']
        if key and key not in by_instance:   # hits ordenados: o 1º é o atual
            by_instance[key] = doc
        if len(by_instance) >= MAX_INSTANCES:
            break
    return by_instance


# ─── Consolidação ─────────────────────────────────────────
def _merge_instance(api, mon, sysm):
    """Precedência por métrica, com as fontes que cada uma realmente tem.

    CPU (do processo), heap, FDs e eventos: self-monitoring → API. RAM e disco
    (do host): só Elastic Agent. Status: API primeiro, pelo mesmo motivo do
    Kibana — é a leitura ao vivo, e a única que traz o health report.
    """
    api = api or {}
    mon = mon or {}
    sysm = sysm or {}
    mon_src = mon.get('source', 'monitoring')
    mon_ev = mon.get('events') or {}
    api_ev = api.get('events') or {}

    def first(field, default=''):
        return mon.get(field) or api.get(field) or default

    # O detalhe da modal vem **inteiro de uma fonte só**, ao contrário das
    # métricas da tabela: misturar a heap de 15 minutos atrás (self-monitoring)
    # com o GC de agora (API) daria uma foto internamente incoerente. A API
    # vence quando existe — é a leitura ao vivo e a única com SO e JVM.
    if api.get('detail'):
        detail, detail_source = api['detail'], 'api'
    elif mon.get('detail'):
        detail, detail_source = mon['detail'], mon_src
    else:
        detail, detail_source = {}, ''

    return {
        'id': first('id'),
        'name': first('name'),
        'version': first('version'),
        'host': first('host'),
        'http_address': first('http_address'),
        'status': api.get('status') or mon.get('status') or '',
        'url': api.get('url', ''),
        'configured': bool(api.get('url')),
        'reachable': api.get('reachable', False),
        'error': api.get('error'),
        'snapshot': api.get('snapshot', False),
        'last_seen': mon.get('timestamp'),
        'uptime_ms': mon.get('uptime_ms') or api.get('uptime_ms'),
        'default_workers': first('default_workers', None),
        'default_batch_size': first('default_batch_size', None),
        'metrics': {
            # CPU do processo Logstash — a API a expõe, diferente do Kibana.
            'cpu': mc.pick((mon.get('cpu_pct'), mon_src), (api.get('cpu_pct'), 'api')),
            'heap': mc.pick((mon.get('heap_pct'), mon_src), (api.get('heap_pct'), 'api')),
            # RAM e disco são do host: só o Elastic Agent os tem.
            'ram': mc.metric(sysm.get('ram'), 'agent'),
            'disk': mc.metric(sysm.get('disk'), 'agent'),
            'fd': mc.pick((mon.get('fd_pct'), mon_src), (api.get('fd_pct'), 'api')),
            'events_per_sec': mc.pick((mon.get('events_per_sec'), mon_src),
                                      (api.get('events_per_sec'), 'api')),
            'load_1m': mc.pick((mon.get('load_1m'), mon_src), (api.get('load_1m'), 'api')),
        },
        'disk_mount': sysm.get('disk_mount'),
        'heap_used': mon.get('heap_used') or api.get('heap_used'),
        'heap_max': mon.get('heap_max') or api.get('heap_max'),
        'fd_open': mon.get('fd_open') or api.get('fd_open'),
        'fd_max': mon.get('fd_max') or api.get('fd_max'),
        'threads': mon.get('threads') or api.get('threads'),
        'events': mon_ev or api_ev,
        'reload_failures': api.get('reload_failures') or mon.get('reload_failures') or 0,
        'health': api.get('health'),
        # Bloco da modal de detalhe (JVM, SO, processo, flow) — ver `_node_detail`.
        'detail': detail,
        'detail_source': detail_source,
        # Pipelines só existem via API: o self-monitoring traz totais do nó.
        'pipelines': api.get('pipelines') or [],
    }


def _match_monitoring(api_inst, monitoring):
    """Casa uma instância cadastrada com seu doc de monitoramento (id → nome)."""
    if api_inst.get('id') and api_inst['id'] in monitoring:
        return monitoring[api_inst['id']]
    for doc in monitoring.values():
        if doc.get('id') and doc['id'] == api_inst.get('id'):
            return doc
        if doc.get('name') and doc['name'] == api_inst.get('name'):
            return doc
    return None


def _aggregate_events(instances):
    """Totais de eventos do conjunto, com a taxa média e o custo por evento."""
    totals = {'in': 0, 'filtered': 0, 'out': 0, 'duration_ms': 0}
    per_sec = None
    for inst in instances:
        ev = inst.get('events') or {}
        for key in totals:
            totals[key] += mc.num(ev.get(key))
        rate = dig(inst, 'metrics', 'events_per_sec', 'value')
        if rate is not None:
            per_sec = (per_sec or 0) + rate
    totals['per_sec'] = round(per_sec, 1) if per_sec is not None else None
    totals['avg_event_ms'] = (round(totals['duration_ms'] / totals['out'], 3)
                              if totals['out'] else None)
    return totals


def _aggregate_queues(pipelines):
    """Situação das filas: ocupação da mais cheia e composição memória/PQ.

    A ocupação só é calculável em fila **persistente** (a de memória não tem
    teto em bytes), então `max_pct` é o pior caso entre as persistentes — sem
    nenhuma, fica None e o card informa que tudo está em memória.
    """
    persisted = [p for p in pipelines if p.get('queue_type') == 'persisted']
    pcts = [p['queue_pct'] for p in persisted if p.get('queue_pct') is not None]
    return {
        'persisted': len(persisted),
        'memory': len(pipelines) - len(persisted),
        'max_pct': max(pcts) if pcts else None,
        'bytes': sum(p.get('queue_bytes') or 0 for p in persisted),
        'max_bytes': sum(p.get('queue_max_bytes') or 0 for p in persisted),
        'events': sum(p.get('queue_events') or 0 for p in pipelines),
        # Pipeline mais cheio primeiro: é o candidato a estourar.
        'top': sorted([p for p in persisted if p.get('queue_pct') is not None],
                      key=lambda p: p['queue_pct'], reverse=True)[:5],
    }


def _aggregate_dlq(pipelines):
    """Dead letter queue somada, com os pipelines que têm eventos descartados."""
    with_dlq = [p for p in pipelines
                if (p.get('dlq_dropped') or p.get('dlq_bytes') or p.get('dlq_expired'))]
    return {
        'enabled': bool(with_dlq),
        'dropped': sum(p.get('dlq_dropped') or 0 for p in pipelines),
        'expired': sum(p.get('dlq_expired') or 0 for p in pipelines),
        'bytes': sum(p.get('dlq_bytes') or 0 for p in pipelines),
        'pipelines': sorted(with_dlq, key=lambda p: p.get('dlq_dropped') or 0,
                            reverse=True)[:5],
    }


def dashboard(config):
    """Payload consolidado da página Logstash.

    `config` vem de `db.get_logstash_config(..., include_password=True)`.
    Funciona sem nenhuma URL cadastrada: as instâncias saem do self-monitoring,
    sem pipelines, filas, DLQ nem plugins.
    """
    urls = [normalize_url(i['url']) for i in config.get('instances') or []]
    urls = [u for u in urls if u]
    username = config.get('username') or ''
    password = config.get('password') or ''
    # A API do Logstash é aberta por padrão: sem usuário, vai sem auth.
    auth = (username, password) if username else None

    with ThreadPoolExecutor(max_workers=max(4, len(urls) + 1)) as pool:
        f_monitoring = pool.submit(fetch_monitoring_logstash)
        f_instances = [pool.submit(_collect_instance, u, auth) for u in urls]

    monitoring = f_monitoring.result()
    api_instances = [f.result() for f in f_instances]

    # Hosts candidatos para casar com as métricas do Elastic Agent.
    hosts = set()
    for inst in api_instances:
        hosts.update([inst.get('name'), inst.get('host')])
    for doc in monitoring.values():
        hosts.update([doc.get('name'), doc.get('host')])
    system = mc.load_system_metrics({h for h in hosts if h})

    instances = []
    used_monitoring = set()
    for api_inst in api_instances:
        mon = _match_monitoring(api_inst, monitoring)
        if mon:
            used_monitoring.add(mon.get('id') or mon.get('name'))
        sysm = system.get(api_inst.get('name')) or system.get(api_inst.get('host')) or {}
        instances.append(_merge_instance(api_inst, mon, sysm))

    # Instâncias vistas só pelo self-monitoring (sem URL cadastrada).
    for key, doc in monitoring.items():
        if key in used_monitoring:
            continue
        sysm = system.get(doc.get('name')) or system.get(doc.get('host')) or {}
        instances.append(_merge_instance(None, doc, sysm))

    instances.sort(key=lambda i: (i.get('name') or '').lower())

    # Pipelines e plugins achatados com o nome da instância, que é como as
    # tabelas os exibem (uma linha por pipeline de cada instância).
    pipelines = []
    plugins = []
    for inst in instances:
        label = inst.get('name') or inst.get('url') or '(sem nome)'
        for pipe in inst['pipelines']:
            pipelines.append(dict(pipe, instance=label))
            for plugin in pipe['plugins']:
                plugins.append(dict(plugin, instance=label))

    plugins = [p for p in plugins if p.get('duration_ms')]
    plugins.sort(key=lambda p: p['duration_ms'], reverse=True)

    return {
        'instances': instances,
        'total_instances': len(instances),
        'versions': sorted({i['version'] for i in instances if i.get('version')}),
        'pipelines': pipelines,
        'total_pipelines': len(pipelines),
        'events': _aggregate_events(instances),
        'queues': _aggregate_queues(pipelines),
        'dlq': _aggregate_dlq(pipelines),
        # Sem URL cadastrada não há pipelines: cai para o total do nó, que o
        # self-monitoring traz.
        'reload_failures': (sum(p.get('reload_failures') or 0 for p in pipelines)
                            if pipelines
                            else sum(i.get('reload_failures') or 0 for i in instances)),
        'slow_plugins': plugins[:MAX_SLOW_PLUGINS],
        'has_urls': bool(urls),
        'has_monitoring': bool(monitoring),
    }
