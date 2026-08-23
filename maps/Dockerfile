# Basemap build image: the maps/build pipeline plus its tools (tippecanoe/tile-join, pmtiles,
# duckdb, GDAL via rasterio). Inputs and outputs live on a mounted volume; see maps/README.md.
#
#   docker build -t basemap maps
#   docker run --rm -v /data:/data basemap all --work /data/work-z10 --maxzoom 10 \
#       --overture /data/work-z10/overture.duckdb

FROM python:3.12-slim-bookworm AS tools

ARG TIPPECANOE_VERSION=2.79.0
ARG PMTILES_VERSION=1.31.2
ARG DUCKDB_VERSION=1.5.5

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential ca-certificates curl git libsqlite3-dev unzip zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch ${TIPPECANOE_VERSION} https://github.com/felt/tippecanoe /src/tippecanoe \
    && make -C /src/tippecanoe -j"$(nproc)" \
    && make -C /src/tippecanoe install PREFIX=/opt/tools

# Arch from the build host (the legacy builder on Debian's docker.io does not set TARGETARCH).
RUN case "$(uname -m)" in x86_64) p=x86_64; d=amd64 ;; aarch64|arm64) p=arm64; d=arm64 ;; *) echo "unsupported arch"; exit 1 ;; esac \
    && curl -fsSL "https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/go-pmtiles_${PMTILES_VERSION}_Linux_${p}.tar.gz" \
       | tar -xz -C /opt/tools/bin pmtiles \
    && curl -fsSL -o /tmp/duckdb.zip "https://github.com/duckdb/duckdb/releases/download/v${DUCKDB_VERSION}/duckdb_cli-linux-${d}.zip" \
    && unzip -q /tmp/duckdb.zip -d /opt/tools/bin && rm /tmp/duckdb.zip

FROM python:3.12-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl libexpat1 libsqlite3-0 zlib1g \
    && rm -rf /var/lib/apt/lists/*
COPY --from=tools /opt/tools/bin/ /usr/local/bin/

COPY build/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

COPY build/ /app/build/
COPY regions/ /app/regions/
WORKDIR /data
ENV PYTHONUNBUFFERED=1
ENTRYPOINT ["python3", "/app/build/basemap.py"]
CMD ["--help"]
