const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json"
].join(", ");
let runningTask = null;
const jobs = new Map();

function notify(type, payload = {}) {
  return chrome.runtime.sendMessage({ target: "ui", type, ...payload }).catch(() => undefined);
}

async function fetchChecked(url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    const host = new URL(url).hostname;
    throw new Error(`网络请求失败（${host}）：${error.message || error}。请检查扩展的站点访问权限和公司网络策略。`);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}：${detail.slice(0, 240) || response.statusText}`);
  }
  return response;
}

async function getToken(repository, authInfo) {
  if (!authInfo) return null;
  if (authInfo.scheme.toLowerCase() !== "bearer") {
    throw new Error(`Registry 要求 ${authInfo.scheme} 认证；当前版本仅支持公开镜像和匿名 Bearer token。`);
  }
  const url = new URL(authInfo.realm);
  if (url.protocol !== "https:") throw new Error("认证服务必须使用 HTTPS。");
  if (authInfo.service) url.searchParams.set("service", authInfo.service);
  // The registry root challenge can contain a placeholder scope (for example GHCR user/image). Use the actual requested repository.
  url.searchParams.set("scope", `repository:${repository}:pull`);
  const response = await fetchChecked(url);
  const body = await response.json();
  const token = body.token || body.access_token;
  if (!token) throw new Error("Registry 的认证服务未返回拉取 token。");
  return token;
}

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

async function getManifest(registryHost, repository, reference, token) {
  const url = `https://${registryHost}/v2/${repository}/manifests/${encodeURIComponent(reference).replace(/%3A/gi, ":")}`;
  const headers = { Accept: MANIFEST_ACCEPT, ...(token ? bearer(token) : {}) };
  const response = await fetchChecked(url, { headers });
  return response.json();
}

function choosePlatform(manifest, platformText) {
  if (!Array.isArray(manifest.manifests)) return manifest;
  const [os, architecture, variant] = platformText.split("/");
  const candidates = manifest.manifests.filter((item) => item.platform?.os === os && item.platform?.architecture === architecture);
  const selected = variant
    ? candidates.find((item) => item.platform?.variant === variant)
    : candidates.find((item) => !item.platform?.variant) || candidates[0];
  if (!selected) throw new Error(`镜像没有 ${platformText} 平台版本。`);
  if (selected.platform?.os === "unknown" || selected.platform?.architecture === "unknown") {
    throw new Error("镜像索引中的平台信息不完整，无法选择该平台。");
  }
  return selected;
}

function cleanConfigForLegacyLayer(config, id, parentId) {
  const layerConfig = structuredClone(config);
  delete layerConfig.history;
  delete layerConfig.rootfs;
  delete layerConfig.rootfS;
  layerConfig.id = id;
  if (parentId) layerConfig.parent = parentId;
  return layerConfig;
}

