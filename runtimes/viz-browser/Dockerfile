FROM python:3.13-bookworm
WORKDIR /workspace
COPY runtimes/viz-browser/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt && playwright install --with-deps chromium
COPY . /workspace
CMD ["python3", "scripts/runtime_health.py"]
