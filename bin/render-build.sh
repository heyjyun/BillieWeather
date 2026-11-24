#!/usr/bin/env bash
set -euo pipefail

# Asset compilation boots Rails without the service's database credentials.
unset DATABASE_URL_UNPOOLED PRIMARY_DATABASE_URL PGSERVICE PGSERVICEFILE PGHOSTADDR PGOPTIONS PGPASSWORD
export DATABASE_URL=postgresql://127.0.0.1:1/billie_asset_build
export BILLIE_ASSET_BUILD=1 SECRET_KEY_BASE_DUMMY=1

corepack enable
yarn install --immutable
bundle install
bundle exec rake assets:precompile
bundle exec rake assets:clean
