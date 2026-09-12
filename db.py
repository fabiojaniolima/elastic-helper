"""Persistência local de conexões Elasticsearch em SQLite.

Ferramenta local sem autenticação: senhas são gravadas em texto plano.
O arquivo do banco fica na raiz do projeto e é ignorado pelo git.

Guarda também a configuração das integrações de monitoramento (**Kibana** e
**Logstash**), cada uma **vinculada à conexão ES salva** (FK para
`connections.id`, ON DELETE CASCADE): cada cluster tem suas próprias instâncias.
As duas têm o mesmo desenho de tabelas e são tratadas pelo mesmo código, por
prefixo. Ver `docs/kibana.md` e `docs/logstash.md`.
"""
import os
import sqlite3

DB_PATH = os.getenv(
    'DB_PATH',
    os.path.join(os.path.dirname(os.path.abspath(__file__)), 'connections.db'),
)


# Integrações com config por conexão. O nome é usado para compor o nome das
# tabelas (`<prefixo>_config` / `<prefixo>_instances`), então é uma lista
# fechada no código — nunca vem de payload.
INTEGRATIONS = ('kibana', 'logstash')


def _connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    # SQLite ignora FKs por padrão; sem isso o ON DELETE CASCADE das tabelas
    # das integrações não roda e a config fica órfã ao excluir a conexão.
    conn.execute('PRAGMA foreign_keys = ON')
    return conn


def init_db():
    # DB_PATH pode ser um nome relativo sem diretório ('connections.db', o
    # default); nesse caso dirname devolve '' e makedirs falharia.
    db_dir = os.path.dirname(DB_PATH)
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)
    with _connect() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS connections (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                alias      TEXT NOT NULL UNIQUE,
                host       TEXT NOT NULL,
                port       INTEGER NOT NULL,
                username   TEXT DEFAULT '',
                password   TEXT DEFAULT '',
                use_ssl    INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now'))
            )
        """)
        # Config de cada integração por conexão ES (1:1) + suas instâncias
        # (1:N). Mesmo desenho para Kibana e Logstash; credenciais compartilhadas
        # por todas as instâncias daquele cluster.
        for prefix in INTEGRATIONS:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS %s_config (
                    connection_id INTEGER PRIMARY KEY
                                  REFERENCES connections(id) ON DELETE CASCADE,
                    enabled       INTEGER DEFAULT 0,
                    username      TEXT DEFAULT '',
                    password      TEXT DEFAULT '',
                    updated_at    TEXT DEFAULT (datetime('now'))
                )
            """ % prefix)
            # Só as URLs — as credenciais vivem no config.
            conn.execute("""
                CREATE TABLE IF NOT EXISTS %s_instances (
                    id            INTEGER PRIMARY KEY AUTOINCREMENT,
                    connection_id INTEGER NOT NULL
                                  REFERENCES connections(id) ON DELETE CASCADE,
                    url           TEXT NOT NULL,
                    created_at    TEXT DEFAULT (datetime('now')),
                    UNIQUE (connection_id, url)
                )
            """ % prefix)


def _row_to_public(row):
    """Dict seguro para o frontend: sem senha, apenas has_password."""
    return {
        'id': row['id'],
        'alias': row['alias'],
        'host': row['host'],
        'port': row['port'],
        'username': row['username'] or '',
        'use_ssl': bool(row['use_ssl']),
        'has_password': bool(row['password']),
    }


def list_connections():
    with _connect() as conn:
        rows = conn.execute(
            'SELECT * FROM connections ORDER BY alias COLLATE NOCASE'
        ).fetchall()
    return [_row_to_public(r) for r in rows]


def _get_row(conn_id):
    with _connect() as conn:
        return conn.execute(
            'SELECT * FROM connections WHERE id = ?', (conn_id,)
        ).fetchone()


def get_connection(conn_id):
    """Dict público (SEM senha) por id. None se não existir."""
    row = _get_row(conn_id)
    return _row_to_public(row) if row else None


def get_connection_full(conn_id):
    """Dict completo (COM senha) para uso interno na conexão. None se não existir."""
    row = _get_row(conn_id)
    if row is None:
        return None
    data = _row_to_public(row)
    data['password'] = row['password'] or ''
    return data


def find_duplicate(host, port, username, exclude_id=None):
    """Retorna o alias de uma conexão com mesmo host+porta+usuário, ou None.
    `exclude_id` ignora a própria conexão (usado na edição)."""
    sql = 'SELECT alias FROM connections WHERE host = ? AND port = ? AND username = ?'
    params = [host.strip(), int(port), (username or '').strip()]
    if exclude_id is not None:
        sql += ' AND id != ?'
        params.append(exclude_id)
    with _connect() as conn:
        row = conn.execute(sql, params).fetchone()
    return row['alias'] if row else None


