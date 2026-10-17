# syntax=docker/dockerfile:1
# RevenueGuard AI — Laya decision service. Port 8100.
# CPU torch by default. For NVIDIA GPUs:
#   docker build --build-arg TORCH_INDEX=https://download.pytorch.org/whl/cu121 -t rg-laya:cuda services/laya
FROM python:3.12-slim
ARG TORCH_INDEX=https://download.pytorch.org/whl/cpu
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HOME=/models
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
 && groupadd --system app && useradd --system --gid app --home-dir /app --shell /usr/sbin/nologin app
# torch first, from the selected wheel index, so `laya` does not pull the default (large CUDA) PyPI wheel
RUN pip install --index-url "${TORCH_INDEX}" torch
WORKDIR /app
COPY requirements.txt ./
RUN pip install -r requirements.txt
COPY --chown=app:app laya_service ./laya_service
RUN mkdir -p /models && chown -R app:app /models /app
USER app
VOLUME ["/models"]
EXPOSE 8100
HEALTHCHECK --interval=20s --timeout=5s --start-period=30s --retries=5 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8100/health', timeout=4).status==200 else 1)"
CMD ["uvicorn", "laya_service.main:app", "--host", "0.0.0.0", "--port", "8100"]