async function sha256Text(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function getOpfsPath(taskId, suffix) {
  return `docker-pull-${taskId}-${suffix}`;
}

async function createOpfsFile(root, name) {
  const handle = await root.getFileHandle(name, { create: true });
  const writable = await handle.createWritable({ keepExistingData: false });
  return { handle, writable };
}

async function streamResponseToFile(response, writable, onBytes) {
  if (!response.body) throw new Error("Registry 没有返回可读取的数据流。");
  const writer = writable.getWriter();
  const reader = response.body.getReader();
  let count = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value?.byteLength) {
        count += value.byteLength;
        await writer.write(value);
        onBytes?.(value.byteLength, count);
      }
    }
    await writer.close();
  } catch (error) {
    await writer.abort(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return count;
}

async function makeUncompressedLayer(root, compressedName, uncompressedName, mediaType) {
  if (mediaType.includes("zstd")) {
    throw new Error("该镜像使用 zstd 压缩层；当前 Chrome 版本的 tar 导出只支持 gzip 或未压缩层。");
  }
  const compressedFile = await (await root.getFileHandle(compressedName)).getFile();
  const isGzip = mediaType.includes("gzip") || mediaType.endsWith(".gzip") || mediaType.endsWith("+gzip");
  const output = await createOpfsFile(root, uncompressedName);
  if (isGzip) {
    if (typeof DecompressionStream !== "function") throw new Error("此 Chrome 版本不支持 gzip 流解压。");
    await compressedFile.stream().pipeThrough(new DecompressionStream("gzip")).pipeTo(output.writable);
  } else {
    await compressedFile.stream().pipeTo(output.writable);
  }
  await root.removeEntry(compressedName);
  return await output.handle.getFile();
}

function makeLayerMetadata(config, layerIndex, layerCount, id, parentId) {
  if (layerIndex === layerCount - 1) return cleanConfigForLegacyLayer(config, id, parentId);
  const history = (config.history || []).filter((item) => item.empty_layer !== true);
  const item = history[layerIndex] || {};
  return {
    created: item.created || config.created || "1970-01-01T00:00:00Z",
    container_config: {
      Hostname: "", Domainname: "", User: "", AttachStdin: false,
      AttachStdout: false, AttachStderr: false, Tty: false,
      OpenStdin: false, StdinOnce: false, Env: null, Cmd: item.created_by ? [item.created_by] : null,
      Image: "", Volumes: null, WorkingDir: "", Entrypoint: null,
      OnBuild: null, Labels: null
    },
    id,
    ...(parentId ? { parent: parentId } : {})
  };
}

async function pullImage({ image, platform, taskId, authInfo = null }) {
  const parsed = DockerImageRef.parseImageReference(image);
  const token = await getToken(parsed.repository, authInfo);
  await notify("PROGRESS", { message: `正在解析 ${parsed.displayName}…`, percent: 1 });

  const indexOrManifest = await getManifest(parsed.registryHost, parsed.repository, parsed.reference, token);
  const selected = choosePlatform(indexOrManifest, platform);
  const manifest = selected.digest
    ? await getManifest(parsed.registryHost, parsed.repository, selected.digest, token)
    : selected;
  if (!Array.isArray(manifest.layers) || !manifest.config?.digest) {
    throw new Error("镜像不是受支持的 Docker/OCI schema 2 manifest。");
  }
  if (!manifest.layers.length) throw new Error("暂不支持没有 layer 的镜像。");

  await notify("PROGRESS", { message: `正在获取 ${platform} 配置和 layer 列表…`, percent: 3 });
  const configUrl = `https://${parsed.registryHost}/v2/${parsed.repository}/blobs/${encodeURIComponent(manifest.config.digest).replace(/%3A/gi, ":")}`;
  const configResponse = await fetchChecked(configUrl, { headers: token ? bearer(token) : {} });
  const configBytes = new Uint8Array(await configResponse.arrayBuffer());
  const configText = new TextDecoder().decode(configBytes);
  const config = JSON.parse(configText);

  const layerIds = [];
  let parentId = "";
  for (const layer of manifest.layers) {
    const id = await sha256Text(`${parentId}\n${layer.digest}\n`);
    layerIds.push(id);
    parentId = id;
  }
  const lastLayerId = layerIds[layerIds.length - 1];
  const tag = parsed.reference.startsWith("sha256:") ? "latest" : parsed.reference;
  const repoTags = [parsed.displayName];
  const archiveManifest = [{
    Config: `${manifest.config.digest.slice("sha256:".length)}.json`,
    RepoTags: repoTags,
    Layers: layerIds.map((id) => `${id}/layer.tar`)
  }];
  const repositories = { [parsed.archiveRepo]: { [tag]: lastLayerId } };

  const root = await navigator.storage.getDirectory();
  const archiveName = getOpfsPath(taskId, "archive.tar");
  const archive = await createOpfsFile(root, archiveName);
  const tar = new DockerTar.TarWriter(archive.writable);
  let archiveClosed = false;
  try {
    await tar.addBytes("manifest.json", new TextEncoder().encode(JSON.stringify(archiveManifest)));
    await tar.addBytes("repositories", new TextEncoder().encode(JSON.stringify(repositories)));
    await tar.addBytes(`${manifest.config.digest.slice("sha256:".length)}.json`, configBytes);

    const totalBytes = manifest.layers.reduce((sum, layer) => sum + (Number(layer.size) || 0), 0);
    let downloaded = 0;
    for (let index = 0; index < manifest.layers.length; index += 1) {
      const layer = manifest.layers[index];
      const digestPart = layer.digest.slice("sha256:".length);
      const compressedName = getOpfsPath(taskId, `layer-${index}.compressed`);
      const uncompressedName = getOpfsPath(taskId, `layer-${index}.tar`);
      const url = `https://${parsed.registryHost}/v2/${parsed.repository}/blobs/${encodeURIComponent(layer.digest).replace(/%3A/gi, ":")}`;
      await notify("PROGRESS", {
        message: `下载 layer ${index + 1}/${manifest.layers.length} · ${formatBytes(downloaded)} / ${formatBytes(totalBytes)}`,
        percent: 5 + Math.floor((downloaded / Math.max(totalBytes, 1)) * 75)
      });
      const layerResponse = await fetchChecked(url, { headers: token ? bearer(token) : {} });
      const compressed = await createOpfsFile(root, compressedName);
      let lastProgressAt = 0;
      await streamResponseToFile(layerResponse, compressed.writable, (length) => {
        downloaded += length;
        const now = performance.now();
        if (now - lastProgressAt < 250 && downloaded < totalBytes) return;
        lastProgressAt = now;
        const percent = 5 + Math.floor((downloaded / Math.max(totalBytes, 1)) * 75);
        void notify("PROGRESS", {
          message: `下载 layer ${index + 1}/${manifest.layers.length} · ${formatBytes(downloaded)} / ${formatBytes(totalBytes)}`,
          percent: Math.min(percent, 80)
        });
      });

      const uncompressed = await makeUncompressedLayer(root, compressedName, uncompressedName, layer.mediaType || "");
      const id = layerIds[index];
      await tar.addBytes(`${id}/VERSION`, new TextEncoder().encode("1.0"));
      const metadata = makeLayerMetadata(config, index, manifest.layers.length, id, index ? layerIds[index - 1] : "");
      await tar.addBytes(`${id}/json`, new TextEncoder().encode(JSON.stringify(metadata)));
      await tar.addStream(`${id}/layer.tar`, uncompressed.stream(), uncompressed.size);
      await root.removeEntry(uncompressedName);
      await notify("PROGRESS", {
        message: `已写入 layer ${index + 1}/${manifest.layers.length}，正在生成 Docker archive…`,
        percent: 80 + Math.floor(((index + 1) / manifest.layers.length) * 18)
      });
    }

    await tar.close();
    archiveClosed = true;
    const archiveFile = await archive.handle.getFile();
    const objectUrl = URL.createObjectURL(archiveFile);
    jobs.set(taskId, { archiveName, objectUrl });
    const fileName = `${parsed.displayName.replaceAll("/", "_").replaceAll(":", "_")}.tar`;
    await notify("PROGRESS", { message: "tar 已就绪，交给 Chrome 下载…", percent: 99 });
    const result = await chrome.runtime.sendMessage({
      target: "background",
      action: "DOWNLOAD_ARCHIVE",
      taskId,
      fileName: archiveName,
      url: objectUrl,
      filename: fileName
    });
    if (!result?.ok) throw new Error(result?.error || "Chrome 下载 API 启动失败。");
    await notify("PROGRESS", { message: `下载已开始：${fileName}`, percent: 100, kind: "ok" });
  } catch (error) {
    if (!archiveClosed) await tar.abort(error).catch(() => undefined);
    await cleanupTask(taskId);
    throw error;
  }
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return "0 B";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = value / 1024;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount.toFixed(1)} ${units[unit]}`;
}

async function cleanupTask(taskId) {
  const job = jobs.get(taskId);
  if (job?.objectUrl) URL.revokeObjectURL(job.objectUrl);
  jobs.delete(taskId);
  const root = await navigator.storage.getDirectory();
  const entries = [];
  for await (const [name] of root.entries()) {
    if (name.startsWith(`docker-pull-${taskId}-`)) entries.push(name);
  }
  await Promise.all(entries.map((name) => root.removeEntry(name).catch(() => undefined)));
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") return;

  if (message.action === "START_PULL") {
    if (runningTask || jobs.size) {
      sendResponse({ ok: false, error: "已有一个镜像拉取任务正在运行。" });
      return;
    }
    runningTask = message.taskId;
    sendResponse({ ok: true });
    pullImage(message).then(() => {
      runningTask = null;
    }).catch(async (error) => {
      runningTask = null;
      await notify("FAILED", { message: error.message || String(error), kind: "error" });
      await chrome.runtime.sendMessage({ target: "background", action: "CLOSE_OFFSCREEN" }).catch(() => undefined);
    });
    return;
  }

  if (message.action === "CLEANUP") {
    cleanupTask(message.taskId).then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
});
