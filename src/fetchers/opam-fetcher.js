/**
 * @flow
 */

import type { FetchedOverride } from "../types.js";
import path from "path";
import http from "http";
import { SecurityError } from "../errors.js";
import type { OpamManifest } from "../resolvers/exotics/opam-resolver";
import {
  parseResolution,
  lookupManifest
} from "../resolvers/exotics/opam-resolver";
import BaseFetcher from "../fetchers/base-fetcher.js";
import * as constants from "../constants.js";
import * as fs from "../util/fs.js";
import * as child from "../util/child.js";
import * as nodeFs from "fs";
const nodeCrypto = require("crypto");
import DecompressZip from "decompress-zip";

export default class OpamFetcher extends BaseFetcher {
  async _fetch(): Promise<FetchedOverride> {
    const { dest } = this;
    const resolution = parseResolution(this.reference);
    const manifest = await lookupManifest(
      resolution.name,
      resolution.version,
      this.config
    );
    let hash = this.hash || "";

    if (manifest.opam.url != null) {
      const tarballStorePath = path.join(dest, constants.TARBALL_FILENAME);
      const tarballFormat = getTarballFormatFromFilename(manifest.opam.url);
      hash = await this._fetchTarball(manifest, tarballStorePath);
      await unpackTarball(tarballStorePath, dest, tarballFormat);
    }

    // opam tarballs don't have package.json (obviously) so we put it there
    await writeJson(path.join(dest, "package.json"), manifest);

    await writeFiles(dest, manifest.opam.files);
    await applyPatches(dest, manifest.opam.patches);

    // TODO: what should we done here?
    const fetchOverride = { hash, resolved: null };
    return fetchOverride;
  }

  _fetchTarball(manifest: OpamManifest, filename: string): Promise<string> {
    const registry = this.config.registries[this.registry];
    return registry.request(manifest.opam.url, {
      headers: {
        "Accept-Encoding": "gzip",
        Accept: "application/octet-stream"
      },
      buffer: true,
      process: (req, resolve, reject) => {
        const { reporter } = this.config;

        const handleRequestError = res => {
          if (res.statusCode >= 400) {
            const statusDescription = http.STATUS_CODES[res.statusCode];
            reject(
              new Error(
                reporter.lang(
                  "requestFailed",
                  `${res.statusCode} ${statusDescription}`
                )
              )
            );
          }
        };

        req.on("response", handleRequestError);
        writeValidatedStream(req, filename, manifest.opam.checksum).then(
          resolve,
          reject
        );
      }
    });
  }
}

function writeValidatedStream(
  stream,
  filename,
  md5checksum = null
): Promise<string> {
  const hasher = nodeCrypto.createHash("md5");
  return new Promise((resolve, reject) => {
    const out = nodeFs.createWriteStream(filename);
    stream
      .on("data", chunk => {
        if (md5checksum != null) {
          hasher.update(chunk);
        }
      })
      .pipe(out)
      .on("error", err => {
        reject(err);
      })
      .on("finish", () => {
        const actualChecksum = hasher.digest("hex");
        if (md5checksum != null) {
          if (actualChecksum !== md5checksum) {
            reject(
              new SecurityError(
                `Incorrect md5sum (expected ${md5checksum}, got ${actualChecksum})`
              )
            );
            return;
          }
        }
        resolve(actualChecksum);
      });
    if (stream.resume) {
      stream.resume();
    }
  });
}

function writeJson(filename, object): Promise<void> {
  const data = JSON.stringify(object, null, 2);
  return fs.writeFile(filename, data, { encoding: "utf8" });
}

function unpackTarball(
  filename,
  dest,
  format: "gzip" | "bzip" | "zip" | "xz"
): Promise<void> {
  if (format === "zip") {
    return extractZipIntoDirectory(filename, dest, { strip: 1 });
  } else {
    const unpackOptions =
      format === "gzip" ? "-xzf" : format === "xz" ? "-xJf" : "-xjf";
    return child.exec(
      `tar ${unpackOptions} ${filename} --strip-components 1 -C ${dest}`
    );
  }
}

function extractZipIntoDirectory(filename, dest, options): Promise<void> {
  let seenError = false;
  return new Promise((resolve, reject) => {
    const unzipper = new DecompressZip(filename);
    unzipper.on("error", err => {
      if (!seenError) {
        seenError = true;
        reject(err);
      }
    });

    unzipper.on("extract", () => {
      resolve();
    });

    unzipper.extract({
      ...options,
      path: dest
    });
  });
}

function getTarballFormatFromFilename(
  filename
): "gzip" | "bzip" | "zip" | "xz" {
  if (filename.endsWith(".tgz") || filename.endsWith(".tar.gz")) {
    return "gzip";
  } else if (
    filename.endsWith(".tar.bz") ||
    filename.endsWith(".tar.bz2") ||
    filename.endsWith(".tbz")
  ) {
    return "bzip";
  } else if (filename.endsWith(".zip")) {
    return "zip";
  } else if (filename.endsWith(".xz")) {
    return "xz";
  } else {
    // XXX: default to gzip? Is this safe?
    return "gzip";
  }
}

async function writeFiles(dest, files) {
  if (files.length === 0) {
    return;
  }
  const writes = files.map(async file => {
    const filename = path.join(dest, file.name);
    await fs.mkdirp(path.dirname(filename));
    await fs.writeFile(path.join(dest, file.name), file.content, {
      encoding: "utf8"
    });
  });
  await Promise.all(writes);
}

async function applyPatches(dest, patches) {
  for (const patch of patches) {
    const patchFilename = path.join(dest, patch.name);
    await fs.writeFile(patchFilename, patch.content, { encoding: "utf8" });
    await child.exec("patch -p1 < _esy_patch", {
      cwd: dest,
      shell: "/bin/bash"
    });
    await fs.unlink(patchFilename);
  }
}
