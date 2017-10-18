/* @flow */

const path = require("path");
const invariant = require("invariant");
const semver = require("semver");
const EsyOpam = require("@esy-ocaml/esy-opam");
const crypto = require("crypto");
const yaml = require("js-yaml");

import type { OpamManifest } from "./index.js";
import type Config from "../../../config";
import * as fs from "../../../util/fs.js";
import * as child from "../../../util/child.js";
import { cloneOrUpdateRepository, stripVersionPrelease } from "./util.js";
import {
  OPAM_REPOSITORY_OVERRIDE,
  OPAM_REPOSITORY_OVERRIDE_CHECKOUT,
  OPAM_SCOPE
} from "./config.js";

export type OpamRepositoryOverride = {
  checkoutPath: string,
  overrides: Map<string, Map<string, OpamPackageOverride>>
};

export type OpamPackageOverride = {
  build?: Array<Array<string>>,
  dependencies?: { [name: string]: string },
  exportedEnv: {
    [name: string]: { val: string, scope?: "global" }
  },
  opam: {
    files: Array<{ name: string, content: string }>
  }
};

const MATCH_ALL_VERSIONS = "x.x.x";

let _initializing: ?Promise<OpamRepositoryOverride> = null;

/**
 * Initialize opam overrides
 */
export function init(config: Config): Promise<OpamRepositoryOverride> {
  if (_initializing == null) {
    _initializing = initImpl(config);
  }
  return _initializing;
}

export function applyOverride(
  overrides: OpamRepositoryOverride,
  manifest: OpamManifest
) {
  const packageOverrides = overrides.overrides.get(
    manifest.name.slice(`@${OPAM_SCOPE}/`.length)
  );

  if (packageOverrides == null) {
    return manifest;
  }

  const hasher = crypto.createHash("sha512");
  hasher.update(manifest._uid);

  for (const [versionRange, override] of packageOverrides.entries()) {
    if (
      semver.satisfies(stripVersionPrelease(manifest.version), versionRange)
    ) {
      const { esy, opam } = manifest;

      manifest.esy = {
        ...esy,
        build: override.build || esy.build,
        exportedEnv: {
          ...esy.exportedEnv,
          ...override.exportedEnv
        }
      };
      manifest.opam = {
        ...opam,
        files: opam.files.concat(override.opam.files)
      };
      manifest.dependencies = {
        ...manifest.dependencies,
        ...override.dependencies
      };

      hasher.update(JSON.stringify(override));
    }
  }

  manifest._uid = hasher.digest("hex");

  return manifest;
}

async function initImpl(config) {
  const checkoutPath = await cloneOverridesRepo(config);

  const overridesPath = path.join(checkoutPath, "packages");
  const overridesPathSet = await fs.readdir(overridesPath);

  const overrides = new Map();

  await Promise.all(
    overridesPathSet.map(async spec => {
      const override = await readOverride(path.join(overridesPath, spec));
      if (override == null) {
        return;
      }
      const { packageName, versionRange } = parseOverrideSpec(spec);
      const packageOverrides = mapSetDefault(overrides, packageName, mkMap);
      packageOverrides.set(versionRange, override);
    })
  );

  return { checkoutPath, overrides };
}

function parseOverrideSpec(spec: string) {
  const idx = spec.indexOf(".");
  if (idx === -1) {
    return { packageName: spec, versionRange: MATCH_ALL_VERSIONS };
  } else {
    const packageName = spec.substring(0, idx);
    const versionRange = spec.substring(idx + 1).replace(/_/g, " ");
    return { packageName, versionRange };
  }
}

async function readOverride(root: string): ?Promise<?OpamPackageOverride> {
  const yamlPath = path.join(root, "package.yaml");
  const jsonPath = path.join(root, "package.json");
  if (await fs.exists(yamlPath)) {
    const data = await fs.readFile(yamlPath);
    const override = yaml.safeLoad(data, { filename: yamlPath });
    normalizeOverride(override);
    return override;
  } else if (await fs.exists(jsonPath)) {
    const data = await fs.readFile(jsonPath);
    const override = JSON.parse(data);
    normalizeOverride(override);
    return override;
  } else {
    return null;
  }
}

function normalizeOverride(override) {
  override.exportedEnv = override.exportedEnv || {};
  override.opam = override.opam || {};
  override.opam.files = override.opam.files || [];
}

const mkMap = () => new Map();

function mapSetDefault(map, k, mkDefault) {
  const existingItem = map.get(k);
  if (existingItem !== undefined) {
    return existingItem;
  } else {
    const newItem = mkDefault();
    map.set(k, newItem);
    return newItem;
  }
}

async function cloneOverridesRepo(config) {
  if (OPAM_REPOSITORY_OVERRIDE_CHECKOUT != null) {
    return OPAM_REPOSITORY_OVERRIDE_CHECKOUT;
  }
  const checkoutPath = path.join(config.cacheFolder, "esy-opam-override");
  const onClone = () => {
    config.reporter.info(
      "Cloning esy-ocaml/esy-opam-override (this might take a while)..."
    );
  };
  const onUpdate = () => {
    config.reporter.info(
      "Updating esy-ocaml/esy-opam-override checkout (this might take a while)..."
    );
  };
  await cloneOrUpdateRepository(OPAM_REPOSITORY_OVERRIDE, checkoutPath, {
    onClone,
    onUpdate
  });
  return checkoutPath;
}
