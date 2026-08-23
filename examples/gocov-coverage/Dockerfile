FROM docker.io/cloudflare/sandbox:0.12.1@sha256:ea9b35e61c800eddbc4450fad333e5dd26033a06f7d36624388b0711bef9f8c5

# Go toolchain for the pipeline runners; the base image does not ship one.
ARG GO_VERSION=1.27.0
ARG GO_SHA256=675c26c449cbb18fc24b74650de1eabbae6e16f64326fd85a283fb3b58280685
RUN curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" -o /tmp/go.tgz \
  && echo "${GO_SHA256}  /tmp/go.tgz" | sha256sum -c - \
  && tar -C /usr/local -xzf /tmp/go.tgz \
  && rm /tmp/go.tgz
ENV PATH=/usr/local/go/bin:$PATH

# Workspace Snapshots capture /workspace only; keeping Go's caches inside it
# lets the cache-keyed install runner restore the module cache on later runs.
ENV GOMODCACHE=/workspace/.cache/go-mod \
    GOCACHE=/workspace/.cache/go-build
