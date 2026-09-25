FROM node:22.19.0-bookworm-slim
WORKDIR /workspace/runtime/map
COPY runtime/map/package.json runtime/map/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
WORKDIR /workspace
COPY . /workspace
CMD ["node","--version"]
