# Neon's pooled DATABASE_URL (PgBouncer, transaction mode) can't take advisory locks or hold
# session state, so schema tasks connect through the direct DATABASE_URL_UNPOOLED endpoint.
if ENV["DATABASE_URL_UNPOOLED"].present?
  %w[db:migrate db:migrate:up db:migrate:down db:rollback db:schema:load db:schema:dump db:prepare].each do |name|
    Rake::Task[name].enhance([:use_neon_unpooled_url]) if Rake::Task.task_defined?(name)
  end

  task :use_neon_unpooled_url do
    ENV["DATABASE_URL"] = ENV["DATABASE_URL_UNPOOLED"]
  end
end
