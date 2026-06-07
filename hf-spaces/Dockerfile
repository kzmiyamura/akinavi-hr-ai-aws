FROM python:3.11-slim

WORKDIR /app

# システム依存パッケージ
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc g++ cmake \
    && rm -rf /var/lib/apt/lists/*

# llama-cpp-python: CPU 向けプリビルドホイールを使う（コンパイル不要・高速）
RUN pip install --no-cache-dir \
    llama-cpp-python \
    --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cpu

# その他依存パッケージ
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# HF Spaces はポート 7860 を使う
EXPOSE 7860

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
