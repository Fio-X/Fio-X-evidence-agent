FROM node:22.19.0-bookworm-slim
WORKDIR /opt/adn
COPY runtime/sigma/package.json runtime/sigma/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
CMD ["node","--version"]
