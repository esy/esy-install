/* @flow */

const invariant = require("invariant");
const path = require("path");
const semver = require("semver");

import * as fs from "../../../util/fs.js";
import * as child from "../../../util/child.js";

export async function cloneOrUpdateRepository(
  remotePath: string,
  checkoutPath: string,
  params?: { onClone?: () => void, onUpdate?: () => void } = {}
) {
  if (await fs.exists(checkoutPath)) {
    const localCommit = await gitReadMaster(checkoutPath);
    const remoteCommit = await gitReadMaster(remotePath);
    if (localCommit !== remoteCommit) {
      if (params.onUpdate != null) {
        params.onUpdate();
      }
      // TODO: this could be done more efficiently
      await child.spawn("git", ["pull", "-f", remotePath, "master"], {
        cwd: checkoutPath
      });
    }
  } else {
    if (params.onClone != null) {
      params.onClone();
    }
    // TODO: this could be done more efficiently
    await child.spawn("git", ["clone", remotePath, checkoutPath]);
  }
}

export async function gitReadMaster(repo: string) {
  const data = await child.spawn("git", [
    "ls-remote",
    repo,
    "-r",
    "heads/master"
  ]);
  const [commitId] = data.split("\t");
  return commitId.trim();
}

export function stripVersionPrelease(version: string): string {
  const v = semver.parse(version);
  invariant(v != null, `Invalid version: ${version}`);
  v.prerelease = [];
  // $FlowFixMe: update semver typings
  return v.format();
}
