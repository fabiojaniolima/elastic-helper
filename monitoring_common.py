"""Base comum das camadas de monitoramento de serviços do stack (Kibana, Logstash).

Nasceu de `kibana_service.py`: quando o Logstash entrou, extratores tolerantes,
HTTP degradável e leitura das métricas do Elastic Agent passaram a ser
necessários pelos dois. Manter uma cópia por serviço faria as regras (precedência
de fonte, ausência ≠ zero, mount mais cheio) divergirem com o tempo.

O que é **específico de cada serviço** — quais endpoints chamar, como extrair
cada métrica, qual a precedência — fica no módulo do serviço. Aqui só o que não
depende de qual serviço está sendo consultado.
"""
import logging

import requests
import urllib3

import es_service

logger = logging.getLogger('elastic-helper')

# A ferramenta é local e o cliente ES já roda com verify_certs=False; manter o
# mesmo critério aqui evita quebrar em serviços com certificado self-signed.
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

HTTP_TIMEOUT = 8           # segundos por chamada à API do serviço
MONITORING_WINDOW = '15m'  # janela de busca do self-monitoring / agente
MAX_INSTANCES = 50

# Integração `system` do Elastic Agent: a única fonte de CPU e disco do host.
SYSTEM_CPU_INDICES = 'metrics-system.cpu-*'
SYSTEM_MEMORY_INDICES = 'metrics-system.memory-*'
SYSTEM_FS_INDICES = 'metrics-system.filesystem-*'


# ─── Extratores tolerantes ────────────────────────────────
def dig(obj, *path):
    """Acesso encadeado tolerante: devolve None se qualquer nível faltar.

    Os nomes de campo do self-monitoring variam entre versões e entre o layout
    legacy e o do Elastic Agent, então todo extrator passa por aqui — campo
    ausente vira ausência de valor (e a fonte seguinte da precedência assume),
    nunca uma exceção.
    """
    cur = obj
    for key in path:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(key)
        if cur is None:
            return None
    return cur


def scalar(val, *nested_keys):
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


def num(val):
    """Inteiro de um campo numérico, ou 0 — para contadores vindos de API."""
    if isinstance(val, bool) or not isinstance(val, (int, float)):
        return 0
    return int(val)


def pct(used, total):
    """Percentual com 1 casa, ou None se o total não for utilizável."""
    try:
        if not total:
            return None
        return round(float(used) / float(total) * 100, 1)
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def ratio_to_pct(val):
    """Converte razão 0..1 (padrão do Elastic Agent e do ELU) em 0..100."""
    try:
        return round(float(val) * 100, 1)
    except (TypeError, ValueError):
        return None


def metric(value, source):
    """Métrica com a origem usada, para o front exibir de onde veio o número."""
    if value is None:
        return None
    return {'value': value, 'source': source}


def pick(*candidates):
    """Primeiro candidato `(valor, origem)` com valor presente. Implementa a
    precedência agente → self-monitoring → API, na ordem em que for chamado."""
    for value, source in candidates:
        if value is not None:
            return metric(value, source)
    return None


def normalize_url(raw, default_scheme='https'):
    """URL da instância pronta para uso: protocolo garantido, sem barra final.

    `default_scheme` muda por serviço: o Kibana quase sempre está atrás de TLS,
    a API de monitoramento do Logstash (9600) atende em HTTP por padrão.
    """
    url = (raw or '').strip().rstrip('/')
    if not url:
        return ''
    if not url.lower().startswith(('http://', 'https://')):
        url = '%s://%s' % (default_scheme, url)
    return url


# ─── HTTP (API do serviço) ────────────────────────────────
def http_get(base_url, path, auth, params=None, default_scheme='https'):
    """GET numa instância. Retorna (dados, None) ou (None, mensagem de erro).

    Nunca levanta: cada instância degrada sozinha, sem derrubar a página.
    """
    url = normalize_url(base_url, default_scheme) + path
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


