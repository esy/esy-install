/* @flow */

export const OPAM_SCOPE = 'opam-alpha';

export const OPAM_REPOSITORY = process.env.ESY_OPAM_REPOSITORY
  ? process.env.ESY_OPAM_REPOSITORY
  : 'https://github.com/ocaml/opam-repository.git';

export const OPAM_REPOSITORY_OVERRIDE = process.env.ESY_OPAM_REPOSITORY_OVERRIDE
  ? process.env.ESY_OPAM_REPOSITORY_OVERRIDE
  : 'https://github.com/esy-ocaml/esy-opam-override.git';

export const OPAM_REPOSITORY_OVERRIDE_CHECKOUT =
  process.env.ESY_OPAM_REPOSITORY_OVERRIDE_CHECKOUT;
