FROM node:22.19.0-bookworm-slim
WORKDIR /workspace/runtime/sigma
COPY runtime/sigma/package.json runtime/sigma/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
WORKDIR /workspace
COPY . /workspace
CMD ["node","--version"]
