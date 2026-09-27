FROM node:22.19.0-bookworm-slim
WORKDIR /opt/adn
COPY runtime/map/package.json runtime/map/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
CMD ["node","--version"]
