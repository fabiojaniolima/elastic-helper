"""Camada de acesso ao Kibana (instâncias, Task Manager, Fleet e APM Server).

Espelha a estrutura de `es_service.py`: estado em variáveis de módulo, coleta
paralela e **sem cache** — cada atualização da página consulta as fontes de novo.
As rotas Flask apenas validam e serializam.

Ver `docs/kibana.md`.
"""
from concurrent.futures import ThreadPoolExecutor
import logging

import requests
import urllib3

logger = logging.getLogger('elastic-helper')

# A ferramenta é local e o cliente ES já roda com verify_certs=False; manter o
# mesmo critério aqui evita quebrar em clusters com certificado self-signed.
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

HTTP_TIMEOUT = 8          # segundos por chamada à API do Kibana


# ─── Helpers ──────────────────────────────────────────────
def dig(obj, *path):
    """Acesso encadeado tolerante: devolve None se qualquer nível faltar.

    Os nomes de campo do self-monitoring variam entre versões do Kibana, então
    todo extrator passa por aqui — campo ausente vira ausência de valor (e a
    fonte seguinte da precedência assume), nunca uma exceção.
    """
    cur = obj
    for key in path:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(key)
        if cur is None:
            return None
    return cur


def _scalar(val, *nested_keys):
    """Número, venha ele direto ou aninhado.

    O self-monitoring legacy usa escalares (`used_in_bytes: 123`) e o formato do
    Elastic Agent usa objetos (`used: {bytes: 123}`). Sem isto, um layout
    inesperado devolveria o próprio dict como se fosse o valor da métrica.
    """
    if isinstance(val, bool):
        return None
    if isinstance(val, (int, float)):
        return val
    if isinstance(val, dict):
        for key in nested_keys:
            inner = val.get(key)
            if isinstance(inner, (int, float)) and not isinstance(inner, bool):
                return inner
    return None


def _pct(used, total):
    """Percentual com 1 casa, ou None se o total não for utilizável."""
    try:
        if not total:
            return None
        return round(float(used) / float(total) * 100, 1)
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def _ratio_to_pct(val):
    """Converte razão 0..1 (padrão do Elastic Agent e do ELU) em 0..100."""
    try:
        return round(float(val) * 100, 1)
    except (TypeError, ValueError):
        return None


def _metric(value, source):
    """Métrica com a origem usada, para o front exibir de onde veio o número."""
    if value is None:
        return None
    return {'value': value, 'source': source}


def _pick(*candidates):
    """Primeiro candidato `(valor, origem)` com valor presente. Implementa a
    precedência agente → self-monitoring → API, na ordem em que for chamado."""
    for value, source in candidates:
        if value is not None:
            return _metric(value, source)
    return None


def normalize_url(raw):
    """URL da instância pronta para uso: protocolo garantido, sem barra final."""
    url = (raw or '').strip().rstrip('/')
    if not url:
        return ''
    if not url.lower().startswith(('http://', 'https://')):
        url = 'https://' + url
    return url


# ─── HTTP (API do Kibana) ─────────────────────────────────
def _http_get(base_url, path, auth, params=None):
    """GET numa instância. Retorna (dados, None) ou (None, mensagem de erro).

    Nunca levanta: cada instância degrada sozinha, sem derrubar a página.
    """
    url = normalize_url(base_url) + path
    try:
        resp = requests.get(
            url, auth=auth, params=params, timeout=HTTP_TIMEOUT, verify=False,
            headers={'kbn-xsrf': 'true', 'Accept': 'application/json'},
        )
    except requests.exceptions.SSLError as e:
        return None, 'Falha de TLS: %s' % e
    except requests.exceptions.ConnectTimeout:
        return None, 'Timeout de conexão (%ss)' % HTTP_TIMEOUT
    except requests.exceptions.ReadTimeout:
        return None, 'Timeout de leitura (%ss)' % HTTP_TIMEOUT
    except requests.exceptions.ConnectionError:
        return None, 'Não foi possível conectar'
    except Exception as e:
        return None, str(e)

    if resp.status_code == 401:
        return None, 'Credenciais inválidas (401)'
    if resp.status_code == 403:
        return None, 'Sem permissão para este recurso (403)'
    if resp.status_code == 404:
        return None, 'Recurso não encontrado (404)'
    if resp.status_code >= 400:
        return None, 'HTTP %s' % resp.status_code
    try:
        return resp.json(), None
    except ValueError:
        # Resposta não-JSON costuma ser proxy/portal de login no caminho.
        return None, 'Resposta não é JSON (proxy ou login intermediário?)'


def test_instance(url, username, password):
    """Valida URL + credenciais numa instância. Retorna dict com nome/versão."""
    auth = (username, password) if username else None
    data, err = _http_get(url, '/api/stats', auth)
    if err:
        raise RuntimeError(err)
    kb = dig(data, 'kibana') or {}
    return {
        'name': kb.get('name', ''),
        'version': kb.get('version', ''),
        'status': kb.get('status', ''),
        'uuid': kb.get('uuid', ''),
    }


