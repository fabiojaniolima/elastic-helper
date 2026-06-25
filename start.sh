#!/usr/bin/env bash
set -e

VENV_DIR=".venv"

# Copy .env.example → .env on first run
if [ ! -f ".env" ]; then
  cp .env.example .env
  echo "→ Arquivo .env criado a partir de .env.example"
  echo "  Ajuste PORT/LOG_LEVEL se necessário — as credenciais do cluster são"
  echo "  informadas na própria tela de conexão, não no .env."
  echo ""
fi

# Read PORT from .env if not already exported
if [ -f ".env" ]; then
  export $(grep -v '^#' .env | grep -v '^$' | xargs)
fi

PORT="${PORT:-5001}"

# Create venv if it doesn't exist
if [ ! -d "$VENV_DIR" ]; then
  echo "→ Criando ambiente virtual..."
  python3 -m venv "$VENV_DIR"
fi

# Activate venv
source "$VENV_DIR/bin/activate"

# Install/update dependencies
echo "→ Verificando dependências..."
pip install -q -r requirements.txt

echo "→ Iniciando Elastic Helper em http://localhost:${PORT}"
echo "   Pressione Ctrl+C para encerrar."
echo ""

python app.py
