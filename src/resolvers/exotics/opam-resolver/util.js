/* @flow */

const path = require('path');

import * as fs from '../../../util/fs.js';
import * as child from '../../../util/child.js';

export async function cloneOrUpdateRepository(remotePath: string, checkoutPath: string) {
  if (await fs.exists(checkoutPath)) {
    const localCommit = await gitReadMaster(checkoutPath);
    const remoteCommit = await gitReadMaster(remotePath);
    if (localCommit !== remoteCommit) {
      // TODO: this could be done more efficiently
      await child.spawn('git', ['pull', '-f', remotePath, 'master'], {
        cwd: checkoutPath,
      });
    }
  } else {
    // TODO: this could be done more efficiently
    await child.spawn('git', ['clone', remotePath, checkoutPath]);
  }
}

export async function gitReadMaster(repo: string) {
  const data = await child.spawn('git', ['ls-remote', repo, '-r', 'heads/master']);
  const [commitId] = data.split('\t');
  return commitId.trim();
}
