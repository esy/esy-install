/* @flow */

const path = require("path");
const semver = require("semver");
const EsyOpam = require("@esy-ocaml/esy-opam");
const invariant = require("invariant");

import { MessageError } from "../../../errors.js";
import type { Manifest } from "../../../types.js";
import type Config from "../../../config";
import type PackageRequest from "../../../package-request.js";
import ExoticResolver from ".././exotic-resolver.js";
import * as fs from "../../../util/fs.js";
import * as child from "../../../util/child.js";
import * as OpamRepositoryOverride from "./opam-repository-override.js";
import * as OpamRepository from "./opam-repository.js";
import { cloneOrUpdateRepository, stripVersionPrelease } from "./util.js";
import { OPAM_SCOPE } from "./config.js";

export type OpamManifestCollection = {
  versions: {
    [name: string]: OpamManifest
  }
};

type File = {
  name: string,
  content: string
};

type Patch = {
  name: string,
  content: string
};

export type OpamManifest = Manifest & {
  esy: {
    build: string | Array<string> | Array<Array<string>>,
    exportedEnv: { [name: string]: { val: string, scope?: "global" } }
  },
  opam: {
    url: string,
    checksum?: string,
    files: Array<File>,
    patches: Array<Patch>
  }
};

export default class OpamResolver extends ExoticResolver {
  name: string;
  version: string;

  _updatingRepository: ?Promise<void>;

  constructor(request: PackageRequest, fragment: string) {
    super(request, fragment);

    const { name, version } = parseResolution(fragment);
    this.name = name;
    this.version = version;

    this._updatingRepository = null;
  }

  static isVersion(pattern: string): boolean {
    if (!pattern.startsWith(`@${OPAM_SCOPE}`)) {
      return false;
    }

    // rm leading @
    pattern = pattern[0] === "@" ? pattern.slice(1) : pattern;
    const [_name, constraint] = pattern.split("@");
    return !!semver.validRange(constraint);
  }

  /**
   * Determine if LockfileEntry is incorrect, remove it from lockfile cache and consider the pattern as new
   */
  static isLockfileEntryOutdated(
    version: string,
    range: string,
    hasVersion: boolean
  ): boolean {
    version = stripVersionPrelease(version);
    return !!(
      semver.validRange(range) &&
      semver.valid(version) &&
      hasVersion &&
      !semver.satisfies(version, range)
    );
  }

  static getPatternVersion(pattern: string, pkg: Manifest): string {
    return pkg.version;
  }

  async resolve(): Promise<Manifest> {
    const shrunk = this.request.getLocked("opam");
    if (shrunk) {
      return shrunk;
    }

    let manifest = await this.resolveManifest();
    const reference = `${manifest.name}@${manifest.version}`;

    manifest._remote = {
      type: "opam",
      registry: "npm",
      hash: manifest.opam.checksum,
      reference,
      resolved: reference
    };

    return manifest;
  }

  async resolveManifest(): Promise<OpamManifest> {
    const versionRange: string =
      this.version == null || this.version === "latest" ? "*" : this.version;

    const overrides = await OpamRepositoryOverride.init(this.config);
    const repository = await OpamRepository.init(this.config);

    const manifestCollection = await OpamRepository.getManifestCollection(
      repository,
      this.name
    );

    let versions = Object.keys(manifestCollection.versions);

    // check if we need to restrict the available versions based on the ocaml
    // compiler being used
    if (this.resolver.ocamlVersion != null) {
      const deps = [];
      const versionsAvailableForOCamlVersion = [];
      for (const version of versions) {
        const manifest = manifestCollection.versions[version];
        // note that we get ocaml compiler version from "peerDependencies" as
        // dependency on ocaml compiler in "dependencies" might be just
        // build-time dependency (this is before we have "buildTimeDependencies"
        // support and we rely on esy-opam putting "ocaml" into
        // "peerDependencies")
        const peerDependencies = manifest.peerDependencies || {};
        const ocamlDependency = peerDependencies.ocaml || "*";
        deps.push(`${this.name}@${version} requires ${ocamlDependency}`);
        if (semver.satisfies(this.resolver.ocamlVersion, ocamlDependency)) {
          versionsAvailableForOCamlVersion.push(version);
        }
      }
      if (versionsAvailableForOCamlVersion.length === 0) {
        console.log(deps);
        throw new MessageError(
          `No compatible version found: ${this
            .name}@${versionRange} for OCaml ${this.resolver.ocamlVersion}`
        );
      }
      versions = versionsAvailableForOCamlVersion;
    }

    const version = chooseVersion(this.name, versions, versionRange);

    if (version == null) {
      // TODO: figure out how to report error
      throw new MessageError(dependencyNotFoundErrorMessage(this.request));
    }

    let manifest = manifestCollection.versions[version];
    normalizeManifest(manifest);
    manifest._uid = manifest.opam.checksum || manifest.version;
    manifest = OpamRepositoryOverride.applyOverride(overrides, manifest);
    return manifest;
  }
}

export function parseResolution(
  fragment: string
): { name: string, version: string } {
  fragment = fragment.slice(`@${OPAM_SCOPE}/`.length);
  const [name, version = "*"] = fragment.split("@");
  return {
    name,
    version
  };
}

export async function lookupManifest(
  name: string,
  version: string,
  config: Config
): Promise<OpamManifest> {
  const overrides = await OpamRepositoryOverride.init(config);
  const repository = await OpamRepository.init(config);
  const manifestCollection = await OpamRepository.getManifestCollection(
    repository,
    name
  );

  let versions = Object.keys(manifestCollection.versions);
  let manifest = manifestCollection.versions[version];
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
  manifest.opam.patches = manifest.opam.patches || [];
}

function chooseVersion(name, versions, constraint) {
  const versionsParsed = versions.map(version => {
    const v = semver.parse(version);
    invariant(v != null, `Invalid version: @${OPAM_SCOPE}/${name}@${version}`);
    // This is needed so `semver.satisfies()` will accept this for `*`
    // constraint.
    (v: any)._prereleaseHidden = v.prerelease;
    v.prerelease = [];
    return v;
  });

  (versionsParsed: any).sort((a, b) => {
    return -1 * EsyOpam.versionCompare(a.raw, b.raw);
  });

  for (let i = 0; i < versionsParsed.length; i++) {
    const v = versionsParsed[i];
    if (semver.satisfies((v: any), constraint)) {
      return v.raw;
    }
  }

  return null;
}

function dependencyNotFoundErrorMessage(req: PackageRequest) {
  let msg = `No compatible version found: "${req.pattern}"`;
  const parentNames = req.parentNames.slice(0).reverse();
  if (parentNames.length > 0) {
    msg = msg + ` (dependency path: ${parentNames.join(" -> ")})`;
  }
  return msg;
}
