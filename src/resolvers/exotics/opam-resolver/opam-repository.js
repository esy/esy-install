/* @flow */

const path = require("path");
const EsyOpam = require("@esy-ocaml/esy-opam");

import type Config from "../../../config";
import * as fs from "../../../util/fs.js";
import { cloneOrUpdateRepository } from "./util.js";
import { OPAM_REPOSITORY, OPAM_SCOPE } from "./config.js";

type OpamRepository = string;

let _initializing: ?Promise<OpamRepository> = null;

/**
 * Initialize opam overrides
 */
export function init(config: Config): Promise<OpamRepository> {
  if (_initializing == null) {
    _initializing = initImpl(config);
  }
  return _initializing;
}

export async function getManifestCollection(
  repository: OpamRepository,
  packageName: string
) {
  const packageDir = path.join(repository, "packages", packageName);
  if (!await fs.exists(packageDir)) {
    throw new Error(`No package found: @${OPAM_SCOPE}/${packageName}`);
  }

  const manifestCollection = await convertOpamToManifestCollection(
    packageName,
    packageDir
  );

  return manifestCollection;
}

async function initImpl(config) {
  const checkoutPath = path.join(config.cacheFolder, "opam-repository");
  await cloneOrUpdateRepository(OPAM_REPOSITORY, checkoutPath);
  return checkoutPath;
}

async function convertOpamToManifest(name, spec, packageDir) {
  const [_, ...versionParts] = spec.split(".");
  const version = versionParts.join(".");
  const opamFilename = path.join(packageDir, spec, "opam");
  const opamFile = EsyOpam.parseOpam(await fs.readFile(opamFilename));
  const manifest = EsyOpam.renderOpam(name, version, opamFile);

  const urlFilename = path.join(packageDir, spec, "url");
  if (!await fs.exists(urlFilename)) {
    // $FlowFixMe: ...
    manifest.opam = { url: null, checksum: null, files: [] };
    return manifest;
  }

  const urlData = await fs.readFile(urlFilename);
  if (urlData != null) {
    const opamUrl = EsyOpam.parseOpamUrl(urlData);
    const url = EsyOpam.renderOpamUrl(opamUrl);
    let checksum = url.checksum.filter(h => h.kind === "md5")[0];
    checksum = checksum ? checksum.contents : null;
    // $FlowFixMe: ...
    manifest.opam = { url: url.url, checksum, files: [] };
  } else {
    // $FlowFixMe: ...
    manifest.opam = { url: null, checksum: null, files: [] };
  }

  const patchFilenames: Array<string> = (manifest: any)._esy_opam_patches;
  if (patchFilenames) {
    // $FlowFixMe: ...
    manifest.opam.patches = await Promise.all(
      patchFilenames.map(async basename => {
        const filename = path.join(packageDir, spec, "files", basename);
        const content = await fs.readFile(filename);
        return { name: basename, content };
      })
    );
  }

  return manifest;
}

async function convertOpamToManifestCollection(name, packageDir) {
  const versionDirList = await fs.readdir(packageDir);
  const manifestList = await Promise.all(
    versionDirList.map(versionDir =>
      convertOpamToManifest(name, versionDir, packageDir)
    )
  );
  const manifestCollection = { name, versions: {} };
  for (const manifest of manifestList) {
    manifestCollection.versions[manifest.version] = manifest;
  }
  return manifestCollection;
}
