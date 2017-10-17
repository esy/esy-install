/* @flow */

const path = require('path');
const semver = require('semver');
const EsyOpam = require('@esy-ocaml/esy-opam');

import type {Manifest} from '../../../types.js';
import type Config from '../../../config';
import type PackageRequest from '../../../package-request.js';
import ExoticResolver from '.././exotic-resolver.js';
import * as fs from '../../../util/fs.js';
import * as child from '../../../util/child.js';
import * as OpamRepositoryOverride from './opam-repository-override.js';
import * as OpamRepository from './opam-repository.js';
import {cloneOrUpdateRepository} from './util.js';
import {OPAM_SCOPE} from './config.js';

export type OpamManifestCollection = {
  versions: {
    [name: string]: OpamManifest,
  },
};

type File = {
  name: string,
  content: string,
};

export type OpamManifest = Manifest & {
  esy: {
    build: string | Array<string> | Array<Array<string>>,
    exportedEnv: {[name: string]: {val: string, scope?: 'global'}},
  },
  opam: {
    url: string,
    files: Array<File>,
    checksum?: string,
    patch?: string,
  },
};

export default class OpamResolver extends ExoticResolver {
  name: string;
  version: string;

  _updatingRepository: ?Promise<void>;

  constructor(request: PackageRequest, fragment: string) {
    super(request, fragment);

    const {name, version} = parseResolution(fragment);
    this.name = name;
    this.version = version;

    this._updatingRepository = null;
  }

  static isVersion(pattern: string): boolean {
    if (!pattern.startsWith(`@${OPAM_SCOPE}`)) {
      return false;
    }

    // rm leading @
    pattern = pattern[0] === '@' ? pattern.slice(1) : pattern;
    const [_name, constraint] = pattern.split('@');
    return !!semver.validRange(constraint);
  }

  static getPatternVersion(pattern: string, pkg: Manifest): string {
    return pkg.version;
  }

  async resolve(): Promise<Manifest> {
    const shrunk = this.request.getLocked('opam');
    if (shrunk) {
      return shrunk;
    }

    let manifest = await resolveManifest(this.name, this.version, this.config);
    const reference = `${manifest.name}@${manifest.version}`;

    manifest._remote = {
      type: 'opam',
      registry: 'npm',
      hash: manifest.opam.checksum,
      reference,
      resolved: reference,
    };

    return manifest;
  }
}

export function parseResolution(fragment: string): {name: string, version: string} {
  fragment = fragment.slice(`@${OPAM_SCOPE}/`.length);
  const [name, version = '*'] = fragment.split('@');
  return {
    name,
    version,
  };
}

export async function resolveManifest(
  name: string,
  versionRange: string,
  config: Config,
): Promise<OpamManifest> {
  const overrides = await OpamRepositoryOverride.init(config);
  const repository = await OpamRepository.init(config);
  const packageDir = path.join(repository, 'packages', name);

  if (!await fs.exists(packageDir)) {
    throw new Error(`No package found: @${OPAM_SCOPE}/${name}`);
  }

  const versionDirList = await fs.readdir(packageDir);
  const packageList = await Promise.all(
    versionDirList.map(async versionDir => {
      const [_, ...versionParts] = versionDir.split('.');
      const version = versionParts.join('.');
      const opamFilename = path.join(packageDir, versionDir, 'opam');
      const opamFile = EsyOpam.parseOpam(await fs.readFile(opamFilename));
      const pkg = EsyOpam.renderOpam(name, version, opamFile);

      const urlFilename = path.join(packageDir, versionDir, 'url');
      if (!await fs.exists(urlFilename)) {
        // $FlowFixMe: ...
        pkg.opam = {url: null, checksum: null, files: []};
        return pkg;
      }

      const urlData = await fs.readFile(urlFilename);
      if (urlData != null) {
        const opamUrl = EsyOpam.parseOpamUrl(urlData);
        const url = EsyOpam.renderOpamUrl(opamUrl);
        let checksum = url.checksum.filter(h => h.kind === 'md5')[0];
        checksum = checksum ? checksum.contents : null;
        // $FlowFixMe: ...
        pkg.opam = {url: url.url, checksum, files: []};
      } else {
        // $FlowFixMe: ...
        pkg.opam = {url: null, checksum: null, files: []};
      }
      return pkg;
    }),
  );
  const manifestByVersion = {name, versions: {}};
  for (const pkg of packageList) {
    manifestByVersion.versions[pkg.version] = pkg;
  }

  const versions = Object.keys(manifestByVersion.versions);
  if (versionRange == null || versionRange === 'latest') {
    versionRange = '*';
  }
  const version = await config.resolveConstraints(versions, versionRange);
  if (version == null) {
    // TODO: figure out how to report error
    throw new Error(`No compatible version found: ${name}@${versionRange}`);
  }
  let manifest = manifestByVersion.versions[version];
  normalizeManifest(manifest);
  manifest._uid = manifest.opam.checksum || manifest.version;
  manifest = OpamRepositoryOverride.applyOverride(overrides, manifest);
  return manifest;
}

function normalizeManifest(manifest) {
  manifest.esy = manifest.esy || {};
  manifest.esy.exportedEnv = manifest.esy.exportedEnv || {};
  manifest.opam = manifest.opam || {};
  manifest.opam.files = manifest.opam.files || [];
}
