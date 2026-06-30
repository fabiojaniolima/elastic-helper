"""Persistência local de conexões Elasticsearch em SQLite.

Ferramenta local sem autenticação: senhas são gravadas em texto plano.
O arquivo do banco fica na raiz do projeto e é ignorado pelo git.
"""
import os
import sqlite3

DB_PATH = os.getenv(
    'DB_PATH',
    os.path.join(os.path.dirname(os.path.abspath(__file__)), 'connections.db'),
)


def _connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
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
