(() => {
  const encoder = new TextEncoder();

  function putText(bytes, offset, length, value) {
    const encoded = encoder.encode(value);
    bytes.set(encoded.subarray(0, length), offset);
  }

  function putOctal(bytes, offset, length, value) {
    const text = Math.floor(value).toString(8).padStart(length - 1, "0").slice(-(length - 1)) + "\0";
    putText(bytes, offset, length, text);
  }

  function makeTarHeader(path, size) {
    if (encoder.encode(path).length > 100) throw new Error(`tar 路径过长：${path}`);
    const header = new Uint8Array(512);
    putText(header, 0, 100, path);
    putOctal(header, 100, 8, 0o644);
    putOctal(header, 108, 8, 0);
    putOctal(header, 116, 8, 0);
    putOctal(header, 124, 12, size);
    putOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = "0".charCodeAt(0);
    putText(header, 257, 6, "ustar\0");
    putText(header, 263, 2, "00");
    putText(header, 265, 32, "root");
    putText(header, 297, 32, "root");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    const checksumText = checksum.toString(8).padStart(6, "0") + "\0 ";
    putText(header, 148, 8, checksumText);
    return header;
  }

  class TarWriter {
    constructor(writable) {
      this.writer = writable.getWriter();
    }

    async writeBytes(bytes) {
      await this.writer.write(bytes);
    }

    async addBytes(path, bytes) {
      await this.writeBytes(makeTarHeader(path, bytes.byteLength));
      await this.writeBytes(bytes);
      const padding = (512 - (bytes.byteLength % 512)) % 512;
      if (padding) await this.writeBytes(new Uint8Array(padding));
    }

    async addStream(path, stream, size) {
      await this.writeBytes(makeTarHeader(path, size));
      const reader = stream.getReader();
      let written = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value?.byteLength) {
            written += value.byteLength;
            if (written > size) throw new Error(`tar 文件长度超出预期：${path}`);
            await this.writeBytes(value);
          }
        }
      } finally {
        reader.releaseLock();
      }
      if (written !== size) throw new Error(`tar 文件长度不匹配：${path}（${written}/${size}）`);
      const padding = (512 - (size % 512)) % 512;
      if (padding) await this.writeBytes(new Uint8Array(padding));
    }

    async close() {
      await this.writeBytes(new Uint8Array(1024));
      await this.writer.close();
    }

    async abort(reason) {
      await this.writer.abort(reason);
    }
  }

  globalThis.DockerTar = { TarWriter };
})();
