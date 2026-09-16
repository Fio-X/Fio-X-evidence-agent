FROM node:22.19.0-bookworm-slim
WORKDIR /workspace/runtime/web
COPY runtime/web/package.json runtime/web/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
WORKDIR /workspace
COPY . /workspace
CMD ["node", "--version"]
