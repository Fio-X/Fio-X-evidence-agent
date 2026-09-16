FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates gnupg wget software-properties-common python3 python3-pip \
    && mkdir -m755 -p /etc/apt/keyrings \
    && wget -q -O /etc/apt/keyrings/qgis-archive-keyring.gpg https://download.qgis.org/downloads/qgis-archive-keyring.gpg \
    && printf '%s\n' \
      'Types: deb' \
      'URIs: https://qgis.org/ubuntu-ltr' \
      'Suites: noble' \
      'Architectures: amd64' \
      'Components: main' \
      'Signed-By: /etc/apt/keyrings/qgis-archive-keyring.gpg' \
      > /etc/apt/sources.list.d/qgis.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends qgis python3-qgis qgis-plugin-grass \
    && rm -rf /var/lib/apt/lists/*
ENV QT_QPA_PLATFORM=offscreen
COPY . /workspace
WORKDIR /workspace
CMD ["qgis_process", "--version"]
