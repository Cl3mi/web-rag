#!/bin/bash
set -e

MODEL="${OLLAMA_MODEL:-llama3.2}"

echo "=== Ollama Entrypoint ==="
echo "Model to ensure: $MODEL"

# Start Ollama server in the background
echo "Starting Ollama server..."
ollama serve &
OLLAMA_PID=$!

# Wait for Ollama to be ready using ollama list (which requires server to be up)
echo "Waiting for Ollama to be ready..."
MAX_RETRIES=60
RETRY_COUNT=0

while ! ollama list > /dev/null 2>&1; do
    RETRY_COUNT=$((RETRY_COUNT + 1))
    if [ $RETRY_COUNT -ge $MAX_RETRIES ]; then
        echo "ERROR: Ollama failed to start after $MAX_RETRIES retries"
        exit 1
    fi
    echo "Waiting for Ollama... (attempt $RETRY_COUNT/$MAX_RETRIES)"
    sleep 2
done

echo "Ollama is ready!"

# Check if model exists and pull if not
echo "Checking if model '$MODEL' is installed..."
if ollama list | grep -q "$MODEL"; then
    echo "Model '$MODEL' is already installed."
else
    echo "Model '$MODEL' not found. Pulling (this may take several minutes)..."
    ollama pull "$MODEL"
    echo "Model '$MODEL' pulled successfully!"
fi

# Verify model is available
echo "Verifying model availability..."
if ollama list | grep -q "$MODEL"; then
    echo "=== Ollama ready with model: $MODEL ==="
else
    echo "ERROR: Model '$MODEL' verification failed!"
    exit 1
fi

# Keep the container running by waiting for the Ollama process
wait $OLLAMA_PID
