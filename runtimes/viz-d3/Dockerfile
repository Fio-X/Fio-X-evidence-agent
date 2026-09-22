FROM node:22.19.0-bookworm-slim
WORKDIR /workspace/runtime/d3
COPY runtime/d3/package.json runtime/d3/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
WORKDIR /workspace
COPY . /workspace
CMD ["node","--version"]
