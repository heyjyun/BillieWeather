#!/usr/bin/env bash
set -euo pipefail

unset BILLIE_ASSET_BUILD
bundle exec rake billie:release:check
exec bundle exec puma -C config/puma.rb
