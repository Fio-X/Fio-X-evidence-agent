FROM node:22.19.0-bookworm-slim
WORKDIR /opt/adn
COPY runtime/d3/package.json runtime/d3/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
CMD ["node","--version"]
