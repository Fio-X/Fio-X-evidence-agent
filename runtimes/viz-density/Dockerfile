FROM mambaorg/micromamba:2.3.3
COPY --chown=$MAMBA_USER:$MAMBA_USER runtimes/viz-density/environment.yml /tmp/environment.yml
RUN micromamba create -y -n adn-viz-density -f /tmp/environment.yml && micromamba clean --all --yes
ENV MAMBA_DOCKERFILE_ACTIVATE=1
ENV PATH=/opt/conda/envs/adn-viz-density/bin:$PATH
WORKDIR /workspace
COPY . /workspace
CMD ["python3", "-c", "import datashader, dask, xarray; print(datashader.__version__)"]
