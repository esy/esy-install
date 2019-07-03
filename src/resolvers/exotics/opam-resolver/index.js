/* @flow */

const path = require('path');
const semver = require('semver');
const EsyOpam = require('@esy-ocaml/esy-opam');
const invariant = require('invariant');
const outdent = require('outdent');

import {MessageError} from '../../../errors.js';
import type {Manifest} from '../../../types.js';
import type Config from '../../../config';
import type PackageRequest from '../../../package-request.js';
import type PackageResolver from '../../../package-resolver.js';
import type {LockManifest} from '../../../lockfile';
import ExoticResolver from '.././exotic-resolver.js';
import * as fs from '../../../util/fs.js';
import * as child from '../../../util/child.js';
import * as OpamRepositoryOverride from './opam-repository-override.js';
import * as OpamRepository from './opam-repository.js';
import {cloneOrUpdateRepository, stripVersionPrelease} from './util.js';
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

type Patch = {
  name: string,
  content: string,
};

export type OpamManifest = Manifest & {
  esy: {
    build: string | Array<string> | Array<Array<string>>,
    install: string | Array<string> | Array<Array<string>>,
    exportedEnv: {[name: string]: {val: string, scope?: 'global'}},
  },
  opam: {
    url: ?string,
    version: string,
    checksum: ?string,
    files: Array<File>,
    patches: Array<Patch>,
  },
};

export default class OpamResolver extends ExoticResolver {
  name: string;
  version: string;

  constructor(request: PackageRequest, fragment: string) {
    super(request, fragment);

    const {name, version} = parseFragment(fragment);
    this.name = name;
    this.version = version;
  }

  static isVersion(pattern: string): boolean {
    if (!pattern.startsWith(`@${OPAM_SCOPE}`)) {
      return false;
    }

    // rm leading @
    pattern = pattern[0] === '@' ? pattern.slice(1) : pattern;
    const [_name, constraint] = pattern.split('@');
    return constraint == null || !!semver.validRange(constraint);
  }

  /**
   * Determine if LockfileEntry is incorrect, remove it from lockfile cache and consider the pattern as new
   */
  static isLockfileEntryOutdated(
    resolver: PackageResolver,
    lockfileEntry: LockManifest,
    versionRange: string,
    hasVersion: boolean,
  ): boolean {
    const ocamlVersion = resolver.ocamlVersion;
    const manifestCollection = {
      versions: {
        [lockfileEntry.version]: {
          ...lockfileEntry,
          opam: {version: lockfileEntry.version},
        },
      },
    };
    if (!isValidReference(lockfileEntry.resolved)) {
      return false;
    }
    const isOutdated = !!// TODO: issue warning here
    (
      solveVersionConstraint(lockfileEntry.name, manifestCollection, {
        versionRange,
        ocamlVersion,
      }).type != 'found'
    );
    return isOutdated;
  }

  static getPatternVersion(pattern: string, pkg: Manifest): string {
    return pkg.version;
  }

  async resolve(): Promise<Manifest> {
    const shrunk = this.request.getLocked('opam');
    if (shrunk) {
      return shrunk;
    }

    let manifest = await this.resolveManifest();

    // This is crafted to be compatible with how yarn stores tarballs for
    // packages in offline mirror. Also function below called parseReference()
    // parses this representation.
    const resolved = `${manifest.name}@${manifest.version}-${manifest._uid}.tgz`;

    manifest._remote = {
      type: 'opam',
      registry: 'npm',
      hash: manifest.opam.checksum,
      reference: resolved,
      resolved,
    };

    return manifest;
  }

  async resolveManifest(): Promise<OpamManifest> {
    const versionRange: string =
      this.version == null || this.version === 'latest' ? '*' : this.version;

    const repository = await OpamRepository.init(this.config);

    const manifestCollection = await OpamRepository.getManifestCollection(
      repository,
      this.name,
    );

    const ocamlVersion = this.resolver.ocamlVersion;

    const version = solveVersionConstraint(this.name, manifestCollection, {
      versionRange,
      ocamlVersion,
    });

    switch (version.type) {
      case 'found':
        const manifest = manifestCollection.versions[version.version];
        return manifest;
      case 'no-version-found':
        throw new MessageError(
          dependencyNotFoundErrorMessage('no version found', this.request),
        );
      case 'no-version-found-for-ocaml-constraint':
        throw new MessageError(
          dependencyNotFoundErrorMessage(
            outdent`
              no version found for the current OCaml version ${ocamlVersion}.
              Consider updating OCaml version constraint of your package,
              run 'npm info ocaml' to see available OCaml versions.
            `,
            this.request,
          ),
        );
      default:
        // TODO: why flow can't handle this?
        invariant(false, 'Impossible');
    }
  }
}

export async function lookupManifest(
  name: string,
  version: string,
  config: Config,
): Promise<OpamManifest> {
  const repository = await OpamRepository.init(config);
  const manifestCollection = await OpamRepository.getManifestCollection(repository, name);

  let versions = Object.keys(manifestCollection.versions);
  const manifest = manifestCollection.versions[version];
  return manifest;
}