# ─── Fontes no Elasticsearch (self-monitoring / Elastic Agent) ─────
def es_search(index, body):
    """Busca tolerante: índice ausente ou sem permissão vira lista vazia.

    `body` (size/query/sort) é expandido em argumentos nomeados: o parâmetro
    `body=` do `search()` está deprecado no cliente v8 e foi removido no v9.
    """
    client = es_service.client()
    if client is None:
        return []
    try:
        resp = client.search(index=index, ignore_unavailable=True,
                             allow_no_indices=True, **body)
        return [h for h in dig(resp.body, 'hits', 'hits') or []]
    except Exception as e:
        logger.debug('Busca em %s falhou: %s', index, e)
        return []


def recent_hits(index, size, extra_filter=None, time_fields=('timestamp', '@timestamp')):
    """Hits da janela recente ordenados do mais novo para o mais antigo.

    Tenta cada campo de tempo em ordem: o self-monitoring legacy grava
    `timestamp` e o formato do Elastic Agent `@timestamp`. Devolve o primeiro
    que trouxer resultado, para o chamador deduplicar por instância em Python
    (mais simples e portável entre layouts do que uma agregação).
    """
    for field in time_fields:
        filters = [{'range': {field: {'gte': 'now-%s' % MONITORING_WINDOW}}}]
        if extra_filter:
            filters.append(extra_filter)
        hits = es_search(index, {
            'size': size,
            'query': {'bool': {'filter': filters}},
            'sort': [{field: {'order': 'desc', 'unmapped_type': 'date'}}],
        })
        if hits:
            return hits
    return []


def _host_filter(hosts):
    """Casa o host da instância com o host reportado pelo Elastic Agent.
    O nome do serviço costuma ser o hostname, mas cai para o IP quando não."""
    values = [h for h in hosts if h]
    if not values:
        return None
    return {'bool': {'should': [
        {'terms': {'host.name': values}},
        {'terms': {'host.hostname': values}},
        {'terms': {'host.ip': values}},
    ], 'minimum_should_match': 1}}


def _host_keys(src):
    """Chaves pelas quais um doc do agente pode ser encontrado."""
    host = dig(src, 'host') or {}
    keys = [host.get('name'), host.get('hostname')]
    ips = host.get('ip')
    if isinstance(ips, list):
        keys.extend(ips)
    elif ips:
        keys.append(ips)
    return [k for k in keys if k]


def load_system_metrics(hosts):
    """CPU/RAM e disco por host, vindos da integração `system` do Elastic Agent.

    Esta é a **única** fonte de disco (e, no Kibana, também de CPU): as APIs dos
    serviços não expõem uso de filesystem. Ausência de agente no host → sem
    valor (e o front mostra traço, nunca zero).
    """
    host_filter = _host_filter(hosts)
    if host_filter is None:
        return {}

    out = {}

    def _register(src, field, value):
        if value is None:
            return
        for key in _host_keys(src):
            entry = out.setdefault(key, {})
            # Docs vêm do mais recente para o mais antigo: o primeiro vence.
            entry.setdefault(field, value)

    # CPU + memória: já normalizados pelo agente (razão 0..1), sem baseline.
    for index, extract in (
        (SYSTEM_CPU_INDICES, lambda s: ('cpu', ratio_to_pct(dig(s, 'system', 'cpu', 'total', 'norm', 'pct')))),
        (SYSTEM_MEMORY_INDICES, lambda s: ('ram', ratio_to_pct(dig(s, 'system', 'memory', 'actual', 'used', 'pct')))),
    ):
        for hit in recent_hits(index, 200, extra_filter=host_filter, time_fields=('@timestamp',)):
            src = hit.get('_source') or {}
            field, value = extract(src)
            _register(src, field, value)

    # Disco: vários mounts por host — fica o mais cheio (é o que causa problema).
    for hit in recent_hits(SYSTEM_FS_INDICES, 500, extra_filter=host_filter,
                           time_fields=('@timestamp',)):
        src = hit.get('_source') or {}
        used_pct = ratio_to_pct(dig(src, 'system', 'filesystem', 'used', 'pct'))
        if used_pct is None:
            continue
        mount = dig(src, 'system', 'filesystem', 'mount_point') or ''
        for key in _host_keys(src):
            entry = out.setdefault(key, {})
            if entry.get('disk') is None or used_pct > entry['disk']:
                entry['disk'] = used_pct
                entry['disk_mount'] = mount
    return out
