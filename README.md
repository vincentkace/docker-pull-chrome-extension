# Docker Image TAR Downloader (Chrome Extension)

Manifest V3 extension that pulls **public Docker Registry v2 images** and downloads a Docker-compatible archive that can be imported with `docker load -i image.tar` on a machine that has Docker.

## Install for development

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this `docker-pull-extension` directory.
4. Open the extension popup, enter an image such as `hello-world:latest`, `python:3.12-slim`, or `docker.langfuse.com/langfuse/langfuse-worker:4`, choose a platform, and click **拉取并下载 .tar**.

For a custom registry, Chrome asks for that registry host permission when the user starts a pull. If the registry advertises a separate Bearer-token service, the popup asks for that host in a second step. Docker Hub and its known layer CDN are declared directly. The extension uses host permissions to make cross-origin requests from its own extension origin.

## Scope and format

- HTTPS Registry v2 public images, including Docker Hub and registries such as `docker.langfuse.com`.
- Public GHCR images use an image-specific anonymous Bearer-token scope. Private registries, Basic authentication, and credential entry are not supported. The Registry may use anonymous Bearer-token authentication.
- A registry that redirects layer blobs to a separate CDN must have that CDN host permission too. The Docker Hub CDN used by the tested Langfuse registry is declared; other CDN hosts may need to be added to `manifest.json`.
- Custom registries must have a valid HTTPS certificate and support Docker schema 2 or OCI manifests.
- Supports Docker schema 2 and OCI manifests, including platform selection from a multi-architecture index.
- The TAR uses the Docker archive layout (`manifest.json`, `repositories`, config JSON, and per-layer `VERSION`, `json`, and `layer.tar`).
- Registry gzip layers are decompressed as streams. The archive and temporary layer data are written to OPFS so the complete image is not accumulated in JavaScript memory.
- zstd-compressed layers currently report an unsupported-format error.
- The extension does not run Docker or execute image contents.

The Registry request and image layout follow the Docker Registry HTTP API and the workflow demonstrated by [docker-drag](https://github.com/NotGlop/docker-drag). This implementation is a separate JavaScript implementation.
