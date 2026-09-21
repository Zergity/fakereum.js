#!/bin/sh
# Deploy one chain's Worker.
#
#   npm run deploy -- <chainid>            code only; secrets are preserved
#   npm run deploy:secrets -- <chainid>    code + upload .prod.vars.<chainid>
#
# The public hostname is deliberately NOT in wrangler.toml. Which zone a
# sandbox answers on is a property of whoever runs this repo, not of the chain
# being forked — the same class of value as ADMINS or GENESIS, which already
# live outside git. It is derived here as fakereum-<chainid>.$DEPLOY_DOMAIN,
# read from the gitignored .deploy.env (see .deploy.env.example). With no such
# file the Worker deploys with its workers.dev host alone, which is what a fork
# that owns no zone wants, and `wrangler deploy` stays the only step either way.
set -e

secrets=''
chain=''
for arg in "$@"; do
  case "$arg" in
    --secrets) secrets=1 ;;
    -*) echo "deploy: unknown option $arg" >&2; exit 2 ;;
    *) chain="$arg" ;;
  esac
done

if [ -z "$chain" ]; then
  echo "usage: npm run deploy[:secrets] -- <chainid>   (e.g. 42161)" >&2
  exit 1
fi

if [ -f .deploy.env ]; then
  . ./.deploy.env
fi

set -- deploy --env "$chain"
if [ -n "$DEPLOY_DOMAIN" ]; then
  set -- "$@" --domain "fakereum-$chain.$DEPLOY_DOMAIN"
fi
if [ -n "$secrets" ]; then
  set -- "$@" --secrets-file ".prod.vars.$chain"
fi

exec npx wrangler "$@"