type MinimalManifest = {
  version: string,
  peerDependencies: {[name: string]: string},
};

type Solution =
  | {type: 'found', version: string}
  | {type: 'no-version-found'}
  | {type: 'no-version-found-for-ocaml-constraint'};

function solveVersionConstraint<M: MinimalManifest>(
  name,
  manifestCollection: {versions: {[version: string]: M}},
  constraint: {versionRange: string, ocamlVersion: ?string},
): Solution {
  function findVersion(versions, versionRange) {
    const versionsParsed = versions.map(version => {
      const v = semver.parse(version);
      invariant(v != null, `Invalid version: @${OPAM_SCOPE}/${name}@${version}`);
      // This is needed so `semver.satisfies()` will accept this for `*`
      // constraint.
      if (!semver.prerelease(versionRange)) {
        (v: any)._prereleaseHidden = v.prerelease;
        v.prerelease = [];
      }
      // $FlowFixMe: ...
      v.opamVersion = manifestCollection.versions[version].opam.version;
      return v;
    });

    (versionsParsed: any).sort((a, b) => {
      return -1 * EsyOpam.versionCompare(a.opamVersion, b.opamVersion);
    });

    for (let i = 0; i < versionsParsed.length; i++) {
      const v = versionsParsed[i];
      if (semver.satisfies((v: any), versionRange)) {
        return {type: 'found', version: v.raw};
      }
    }

    return null;
  }

  const {versionRange, ocamlVersion} = constraint;

  const allVersions = Object.keys(manifestCollection.versions);

  let versions = allVersions;

  // check if we need to restrict the available versions based on the ocaml
  // compiler being used
  if (ocamlVersion != null) {
    const versionsAvailableForOCamlVersion = [];
    for (const version of versions) {
      const manifest = manifestCollection.versions[version];
      // note that we get ocaml compiler version from "peerDependencies" as
      // dependency on ocaml compiler in "dependencies" might be just
      // build-time dependency (this is before we have "buildTimeDependencies"
      // support and we rely on esy-opam putting "ocaml" into
      // "peerDependencies")
      const peerDependencies = manifest.peerDependencies || {};
      const ocamlDependency = peerDependencies.ocaml || '*';
      if (semver.satisfies(ocamlVersion, ocamlDependency)) {
        versionsAvailableForOCamlVersion.push(version);
      }
    }
    versions = versionsAvailableForOCamlVersion;
  }

  const solution = findVersion(versions, versionRange);
  if (solution != null) {
    return solution;
  }

  if (ocamlVersion != null) {
    const solutionWithoutOCamlconstraint = findVersion(allVersions, versionRange);
    if (solutionWithoutOCamlconstraint != null) {
      return {type: 'no-version-found-for-ocaml-constraint'};
    } else {
      return {type: 'no-version-found'};
    }
  } else {
    return {type: 'no-version-found'};
  }
}

function dependencyNotFoundErrorMessage(reason: string, req: PackageRequest) {
  const path = req.parentNames.concat(req.pattern).join(' > ');
  return `${path}: ${reason}`;
}

type OpamPackageReference = {
  fullName: string,
  name: string,
  scope: ?string,
  version: string,
  uid: string,
};

function isValidReference(resolution: ?string) {
  if (resolution == null) {
    return false;
  }
  try {
    parseReference(resolution);
  } catch (err) {
    return false;
  }
  return true;
}

export function parseReference(resolution: string): OpamPackageReference {
  let value = resolution;
  let idx = -1;

  let scope = null;
  if (value[0] === '@') {
    idx = value.indexOf('/');
    invariant(
      idx > -1,
      'Malformed opam package resolution: %s (at "%s")',
      resolution,
      value,
    );
    scope = value.slice(1, idx);
    value = value.slice(idx + 1);
  }

  idx = value.indexOf('@');
  invariant(
    idx > -1,
    'Malformed opam package resolution: %s (at "%s")',
    resolution,
    value,
  );
  const name = value.slice(0, idx);
  value = value.slice(idx + 1);

  idx = value.lastIndexOf('-');
  invariant(
    idx > -1,
    'Malformed opam package resolution: %s (at "%s")',
    resolution,
    value,
  );
  const version = value.slice(0, idx);
  value = value.slice(idx + 1);

  idx = value.indexOf('.tgz');
  invariant(
    idx > -1,
    'Malformed opam package resolution: %s (at "%s")',
    resolution,
    value,
  );
  const uid = value.slice(0, idx);

  return {
    name,
    fullName: scope != null ? `@${scope}/${name}` : name,
    scope,
    version,
    uid,
  };
}

export function parseFragment(fragment: string): {name: string, version: string} {
  fragment = fragment.slice(`@${OPAM_SCOPE}/`.length);
  const [name, version = '*'] = fragment.split('@');
  return {
    name,
    version,
  };
}
