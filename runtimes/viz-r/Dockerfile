FROM rocker/geospatial:4.6.1
RUN R -q -e "install.packages(c('sf','terra','stars','ggplot2','ggrepel','mapsf','tmap','tidygraph','igraph','ggraph','sfnetworks','ragg','svglite','arrow','jsonlite','ggalluvial','geosphere'), repos='https://cloud.r-project.org')"
COPY . /workspace
WORKDIR /workspace
