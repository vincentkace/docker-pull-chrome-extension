let creatingOffscreen;

async function ensureOffscreen() {
  const url = chrome.runtime.getURL("offscreen.html");
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [url]
  });
  if (contexts.length) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS"],
      justification: "Stream image layers to OPFS and create a downloadable TAR without holding the full archive in memory."
    }).finally(() => { creatingOffscreen = undefined; });
  }
  await creatingOffscreen;
}

function isOffscreenSender(sender) {
  return sender.url === chrome.runtime.getURL("offscreen.html");
}

function parseAuthChallenge(header) {
  if (!header) return null;
  const match = header.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*(.*)$/);
  if (!match) return null;
  const params = {};
  const expression = /([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(?:"((?:\\.|[^"])*)"|([^,\s]+))/g;
  let item;
  while ((item = expression.exec(match[2]))) {
    params[item[1].toLowerCase()] = (item[2] ?? item[3] ?? "").replace(/\\(.)/g, "$1");
  }
  return { scheme: match[1], ...params };
}

async function resolveRegistryAuth(registryHost) {
  let url;
  try {
    url = new URL(`https://${registryHost}/v2/`);
    if (url.host !== registryHost || url.username || url.password) throw new Error("invalid registry host");
  } catch {
    throw new Error("Registry 域名或端口格式不正确。");
  }
  let response;
  try {
    response = await fetch(url, { cache: "no-store" });
  } catch (error) {
    throw new Error(`无法连接 Registry（${registryHost}）：${error.message || error}。请检查站点权限和网络策略。`);
  }
  const challenge = parseAuthChallenge(response.headers.get("www-authenticate"));
  if (response.status === 401 && challenge) {
    let realm = null;
    if (challenge.realm) {
      try {
        realm = new URL(challenge.realm);
        if (realm.protocol !== "https:" || realm.username || realm.password) throw new Error("invalid realm");
      } catch {
        throw new Error("Registry 返回了无效或非 HTTPS 的认证地址。");
      }
    }
    return {
      authInfo: {
        scheme: challenge.scheme,
        realm: realm?.href || "",
        service: challenge.service || "",
        scope: challenge.scope || ""
      },
      registryStatus: response.status
    };
  }
  if (response.ok) return { authInfo: null, registryStatus: response.status };
  throw new Error(`Registry 探测失败：HTTP ${response.status}。`);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "background") return;

  if (message.action === "CHECK_NETWORK") {
    (async () => {
      const resolved = await resolveRegistryAuth(message.registryHost);
      const authHost = resolved.authInfo?.realm ? new URL(resolved.authInfo.realm).host : "无需单独认证";
      sendResponse({ ok: true, results: [`${message.registryHost}: 可访问（HTTP ${resolved.registryStatus}）`, `认证服务：${authHost}`] });
    })().catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message.action === "RESOLVE_REGISTRY") {
    resolveRegistryAuth(message.registryHost)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message.action === "START_PULL") {
    (async () => {
      await ensureOffscreen();
      const result = await chrome.runtime.sendMessage({
        target: "offscreen",
        action: "START_PULL",
        image: message.image,
        platform: message.platform,
        taskId: message.taskId,
        authInfo: message.authInfo
      });
      sendResponse(result || { ok: true });
    })().catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message.action === "DOWNLOAD_ARCHIVE" && isOffscreenSender(sender)) {
    (async () => {
      const allowedPrefix = `blob:${chrome.runtime.getURL("")}`;
      if (typeof message.url !== "string" || !message.url.startsWith(allowedPrefix)) {
        throw new Error("拒绝下载非扩展创建的文件 URL。");
      }
      const downloadId = await chrome.downloads.download({
        url: message.url,
        filename: message.filename,
        saveAs: true
      });
      const key = `dockerPullDownload:${downloadId}`;
      await chrome.storage.session.set({
        [key]: { taskId: message.taskId, url: message.url, fileName: message.fileName }
      });
      sendResponse({ ok: true, downloadId });
      const [item] = await chrome.downloads.search({ id: downloadId });
      if (item && (item.state === "complete" || item.state === "interrupted")) {
        await cleanupDownload(downloadId, key);
      }
    })().catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message.action === "CLOSE_OFFSCREEN" && isOffscreenSender(sender)) {
    chrome.offscreen.closeDocument().then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
});

async function cleanupDownload(downloadId, key) {
  const stored = (await chrome.storage.session.get(key))[key];
  if (!stored) return;
  try {
    await chrome.runtime.sendMessage({ target: "offscreen", action: "CLEANUP", ...stored });
  } catch { /* The offscreen document may already have been closed. */ }
  await chrome.storage.session.remove(key);
  await chrome.runtime.sendMessage({
    target: "ui",
    type: stored.state === "interrupted" ? "FAILED" : "DOWNLOAD_FINISHED",
    kind: stored.state === "interrupted" ? "error" : "ok",
    message: stored.state === "interrupted" ? "Chrome 中断了 TAR 下载。" : "TAR 下载完成。"
  }).catch(() => undefined);
  try { await chrome.offscreen.closeDocument(); } catch { /* Already closed. */ }
}

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state || !["complete", "interrupted"].includes(delta.state.current)) return;
  const key = `dockerPullDownload:${delta.id}`;
  void (async () => {
    const result = await chrome.storage.session.get(key);
    const stored = result[key];
    if (!stored) return;
    await chrome.storage.session.set({ [key]: { ...stored, state: delta.state.current } });
    await cleanupDownload(delta.id, key);
  })().catch(() => undefined);
});
