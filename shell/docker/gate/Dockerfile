# Packaged-app gate resolver (PLAN-M0 final exit item).
#
# Ubuntu toolchain image for building the Tauri shell + booting the core
# sidecar artifact headlessly. The HOST has no Rust/gcc/webkit dev libs and
# no passwordless sudo, so everything needed for the gate runs here.
#   docker build -t partner-gate -f shell/docker/gate/Dockerfile shell/docker/gate
#   docker run --rm -v <repo>:/workspace -v partner-target:/target-cache partner-gate
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential pkg-config curl ca-certificates git \
      libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
      librsvg2-dev libssl-dev libxdo-dev \
      xvfb dbus-x11 imagemagick \
      nodejs npm \
    && rm -rf /var/lib/apt/lists/*

# Rust toolchain (user-level inside the image).
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --profile minimal --default-toolchain stable

WORKDIR /workspace
CMD ["bash", "/workspace/shell/docker/gate/run.sh"]
