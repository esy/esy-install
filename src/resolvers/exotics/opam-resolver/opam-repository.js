/* @flow */

const path = require('path');

import type Config from '../../../config';
import {cloneOrUpdateRepository} from './util.js';
import {OPAM_REPOSITORY} from './config.js';

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

async function initImpl(config) {
  const checkoutPath = path.join(config.cacheFolder, 'opam-repository');
  await cloneOrUpdateRepository(OPAM_REPOSITORY, checkoutPath);
  return checkoutPath;
}
