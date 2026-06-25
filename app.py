from flask import Flask, render_template
from dotenv import load_dotenv
import logging
import os

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


# ─── Routes ───────────────────────────────────────────────
@app.route('/')
def index():
    return render_template('index.html')


if __name__ == '__main__':
    port = int(os.getenv('PORT', 5001))
    # Debugger/reloader do Flask só quando LOG_LEVEL=DEBUG.
    debug = _log_level <= logging.DEBUG
    app.run(debug=debug, host='0.0.0.0', port=port)