def create_connection(data):
    """Insere e retorna o registro público. Levanta sqlite3.IntegrityError se alias duplicado."""
    with _connect() as conn:
        cur = conn.execute(
            """INSERT INTO connections (alias, host, port, username, password, use_ssl)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (
                data['alias'].strip(),
                data['host'].strip(),
                int(data['port']),
                (data.get('username') or '').strip(),
                data.get('password') or '',
                1 if data.get('use_ssl') else 0,
            ),
        )
        new_id = cur.lastrowid
    return get_connection(new_id)


def update_connection(conn_id, data):
    """Atualiza os campos da conexão. Retorna o registro público ou None se não existir.

    A senha só é sobrescrita quando a chave 'password' está presente em `data`;
    assim, edições sem digitar a senha preservam a já armazenada.
    """
    existing = get_connection_full(conn_id)
    if existing is None:
        return None

    fields = {
        'alias': data['alias'].strip() if 'alias' in data else existing['alias'],
        'host': data['host'].strip() if 'host' in data else existing['host'],
        'port': int(data['port']) if 'port' in data else existing['port'],
        'username': (data.get('username') or '').strip() if 'username' in data else existing['username'],
        'use_ssl': (1 if data.get('use_ssl') else 0) if 'use_ssl' in data else (1 if existing['use_ssl'] else 0),
        'password': (data.get('password') or '') if 'password' in data else existing['password'],
    }

    with _connect() as conn:
        conn.execute(
            """UPDATE connections
               SET alias = ?, host = ?, port = ?, username = ?, use_ssl = ?,
                   password = ?, updated_at = datetime('now')
               WHERE id = ?""",
            (
                fields['alias'], fields['host'], fields['port'], fields['username'],
                fields['use_ssl'], fields['password'], conn_id,
            ),
        )
    return get_connection(conn_id)


def delete_connection(conn_id):
    with _connect() as conn:
        cur = conn.execute('DELETE FROM connections WHERE id = ?', (conn_id,))
        return cur.rowcount > 0


def find_connection_id(host, port, username):
    """Id da conexão salva com mesmo host+porta+usuário, ou None.

    Irmã de `find_duplicate` (mesmo SQL, outra coluna): permite associar uma
    conexão ad-hoc — conectada pelo formulário, sem `connection_id` — ao
    registro salvo equivalente, para achar a config de Kibana dela.
    """
    with _connect() as conn:
        row = conn.execute(
            'SELECT id FROM connections WHERE host = ? AND port = ? AND username = ?',
            (host.strip(), int(port), (username or '').strip()),
        ).fetchone()
    return row['id'] if row else None


# ─── Config das integrações (por conexão ES) ───────────────
def _check_prefix(prefix):
    """Barra qualquer nome fora da lista fechada antes de montar SQL com ele."""
    if prefix not in INTEGRATIONS:
        raise ValueError('Integração desconhecida: %s' % prefix)
    return prefix


def get_integration_config(prefix, conn_id, include_password=False):
    """Config + instâncias de uma integração numa conexão. Sempre retorna um dict
    utilizável (defaults vazios quando nunca foi configurada). A senha só sai com
    `include_password=True` — uso interno na coleta, nunca no frontend."""
    _check_prefix(prefix)
    with _connect() as conn:
        row = conn.execute(
            'SELECT * FROM %s_config WHERE connection_id = ?' % prefix, (conn_id,)
        ).fetchone()
        instances = conn.execute(
            'SELECT id, url FROM %s_instances WHERE connection_id = ? ORDER BY id' % prefix,
            (conn_id,),
        ).fetchall()

    password = (row['password'] if row else '') or ''
    data = {
        'connection_id': conn_id,
        'enabled': bool(row['enabled']) if row else False,
        'username': (row['username'] if row else '') or '',
        'has_password': bool(password),
        'instances': [{'id': i['id'], 'url': i['url']} for i in instances],
    }
    if include_password:
        data['password'] = password
    return data


def save_integration_config(prefix, conn_id, data):
    """Grava config + lista de instâncias (substitui a lista inteira).

    A senha só é sobrescrita quando a chave 'password' vem no payload — mesma
    convenção de `update_connection`, para edições não apagarem a senha salva.
    """
    _check_prefix(prefix)
    existing = get_integration_config(prefix, conn_id, include_password=True)
    password = data['password'] if 'password' in data else existing['password']
    urls = []
    for raw in data.get('instances') or []:
        url = (raw.get('url') if isinstance(raw, dict) else raw) or ''
        url = url.strip().rstrip('/')
        if url and url not in urls:      # dedup preservando a ordem digitada
            urls.append(url)

    with _connect() as conn:
        conn.execute(
            """INSERT INTO %s_config (connection_id, enabled, username, password, updated_at)
               VALUES (?, ?, ?, ?, datetime('now'))
               ON CONFLICT(connection_id) DO UPDATE SET
                 enabled = excluded.enabled, username = excluded.username,
                 password = excluded.password, updated_at = datetime('now')""" % prefix,
            (
                conn_id,
                1 if data.get('enabled') else 0,
                (data.get('username') or '').strip(),
                password or '',
            ),
        )
        conn.execute('DELETE FROM %s_instances WHERE connection_id = ?' % prefix, (conn_id,))
        conn.executemany(
            'INSERT INTO %s_instances (connection_id, url) VALUES (?, ?)' % prefix,
            [(conn_id, u) for u in urls],
        )
    return get_integration_config(prefix, conn_id)
