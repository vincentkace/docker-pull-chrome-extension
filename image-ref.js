(() => {
  function parseImageReference(input) {
    let value = input.trim();
    if (!value || /\s/.test(value)) throw new Error("镜像名称不能为空，也不能包含空格。");
    if (/^https?:\/\//i.test(value)) {
      const url = new URL(value);
      if (url.protocol !== "https:") throw new Error("Registry 只支持 HTTPS。");
      value = `${url.host}${url.pathname}`.replace(/\/$/, "");
    }

    const parts = value.split("/");
    const first = parts[0];
    const explicitRegistry = parts.length > 1 && (first.includes(".") || first.includes(":") || first === "localhost");
    let registryHost = explicitRegistry ? first : "registry-1.docker.io";
    let imagePath = explicitRegistry ? parts.slice(1).join("/") : value;
    registryHost = registryHost.toLowerCase();
    if (registryHost === "index.docker.io" || registryHost === "docker.io") registryHost = "registry-1.docker.io";

    let imageName = imagePath;
    let reference = "latest";
    const at = imagePath.lastIndexOf("@");
    if (at >= 0) {
      imageName = imagePath.slice(0, at);
      reference = imagePath.slice(at + 1);
      if (!/^sha256:[a-f0-9]{64}$/i.test(reference)) throw new Error("只支持 sha256 镜像 digest。");
    } else {
      const lastSlash = imagePath.lastIndexOf("/");
      const colon = imagePath.lastIndexOf(":");
      if (colon > lastSlash) {
        imageName = imagePath.slice(0, colon);
        reference = imagePath.slice(colon + 1);
      }
      if (!/^[\w][\w.-]{0,127}$/.test(reference)) throw new Error("镜像 tag 格式不正确。");
    }

    const repositoryParts = imageName.split("/");
    if (!repositoryParts.length || repositoryParts.some((part) => !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(part))) {
      throw new Error("repository 名称格式不正确。");
    }
    if (registryHost === "registry-1.docker.io" && repositoryParts.length === 1) repositoryParts.unshift("library");
    const repository = repositoryParts.join("/");
    const tag = reference.startsWith("sha256:") ? "latest" : reference;
    const publicName = registryHost === "registry-1.docker.io" && repository.startsWith("library/")
      ? repository.slice("library/".length)
      : repository;
    const archiveRepo = registryHost === "registry-1.docker.io" ? publicName : `${registryHost}/${repository}`;

    try {
      const parsedHost = new URL(`https://${registryHost}`);
      if (parsedHost.hostname !== registryHost.split(":")[0].toLowerCase() || parsedHost.pathname !== "/") {
        throw new Error("invalid host");
      }
    } catch {
      throw new Error("Registry 域名或端口格式不正确。");
    }

    return {
      registryHost,
      repository,
      reference,
      tag,
      archiveRepo,
      displayName: `${archiveRepo}:${tag}`
    };
  }

  globalThis.DockerImageRef = { parseImageReference };
})();
