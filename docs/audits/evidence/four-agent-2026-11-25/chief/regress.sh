set -u
unset DATABASE_URL; for v in $(env | grep -E '^(NEON|RENDER)_' | cut -d= -f1); do unset $v; done
export PATH="$HOME/.local/share/mise/installs/ruby/4.0.3/bin:$PATH"
R=$WORKSPACE/billieweather-audit
cd $R; echo "HEAD $(git rev-parse --short HEAD)"
PGD=$SCRATCH/chief/pg; SOCK=$(mktemp -d /private/tmp/chief-pg.XXXX)
initdb -D $PGD/data -U postgres -A trust >/dev/null && pg_ctl -D $PGD/data -o "-p 55440 -k $SOCK -c listen_addresses=127.0.0.1" -l $PGD/log -w start >/dev/null
export RAILS_ENV=test DATABASE_URL=postgresql://postgres@127.0.0.1:55440/billie_chief_test
bin/rails db:create db:schema:load >/dev/null 2>&1 && echo schema-ok
echo "== rails"; bin/rails test > $WORKSPACE/billieweather-audit/docs/audits/evidence/four-agent-2026-11-25/chief/final-rails.log 2>&1; echo "rails exit $?"; tail -3 $WORKSPACE/billieweather-audit/docs/audits/evidence/four-agent-2026-11-25/chief/final-rails.log
pg_ctl -D $PGD/data stop -m fast >/dev/null; rm -rf $PGD $SOCK
cd clients/universal
echo "== tsc"; npx tsc --noEmit > $WORKSPACE/billieweather-audit/docs/audits/evidence/four-agent-2026-11-25/chief/final-tsc.log 2>&1; echo "tsc exit $?"
echo "== vitest"; npx vitest run > $WORKSPACE/billieweather-audit/docs/audits/evidence/four-agent-2026-11-25/chief/final-vitest.log 2>&1; echo "vitest exit $?"; grep -E 'Test Files|Tests ' $WORKSPACE/billieweather-audit/docs/audits/evidence/four-agent-2026-11-25/chief/final-vitest.log
cd src-tauri; export CARGO_TARGET_DIR=$SCRATCH/chief/cargo-target
echo "== cargo"; cargo test --offline --locked > $WORKSPACE/billieweather-audit/docs/audits/evidence/four-agent-2026-11-25/chief/final-cargo.log 2>&1; echo "cargo exit $?"; grep -E '^test result' $WORKSPACE/billieweather-audit/docs/audits/evidence/four-agent-2026-11-25/chief/final-cargo.log
(cargo test --offline --locked -p tauri-plugin-sql >> $WORKSPACE/billieweather-audit/docs/audits/evidence/four-agent-2026-11-25/chief/final-cargo-plugin.log 2>&1; echo "plugin exit $?"; grep -E '^test result' $WORKSPACE/billieweather-audit/docs/audits/evidence/four-agent-2026-11-25/chief/final-cargo-plugin.log)