# ─── Coletores da API do Kibana ───────────────────────────
def _collect_instance(url, auth):
    """`/api/stats` + `/api/status` + Task Manager de uma instância."""
    stats, err = _http_get(url, '/api/stats', auth)
    result = {'url': normalize_url(url), 'reachable': stats is not None, 'error': err}
    if stats is None:
        return result

    kb = dig(stats, 'kibana') or {}
    result.update({
        'uuid': kb.get('uuid', ''),
        'name': kb.get('name', ''),
        'version': kb.get('version', ''),
        'status': kb.get('status', ''),
        'host': kb.get('host', ''),
    })

    # Heap: o denominador correto é size_limit (--max-old-space-size). Contra
    # heap.total_bytes daria falso alarme, pois o V8 cresce o heap sob demanda.
    heap = dig(stats, 'process', 'memory', 'heap') or {}
    result['heap_pct'] = _pct(heap.get('used_bytes'), heap.get('size_limit'))
    result['heap_used'] = heap.get('used_bytes')
    result['heap_limit'] = heap.get('size_limit')

    os_mem = dig(stats, 'os', 'memory') or {}
    result['ram_pct'] = _pct(os_mem.get('used_bytes'), os_mem.get('total_bytes'))
    result['ram_used'] = os_mem.get('used_bytes')
    result['ram_total'] = os_mem.get('total_bytes')

    # ELU já vem como razão 0..1 calculada pelo Kibana no intervalo de coleta.
    result['elu_pct'] = _ratio_to_pct(
        dig(stats, 'process', 'event_loop_utilization', 'utilization'))
    result['event_loop_delay'] = dig(stats, 'process', 'event_loop_delay')
    result['uptime_ms'] = dig(stats, 'process', 'uptime_ms')
    result['concurrent_connections'] = stats.get('concurrent_connections')
    result['response_time_avg'] = dig(stats, 'response_times', 'avg_ms')
    result['response_time_max'] = dig(stats, 'response_times', 'max_ms')
    result['es_client_queued'] = dig(stats, 'elasticsearch_client', 'total_queued_requests')

    # Status geral e serviços degradados (/api/status é mais rico que o campo
    # `kibana.status` do /api/stats, que é só o nível agregado).
    status_body, status_err = _http_get(url, '/api/status', auth)
    if status_body is not None:
        level = dig(status_body, 'status', 'overall', 'level')
        if level:
            result['status'] = level
        result['status_summary'] = dig(status_body, 'status', 'overall', 'summary')
        result['degraded'] = _degraded_services(status_body)

    return result


def _degraded_services(status_body):
    """Serviços core e plugins fora de 'available', para o detalhe de status."""
    out = []
    for section in ('core', 'plugins'):
        for name, info in (dig(status_body, 'status', section) or {}).items():
            level = (info or {}).get('level')
            if level and level != 'available':
                out.append({
                    'section': section,
                    'name': name,
                    'level': level,
                    'summary': (info or {}).get('summary', ''),
                })
    return sorted(out, key=lambda x: (x['level'] != 'critical', x['name']))


def _instance_payload(api):
    """Formato de saída de uma instância, a partir apenas da API.

    Andaime da Fase 9.1: dá lugar a `_merge_instance` na 9.3, quando passam a
    existir outras fontes para a mesma métrica. O formato `{value, source}` já
    é o final — é o front que exibe a origem no tooltip de cada célula.
    """
    return {
        'uuid': api.get('uuid', ''),
        'name': api.get('name', ''),
        'version': api.get('version', ''),
        'status': api.get('status', ''),
        'host': api.get('host', ''),
        'url': api.get('url', ''),
        'configured': bool(api.get('url')),
        'reachable': api.get('reachable', False),
        'error': api.get('error'),
        'status_summary': api.get('status_summary'),
        'degraded': api.get('degraded') or [],
        'metrics': {
            # CPU e disco são do host e não existem na API do Kibana.
            'cpu': None,
            'disk': None,
            'ram': _metric(api.get('ram_pct'), 'api'),
            'heap': _metric(api.get('heap_pct'), 'api'),
            'elu': _metric(api.get('elu_pct'), 'api'),
            'event_loop_delay': _metric(api.get('event_loop_delay'), 'api'),
            'response_time_avg': _metric(api.get('response_time_avg'), 'api'),
            'concurrent_connections': _metric(api.get('concurrent_connections'), 'api'),
        },
        'heap_used': api.get('heap_used'),
        'heap_limit': api.get('heap_limit'),
        'ram_used': api.get('ram_used'),
        'ram_total': api.get('ram_total'),
        'uptime_ms': api.get('uptime_ms'),
    }


def dashboard(config):
    """Payload consolidado da página Kibana.

    `config` vem de `db.get_kibana_config(..., include_password=True)`.
    """
    urls = [normalize_url(i['url']) for i in config.get('instances') or []]
    urls = [u for u in urls if u]
    username = config.get('username') or ''
    password = config.get('password') or ''
    auth = (username, password) if username else None

    with ThreadPoolExecutor(max_workers=max(4, len(urls) + 3)) as pool:
        f_instances = [pool.submit(_collect_instance, u, auth) for u in urls]

    instances = [_instance_payload(f.result()) for f in f_instances]
    instances.sort(key=lambda i: (i.get('name') or '').lower())

    return {
        'instances': instances,
        'total_instances': len(instances),
        'versions': sorted({i['version'] for i in instances if i.get('version')}),
        'has_urls': bool(urls),
    }
