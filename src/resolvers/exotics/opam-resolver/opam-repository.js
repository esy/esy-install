/* @flow */

const path = require('path');
const EsyOpam = require('@esy-ocaml/esy-opam');

import type Config from '../../../config';
import * as crypto from '../../../util/crypto.js';
import * as fs from '../../../util/fs.js';
import {cloneOrUpdateRepository} from './util.js';
import {OPAM_REPOSITORY, OPAM_SCOPE} from './config.js';
import type {OpamManifest} from './index.js';
import * as OpamRepositoryOverride from './opam-repository-override.js';
import * as OpamUrls from './opam-urls.js';

type OpamRepository = {
  urlIndex: OpamUrls.URLIndex,
  checkoutPath: string,
  override: OpamRepositoryOverride.OpamRepositoryOverride,
};

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
  packageName: string,
) {
  const packageDir = path.join(repository.checkoutPath, 'packages', packageName);
  if (!await fs.exists(packageDir)) {
    throw new Error(`No package found in opam repository: @${OPAM_SCOPE}/${packageName}`);
  }

  const manifestCollection = await convertOpamToManifestCollection(
    repository,
    packageName,
    packageDir,
  );

  return manifestCollection;
}

async function initImpl(config: Config) {
  const checkoutPath = path.join(config.cacheFolder, 'opam-repository');
  const onClone = () => {
    config.reporter.info(`Fetching OPAM repository: ${OPAM_REPOSITORY}...`);
  };
  const onUpdate = () => {
    config.reporter.info(`Updating OPAM repository: ${OPAM_REPOSITORY}...`);
  };
  const [_, override, urlIndex] = await Promise.all([
    cloneOrUpdateRepository(OPAM_REPOSITORY, checkoutPath, {
      onClone,
      onUpdate,
      forceUpdate: false,
      offline: config.offline,
      preferOffline: config.preferOffline,
    }),
    OpamRepositoryOverride.init(config),
    OpamUrls.fetchIndex(config),
  ]);
  return {urlIndex, checkoutPath, override};
}

async function convertOpamToManifest(repository, name, spec, packageDir) {
  const [_, ...versionParts] = spec.split('.');
  const opamVersion = versionParts.join('.');
  const opamFilename = path.join(packageDir, spec, 'opam');
  const opamFile = EsyOpam.parseOpam(await fs.readFile(opamFilename));
  let manifest: OpamManifest = (EsyOpam.renderOpam(name, opamVersion, opamFile): any);
  normalizeManifest(manifest);

  const overridenManifest = OpamRepositoryOverride.applyOverride(
    repository.override,
    manifest,
  );

  // If there's no override available — we can try to use prepared tarballs from
  // opam archive which already has patches applied.
  if (overridenManifest == null) {
    const urlRecord = await OpamUrls.resolve(repository.urlIndex, name, opamVersion);
    if (urlRecord != null) {
      manifest.opam.url = urlRecord.url;
      manifest.opam.checksum = urlRecord.checksum;
      manifest.opam.version = opamVersion;
      manifest._uid = crypto.hash(JSON.stringify(manifest));
      return manifest;
    }
  }

  if (overridenManifest != null) {
    manifest = overridenManifest;
  }

  manifest.opam.version = opamVersion;
  manifest._uid = crypto.hash(JSON.stringify(manifest));

  const urlFilename = path.join(packageDir, spec, 'url');

  if (manifest.opam.url == null && (await fs.exists(urlFilename))) {
    const urlData = await fs.readFile(urlFilename);
    if (urlData != null) {
      const opamUrl = EsyOpam.parseOpamUrl(urlData);
      const url = EsyOpam.renderOpamUrl(opamUrl);
      let checksum = url.checksum.filter(h => h.kind === 'md5')[0];
      checksum = checksum ? checksum.contents : null;
      manifest.opam.url = url.url;
      manifest.opam.checksum = checksum;
    }

    const patchFilenames: Array<string> = (manifest: any)._esy_opam_patches;
    if (patchFilenames) {
      manifest.opam.patches = manifest.opam.patches.concat(
        await Promise.all(
          patchFilenames.map(async basename => {
            const filename = path.join(packageDir, spec, 'files', basename);
            const content = await fs.readFile(filename);
            return {name: basename, content};
          }),
        ),
      );
    }
  }

  manifest.opam.files = manifest.opam.files.concat(
    await readPackageFiles(packageDir, spec),
  );

  return manifest;
}

async function readPackageFiles(packageDir, spec) {
  const filesDir = path.join(packageDir, spec, 'files');
  if (await fs.exists(filesDir)) {
    const files = await fs.readdir(filesDir);
    return Promise.all(
      files.map(async name => {
        const filename = path.join(filesDir, name);
        const content = await fs.readFile(filename);
        return {name, content};
      }),
    );
  }
  return [];
}

async function convertOpamToManifestCollection(repository, name, packageDir) {
  const versionDirList = await fs.readdir(packageDir);
  const manifestList = await Promise.all(
    versionDirList.map(versionDir =>
      convertOpamToManifest(repository, name, versionDir, packageDir),
    ),
  );
  const manifestCollection = {name, versions: {}};
  for (const manifest of manifestList) {
    manifestCollection.versions[manifest.version] = manifest;
  }
  return manifestCollection;
}

function normalizeManifest(manifest) {
  manifest.esy = manifest.esy || {};
  manifest.esy.exportedEnv = manifest.esy.exportedEnv || {};
  manifest.opam = manifest.opam || {};
  manifest.opam.url = manifest.opam.url || null;
  manifest.opam.checksum = manifest.opam.checksum || null;
  manifest.opam.files = manifest.opam.files || [];
  manifest.opam.patches = manifest.opam.patches || [];
}
