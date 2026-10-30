const imageInput = document.getElementById("image");
const platformInput = document.getElementById("platform");
const pullButton = document.getElementById("pull");
const diagnoseButton = document.getElementById("diagnose");
const statusEl = document.getElementById("status");
const progressEl = document.getElementById("progress");
let pendingAuthPermission = null;

function setStatus(message, kind = "") {
  statusEl.textContent = message;
  statusEl.dataset.kind = kind;
}

pullButton.addEventListener("click", async () => {
  pullButton.disabled = true;
  try {
    if (pendingAuthPermission) {
      const pending = pendingAuthPermission;
      const pattern = `https://${pending.authHost}/*`;
      const allowed = await chrome.permissions.request({ origins: [pattern] });
      if (!allowed) throw new Error(`没有授予认证服务 ${pending.authHost} 的访问权限。`);
      pendingAuthPermission = null;
      pullButton.textContent = "拉取并下载 .tar";
      await startPull(pending.job);
      return;
    }

    const parsed = DockerImageRef.parseImageReference(imageInput.value);
    const registryPattern = `https://${parsed.registryHost}/*`;
    if (parsed.registryHost !== "registry-1.docker.io") {
      const allowed = await chrome.permissions.request({ origins: [registryPattern] });
      if (!allowed) throw new Error(`没有授予 Registry ${parsed.registryHost} 的访问权限。`);
    }

    progressEl.value = 0;
    setStatus(`正在检查 ${parsed.registryHost} 的认证方式…`);
    const resolved = await chrome.runtime.sendMessage({
      target: "background",
      action: "RESOLVE_REGISTRY",
      registryHost: parsed.registryHost
    });
    if (!resolved?.ok) throw new Error(resolved?.error || "无法读取 Registry 认证信息。");

    const job = {
      image: imageInput.value.trim(),
      platform: platformInput.value,
      taskId: crypto.randomUUID(),
      authInfo: resolved.authInfo
    };
    if (resolved.authInfo?.realm) {
      const authHost = new URL(resolved.authInfo.realm).host;
      const authPattern = `https://${authHost}/*`;
      const hasAuthPermission = await chrome.permissions.contains({ origins: [authPattern] });
      if (!hasAuthPermission) {
        pendingAuthPermission = { authHost, job };
        pullButton.disabled = false;
        pullButton.textContent = `允许 ${authHost} 并继续`;
        setStatus(`Registry 使用独立认证服务 ${authHost}。再次点击按钮授权并继续。`);
        return;
      }
    }
    await startPull(job);
  } catch (error) {
    pullButton.disabled = false;
    pullButton.textContent = "拉取并下载 .tar";
    setStatus(error.message || String(error), "error");
  }
});

async function startPull(job) {
  progressEl.value = 0;
  setStatus("正在启动拉取任务…");
  const result = await chrome.runtime.sendMessage({
    target: "background",
    action: "START_PULL",
    ...job
  });
  if (!result?.ok) throw new Error(result?.error || "无法启动拉取任务");
  setStatus("任务已启动。可以关闭此窗口，下载会继续。", "ok");
}

diagnoseButton.addEventListener("click", async () => {
  diagnoseButton.disabled = true;
  try {
    const parsed = DockerImageRef.parseImageReference(imageInput.value);
    if (parsed.registryHost !== "registry-1.docker.io") {
      const allowed = await chrome.permissions.request({ origins: [`https://${parsed.registryHost}/*`] });
      if (!allowed) throw new Error(`没有授予 Registry ${parsed.registryHost} 的访问权限。`);
    }
    setStatus(`正在检查 ${parsed.registryHost} 连接…`);
    const result = await chrome.runtime.sendMessage({ target: "background", action: "CHECK_NETWORK", registryHost: parsed.registryHost });
    if (!result?.ok) throw new Error(result?.error || "诊断请求失败");
    setStatus(result.results.join("；"), result.results[0]?.includes("可访问") ? "ok" : "error");
  } catch (error) {
    setStatus(error.message || String(error), "error");
  } finally {
    diagnoseButton.disabled = false;
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.target !== "ui") return;
  if (message.type === "PROGRESS") {
    if (typeof message.percent === "number") progressEl.value = message.percent;
    setStatus(message.message || "正在处理…", message.kind || "");
  } else if (message.type === "FAILED") {
    pullButton.disabled = false;
    setStatus(message.message || "拉取失败", "error");
  } else if (message.type === "DOWNLOAD_FINISHED") {
    pullButton.disabled = false;
    setStatus(message.message || "下载完成。", message.kind || "ok");
  }
});
