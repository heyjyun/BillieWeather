# This file is auto-generated from the current state of the database. Instead
# of editing this file, please use the migrations feature of Active Record to
# incrementally modify your database, and then regenerate this schema definition.
#
# This file is the source Rails uses to define your schema when running `bin/rails
# db:schema:load`. When creating a new database, `bin/rails db:schema:load` tends to
# be faster and is potentially less error prone than running all of your
# migrations from scratch. Old migrations may fail to apply correctly if those
# migrations use external dependencies or application code.
#
# It's strongly recommended that you check this file into your version control system.

ActiveRecord::Schema[8.1].define(version: 2026_11_28_000200) do
  # These are extensions that must be enabled in order to support this database
  enable_extension "pg_catalog.plpgsql"
  enable_extension "pgcrypto"

  create_table "account_onboarding_invitation_lists", force: :cascade do |t|
    t.bigint "team_id", null: false
    t.jsonb "invitations"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["team_id"], name: "index_account_onboarding_invitation_lists_on_team_id"
  end

  create_table "action_mailbox_inbound_emails", force: :cascade do |t|
    t.integer "status", default: 0, null: false
    t.string "message_id", null: false
    t.string "message_checksum", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["message_id", "message_checksum"], name: "index_action_mailbox_inbound_emails_uniqueness", unique: true
  end

  create_table "action_text_rich_texts", force: :cascade do |t|
    t.string "name", null: false
    t.text "body"
    t.string "record_type", null: false
    t.bigint "record_id", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["record_type", "record_id", "name"], name: "index_action_text_rich_texts_uniqueness", unique: true
  end

  create_table "active_storage_attachments", force: :cascade do |t|
    t.string "name", null: false
    t.string "record_type", null: false
    t.bigint "record_id", null: false
    t.bigint "blob_id", null: false
    t.datetime "created_at", precision: nil, null: false
    t.index ["blob_id"], name: "index_active_storage_attachments_on_blob_id"
    t.index ["record_type", "record_id", "name", "blob_id"], name: "index_active_storage_attachments_uniqueness", unique: true
  end

  create_table "active_storage_blobs", force: :cascade do |t|
    t.string "key", null: false
    t.string "filename", null: false
    t.string "content_type"
    t.text "metadata"
    t.bigint "byte_size", null: false
    t.string "checksum"
    t.datetime "created_at", precision: nil, null: false
    t.string "service_name", null: false
    t.index ["key"], name: "index_active_storage_blobs_on_key", unique: true
  end

  create_table "active_storage_variant_records", force: :cascade do |t|
    t.bigint "blob_id", null: false
    t.string "variation_digest", null: false
    t.index ["blob_id", "variation_digest"], name: "index_active_storage_variant_records_uniqueness", unique: true
  end

  create_table "addresses", force: :cascade do |t|
    t.string "addressable_type", null: false
    t.bigint "addressable_id", null: false
    t.string "address_one"
    t.string "address_two"
    t.string "city"
    t.integer "region_id"
    t.string "region_name"
    t.integer "country_id"
    t.string "postal_code"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["addressable_type", "addressable_id"], name: "index_addresses_on_addressable"
  end

  create_table "community_honors", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.string "kind", null: false
    t.datetime "granted_at", null: false
    t.bigint "granted_by_id"
    t.datetime "confirmed_at"
    t.string "payment_method"
    t.text "note"
    t.datetime "revoked_at"
    t.bigint "revoked_by_id"
    t.text "revoke_reason"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["granted_by_id"], name: "index_community_honors_on_granted_by_id"
    t.index ["revoked_by_id"], name: "index_community_honors_on_revoked_by_id"
    t.index ["user_id", "kind"], name: "index_community_honors_one_active_per_kind", unique: true, where: "(revoked_at IS NULL)"
    t.index ["user_id"], name: "index_community_honors_on_user_id"
    t.check_constraint "kind::text <> 'founding_patron'::text OR confirmed_at IS NOT NULL AND payment_method IS NOT NULL", name: "community_honors_patron_confirmed"
    t.check_constraint "kind::text = ANY (ARRAY['founding_member'::character varying::text, 'founding_patron'::character varying::text])", name: "community_honors_kind_allowed"
    t.check_constraint "payment_method IS NULL OR (payment_method::text = ANY (ARRAY['alipay'::character varying::text, 'wechat_pay'::character varying::text, 'zelle'::character varying::text, 'venmo'::character varying::text, 'other'::character varying::text]))", name: "community_honors_payment_method_allowed"
  end

  create_table "community_payment_methods", force: :cascade do |t|
    t.string "key", null: false
    t.boolean "note_supported", default: true, null: false
    t.bigint "updated_by_id"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.boolean "enabled", default: false, null: false
    t.index ["key"], name: "index_community_payment_methods_on_key", unique: true
    t.index ["updated_by_id"], name: "index_community_payment_methods_on_updated_by_id"
    t.check_constraint "key::text = ANY (ARRAY['alipay'::character varying::text, 'wechat_pay'::character varying::text, 'zelle'::character varying::text, 'venmo'::character varying::text])", name: "community_payment_methods_key_allowed"
  end

  create_table "community_support_accesses", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.datetime "granted_at", null: false
    t.bigint "granted_by_id"
    t.datetime "revoked_at"
    t.bigint "revoked_by_id"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["granted_by_id"], name: "index_community_support_accesses_on_granted_by_id"
    t.index ["revoked_by_id"], name: "index_community_support_accesses_on_revoked_by_id"
    t.index ["user_id"], name: "index_community_support_accesses_on_user_id", unique: true
  end

  create_table "finance_audit_events", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.uuid "uuid", default: -> { "gen_random_uuid()" }, null: false
    t.string "actor", default: "user", null: false
    t.string "action", null: false
    t.string "subject_type", null: false
    t.string "subject_id"
    t.uuid "batch_id"
    t.string "summary", limit: 300
    t.jsonb "changes_data", default: {}, null: false
    t.jsonb "undo_data"
    t.datetime "created_at", null: false
    t.index ["batch_id"], name: "index_finance_audit_events_on_batch_id"
    t.index ["user_id", "created_at"], name: "index_finance_audit_events_on_user_id_and_created_at"
    t.index ["uuid"], name: "index_finance_audit_events_on_uuid", unique: true
  end

  create_table "finance_bank_accounts", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.string "identity_key"
    t.string "bank_name"
    t.string "name", null: false
    t.string "last4"
    t.string "kind", default: "unknown", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.string "custom_name"
    t.string "account_type", default: "other", null: false
    t.string "currency", limit: 3
    t.decimal "opening_balance", precision: 15, scale: 2, default: "0.0", null: false
    t.date "opening_balance_on"
    t.decimal "credit_limit", precision: 15, scale: 2
    t.integer "statement_day"
    t.integer "due_day"
    t.boolean "include_in_net_worth", default: true, null: false
    t.text "note"
    t.integer "sort_order", default: 0, null: false
    t.datetime "archived_at"
    t.boolean "manual", default: false, null: false
    t.uuid "uuid", default: -> { "gen_random_uuid()" }, null: false
    t.index ["id", "user_id"], name: "index_finance_bank_accounts_on_id_and_owner", unique: true
    t.index ["user_id", "identity_key"], name: "index_finance_bank_accounts_on_user_id_and_identity_key", unique: true
    t.index ["uuid"], name: "index_finance_bank_accounts_on_uuid", unique: true
    t.check_constraint "account_type::text = ANY (ARRAY['checking'::character varying::text, 'savings'::character varying::text, 'cash'::character varying::text, 'payment_app'::character varying::text, 'investment'::character varying::text, 'receivable'::character varying::text, 'credit_card'::character varying::text, 'loan'::character varying::text, 'other'::character varying::text])", name: "finance_bank_accounts_type"
    t.check_constraint "due_day IS NULL OR due_day >= 1 AND due_day <= 31", name: "finance_bank_accounts_due_day"
    t.check_constraint "manual OR identity_key IS NOT NULL", name: "finance_bank_accounts_identity_or_manual"
    t.check_constraint "statement_day IS NULL OR statement_day >= 1 AND statement_day <= 31", name: "finance_bank_accounts_statement_day"
  end

  create_table "finance_books", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.uuid "uuid", default: -> { "gen_random_uuid()" }, null: false
    t.string "name", limit: 60, null: false
    t.string "base_currency", limit: 3, null: false
    t.string "book_type", default: "personal", null: false
    t.integer "month_start_day", default: 1, null: false
    t.boolean "default_book", default: false, null: false
    t.datetime "archived_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["user_id"], name: "index_finance_books_on_user_id"
    t.index ["user_id"], name: "index_finance_books_one_default", unique: true, where: "default_book"
    t.index ["uuid"], name: "index_finance_books_on_uuid", unique: true
    t.check_constraint "book_type::text = ANY (ARRAY['personal'::character varying::text, 'business'::character varying::text])", name: "finance_books_type"
    t.check_constraint "month_start_day >= 1 AND month_start_day <= 28", name: "finance_books_month_start"
  end

  create_table "finance_budgets", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.uuid "uuid", default: -> { "gen_random_uuid()" }, null: false
    t.string "period", default: "month", null: false
    t.string "category"
    t.bigint "project_id"
    t.decimal "amount", precision: 15, scale: 2, null: false
    t.integer "alert_percent", default: 90, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["project_id"], name: "index_finance_budgets_on_project_id"
    t.index ["user_id"], name: "index_finance_budgets_on_user_id"
    t.index ["uuid"], name: "index_finance_budgets_on_uuid", unique: true
    t.check_constraint "alert_percent >= 1 AND alert_percent <= 100", name: "finance_budgets_alert"
    t.check_constraint "amount > 0::numeric", name: "finance_budgets_amount"
    t.check_constraint "period::text = ANY (ARRAY['month'::character varying::text, 'year'::character varying::text])", name: "finance_budgets_period"
  end

  create_table "finance_capture_tokens", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.string "name", limit: 60, null: false
    t.string "token_digest", limit: 64, null: false
    t.string "token_prefix", limit: 12, null: false
    t.datetime "last_used_at"
    t.datetime "expires_at", null: false
    t.datetime "revoked_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["token_digest"], name: "index_finance_capture_tokens_on_token_digest", unique: true
    t.index ["user_id", "revoked_at"], name: "index_finance_capture_tokens_on_user_id_and_revoked_at"
    t.check_constraint "token_digest::text ~ '^[0-9a-f]{64}$'::text", name: "finance_capture_tokens_digest"
  end

  create_table "finance_categories", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.string "name", limit: 40, null: false
    t.bigint "parent_id"
    t.string "system_key", limit: 80
    t.string "category_kind", default: "expense", null: false
    t.integer "sort_order", default: 0, null: false
    t.boolean "hidden", default: false, null: false
    t.boolean "expanded", default: false, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index "user_id, lower((name)::text)", name: "index_finance_categories_on_user_and_lower_name", unique: true
    t.index ["id", "user_id"], name: "index_finance_categories_on_id_and_user", unique: true
    t.index ["user_id", "parent_id"], name: "index_finance_categories_on_user_and_parent"
    t.index ["user_id", "system_key"], name: "index_finance_categories_on_user_and_system_key", unique: true, where: "(system_key IS NOT NULL)"
    t.check_constraint "category_kind::text = ANY (ARRAY['income'::character varying::text, 'expense'::character varying::text, 'transfer'::character varying::text])", name: "finance_categories_kind"
    t.check_constraint "parent_id IS NULL OR parent_id <> id", name: "finance_categories_not_own_parent"
  end

  create_table "finance_category_proposals", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.string "parent_name", limit: 40, null: false
    t.string "name", limit: 40, null: false
    t.jsonb "payload", default: {}, null: false
    t.string "status", limit: 20, default: "pending", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["user_id", "status"], name: "index_finance_category_proposals_on_user_and_status"
    t.check_constraint "status::text = ANY (ARRAY['pending'::character varying::text, 'approved'::character varying::text, 'dismissed'::character varying::text])", name: "finance_category_proposals_status"
  end

  create_table "finance_category_settings", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.string "name", limit: 40, null: false
    t.string "parent_name", limit: 40
    t.string "category_kind", default: "expense", null: false
    t.integer "sort_order", default: 0, null: false
    t.boolean "hidden", default: false, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index "user_id, lower((name)::text)", name: "index_finance_category_settings_on_user_and_lower_name", unique: true
    t.check_constraint "category_kind::text = ANY (ARRAY['expense'::character varying::text, 'income'::character varying::text])", name: "finance_category_settings_kind"
  end

  create_table "finance_command_executions", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.string "idempotency_key", limit: 100, null: false
    t.string "action_id", limit: 60, null: false
    t.string "request_digest", limit: 64, null: false
    t.jsonb "result", default: {}, null: false
    t.jsonb "undo_payload"
    t.string "undo_token_digest", limit: 64
    t.datetime "undo_expires_at"
    t.datetime "undone_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["undo_token_digest"], name: "index_finance_command_executions_on_undo_token_digest", unique: true, where: "(undo_token_digest IS NOT NULL)"
    t.index ["user_id", "created_at"], name: "index_finance_command_executions_on_user_id_and_created_at"
    t.index ["user_id", "idempotency_key"], name: "index_finance_command_executions_on_user_and_key", unique: true
  end

  create_table "finance_custom_categories", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.string "name", limit: 40, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index "user_id, lower((name)::text)", name: "index_finance_custom_categories_on_user_and_lower_name", unique: true
  end

  create_table "finance_insights", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.string "source", null: false
    t.jsonb "content", default: {}, null: false
    t.datetime "generated_at", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.string "kind", default: "general", null: false
    t.index ["user_id", "generated_at"], name: "index_finance_insights_on_user_id_and_generated_at"
    t.index ["user_id", "kind", "generated_at"], name: "index_finance_insights_on_user_id_and_kind_and_generated_at"
  end

  create_table "finance_local_database_audits", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.string "device_id", limit: 36
    t.string "database_id", limit: 36
    t.string "event", limit: 40, null: false
    t.jsonb "details", default: {}, null: false
    t.datetime "created_at", null: false
    t.index ["user_id"], name: "index_finance_local_database_audits_on_user_id"
  end

  create_table "finance_local_database_reports", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.string "device_id", limit: 36, null: false
    t.string "database_id", limit: 36, null: false
    t.string "name", limit: 60
    t.bigint "size_bytes"
    t.integer "statement_count"
    t.integer "transaction_count"
    t.integer "rule_count"
    t.date "period_start"
    t.date "period_end"
    t.datetime "modified_at"
    t.datetime "opened_at"
    t.bigint "sequence", null: false
    t.datetime "reported_at", null: false
    t.datetime "deleted_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.string "status", limit: 16, default: "active", null: false
    t.string "status_reason", limit: 40
    t.datetime "status_changed_at"
    t.datetime "synced_at"
    t.index ["user_id", "database_id"], name: "index_local_database_reports_on_owner_database"
    t.index ["user_id", "device_id", "database_id"], name: "index_local_database_reports_on_owner_device_database", unique: true
  end

  create_table "finance_local_devices", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.string "device_id", limit: 36, null: false
    t.string "name", limit: 80
    t.bigint "purged_through", default: 0, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.string "platform", limit: 16
    t.string "label", limit: 80
    t.datetime "last_reported_at"
    t.index ["user_id", "device_id"], name: "index_finance_local_devices_on_user_id_and_device_id", unique: true
  end

  create_table "finance_merchant_rules", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.string "merchant_key", null: false
    t.boolean "income", default: false, null: false
    t.string "category", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["user_id", "merchant_key", "income"], name: "index_finance_merchant_rules_on_user_merchant_direction", unique: true
  end

  create_table "finance_merchants", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.uuid "uuid", default: -> { "gen_random_uuid()" }, null: false
    t.string "name", limit: 60, null: false
    t.text "note"
    t.integer "sort_order", default: 0, null: false
    t.datetime "archived_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index "user_id, lower((name)::text)", name: "index_finance_merchants_on_user_and_lower_name", unique: true
    t.index ["id", "user_id"], name: "index_finance_merchants_on_id_and_owner", unique: true
    t.index ["uuid"], name: "index_finance_merchants_on_uuid", unique: true
  end

  create_table "finance_module_preference_mutations", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.uuid "mutation_id", null: false
    t.uuid "device_id", null: false
    t.string "request_hash", limit: 64, null: false
    t.jsonb "result", null: false
    t.datetime "created_at", null: false
    t.index ["user_id", "mutation_id"], name: "index_finance_module_preference_mutations_on_user_and_id", unique: true
  end

  create_table "finance_module_preferences", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.string "module_key", limit: 40, null: false
    t.boolean "enabled", null: false
    t.bigint "revision", default: 1, null: false
    t.datetime "changed_at", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.uuid "updated_by_device_id"
    t.index ["user_id", "module_key"], name: "index_finance_module_preferences_one_per_module", unique: true
    t.check_constraint "module_key::text ~ '^[a-z_]{2,40}$'::text", name: "finance_module_preferences_key_format"
    t.check_constraint "revision > 0", name: "finance_module_preferences_revision"
  end

  create_table "finance_organize_runs", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.uuid "uuid", default: -> { "gen_random_uuid()" }, null: false
    t.string "status", default: "preview", null: false
    t.string "engine", default: "rules", null: false
    t.jsonb "proposals", default: [], null: false
    t.uuid "batch_id"
    t.datetime "applied_at"
    t.datetime "undone_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["user_id"], name: "index_finance_organize_runs_on_user_id"
    t.index ["uuid"], name: "index_finance_organize_runs_on_uuid", unique: true
    t.check_constraint "status::text = ANY (ARRAY['preview'::character varying::text, 'applied'::character varying::text, 'undone'::character varying::text, 'discarded'::character varying::text])", name: "finance_organize_runs_status"
  end

  create_table "finance_profiles", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.string "currency", default: "USD", null: false
    t.decimal "current_balance", precision: 15, scale: 2, default: "0.0", null: false
    t.string "tax_country", default: "United States"
    t.string "tax_profile", default: "personal"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.string "balance_source"
    t.date "balance_as_of"
    t.decimal "cash_on_hand", precision: 15, scale: 2, default: "0.0", null: false
    t.date "cash_on_hand_on"
    t.index ["user_id"], name: "index_finance_profiles_on_user_id", unique: true
  end

  create_table "finance_projects", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.uuid "uuid", default: -> { "gen_random_uuid()" }, null: false
    t.string "name", limit: 60, null: false
    t.text "note"
    t.integer "sort_order", default: 0, null: false
    t.datetime "archived_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index "user_id, lower((name)::text)", name: "index_finance_projects_on_user_and_lower_name", unique: true
    t.index ["id", "user_id"], name: "index_finance_projects_on_id_and_owner", unique: true
    t.index ["uuid"], name: "index_finance_projects_on_uuid", unique: true
  end

  create_table "finance_receipt_matches", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.uuid "uuid", default: -> { "gen_random_uuid()" }, null: false
    t.bigint "receipt_id", null: false
    t.bigint "transaction_id", null: false
    t.string "status", default: "suggested", null: false
    t.string "level", null: false
    t.integer "score", default: 0, null: false
    t.jsonb "reasons", default: [], null: false
    t.uuid "group_key"
    t.string "decided_by", default: "auto", null: false
    t.datetime "decided_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["receipt_id", "transaction_id"], name: "index_finance_receipt_matches_pair", unique: true
    t.index ["transaction_id"], name: "index_finance_receipt_matches_one_receipt", unique: true, where: "((status)::text = 'confirmed'::text)"
    t.index ["user_id", "status"], name: "index_finance_receipt_matches_on_owner_status"
    t.index ["uuid"], name: "index_finance_receipt_matches_on_uuid", unique: true
    t.check_constraint "NOT (status::text = 'confirmed'::text AND decided_by::text = 'auto'::text AND level::text <> 'exact'::text)", name: "finance_receipt_matches_auto_exact"
    t.check_constraint "decided_by::text = ANY (ARRAY['user'::character varying::text, 'auto'::character varying::text])", name: "finance_receipt_matches_decided_by"
    t.check_constraint "jsonb_typeof(reasons) = 'array'::text", name: "finance_receipt_matches_reasons"
    t.check_constraint "level::text = ANY (ARRAY['exact'::character varying::text, 'probable'::character varying::text, 'ambiguous'::character varying::text, 'manual'::character varying::text])", name: "finance_receipt_matches_level"
    t.check_constraint "score >= 0 AND score <= 100", name: "finance_receipt_matches_score"
    t.check_constraint "status::text = 'suggested'::text OR decided_at IS NOT NULL", name: "finance_receipt_matches_decided"
    t.check_constraint "status::text = ANY (ARRAY['suggested'::character varying::text, 'confirmed'::character varying::text, 'rejected'::character varying::text])", name: "finance_receipt_matches_status"
  end

  create_table "finance_receipts", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.uuid "uuid", default: -> { "gen_random_uuid()" }, null: false
    t.string "source", default: "upload", null: false
    t.string "status", default: "needs_review", null: false
    t.string "client_request_id", limit: 100
    t.string "filename", limit: 255
    t.string "content_type", limit: 100
    t.bigint "byte_size"
    t.string "sha256", limit: 64
    t.string "extraction_engine", limit: 60
    t.text "ocr_text"
    t.jsonb "extraction", default: {}, null: false
    t.jsonb "issues", default: [], null: false
    t.string "merchant_name", limit: 200
    t.date "purchased_on"
    t.string "purchased_at_time", limit: 5
    t.decimal "total", precision: 15, scale: 2
    t.decimal "subtotal", precision: 15, scale: 2
    t.decimal "tax", precision: 15, scale: 2
    t.decimal "tip", precision: 15, scale: 2
    t.decimal "discount", precision: 15, scale: 2
    t.string "currency", limit: 3
    t.string "direction", default: "purchase", null: false
    t.string "payment_method", limit: 20
    t.string "card_last4", limit: 4
    t.string "receipt_number", limit: 64
    t.string "category"
    t.jsonb "line_items", default: [], null: false
    t.jsonb "confirmed_fields", default: [], null: false
    t.datetime "reviewed_at"
    t.bigint "bank_account_id"
    t.bigint "transaction_id"
    t.bigint "duplicate_of_id"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["duplicate_of_id"], name: "index_finance_receipts_on_duplicate_of_id", where: "(duplicate_of_id IS NOT NULL)"
    t.index ["id", "user_id"], name: "index_finance_receipts_on_id_and_owner", unique: true
    t.index ["transaction_id"], name: "index_finance_receipts_one_entry", unique: true, where: "(transaction_id IS NOT NULL)"
    t.index ["user_id", "client_request_id"], name: "index_finance_receipts_idempotency", unique: true, where: "(client_request_id IS NOT NULL)"
    t.index ["user_id", "sha256"], name: "index_finance_receipts_one_file", unique: true, where: "(sha256 IS NOT NULL)"
    t.index ["user_id", "status", "purchased_on"], name: "index_finance_receipts_on_owner_status_date"
    t.index ["uuid"], name: "index_finance_receipts_on_uuid", unique: true
    t.check_constraint "(status::text = ANY (ARRAY['duplicate'::character varying::text, 'possible_duplicate'::character varying::text])) = (duplicate_of_id IS NOT NULL)", name: "finance_receipts_duplicate_status"
    t.check_constraint "(total IS NULL OR total >= 0::numeric AND total < '10000000000000'::bigint::numeric) AND (subtotal IS NULL OR abs(subtotal) < '10000000000000'::bigint::numeric) AND (tax IS NULL OR abs(tax) < '10000000000000'::bigint::numeric) AND (tip IS NULL OR tip >= 0::numeric AND tip < '10000000000000'::bigint::numeric) AND (discount IS NULL OR discount >= 0::numeric AND discount < '10000000000000'::bigint::numeric)", name: "finance_receipts_money"
    t.check_constraint "byte_size IS NULL OR byte_size > 0 AND byte_size <= 10485760", name: "finance_receipts_byte_size"
    t.check_constraint "card_last4 IS NULL OR card_last4::text ~ '^[0-9]{4}$'::text", name: "finance_receipts_card_last4"
    t.check_constraint "currency IS NULL OR currency::text ~ '^[A-Z]{3}$'::text", name: "finance_receipts_currency"
    t.check_constraint "direction::text = ANY (ARRAY['purchase'::character varying::text, 'refund'::character varying::text])", name: "finance_receipts_direction"
    t.check_constraint "duplicate_of_id IS NULL OR duplicate_of_id <> id", name: "finance_receipts_not_own_duplicate"
    t.check_constraint "jsonb_typeof(extraction) = 'object'::text AND jsonb_typeof(issues) = 'array'::text AND jsonb_typeof(line_items) = 'array'::text AND jsonb_typeof(confirmed_fields) = 'array'::text", name: "finance_receipts_json_shapes"
    t.check_constraint "payment_method IS NULL OR (payment_method::text = ANY (ARRAY['card'::character varying::text, 'cash'::character varying::text, 'mobile'::character varying::text, 'other'::character varying::text]))", name: "finance_receipts_payment_method"
    t.check_constraint "purchased_at_time IS NULL OR purchased_at_time::text ~ '^[0-2][0-9]:[0-5][0-9]$'::text", name: "finance_receipts_time"
    t.check_constraint "sha256 IS NULL OR sha256::text ~ '^[0-9a-f]{64}$'::text", name: "finance_receipts_sha256"
    t.check_constraint "source::text = ANY (ARRAY['camera'::character varying::text, 'upload'::character varying::text, 'shortcut'::character varying::text, 'app'::character varying::text, 'email'::character varying::text, 'manual'::character varying::text])", name: "finance_receipts_source"
    t.check_constraint "status::text = ANY (ARRAY['needs_review'::character varying::text, 'possible_duplicate'::character varying::text, 'duplicate'::character varying::text, 'pending_bank_match'::character varying::text, 'cash'::character varying::text, 'matched'::character varying::text, 'dismissed'::character varying::text])", name: "finance_receipts_status"
  end

  create_table "finance_recurring_rules", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.uuid "uuid", default: -> { "gen_random_uuid()" }, null: false
    t.string "name", limit: 60, null: false
    t.jsonb "template", default: {}, null: false
    t.string "frequency", null: false
    t.integer "interval", default: 1, null: false
    t.date "start_on", null: false
    t.date "end_on"
    t.date "next_on"
    t.boolean "auto_post", default: false, null: false
    t.boolean "paused", default: false, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["id", "user_id"], name: "index_finance_recurring_rules_on_id_and_owner", unique: true
    t.index ["user_id"], name: "index_finance_recurring_rules_on_user_id"
    t.index ["uuid"], name: "index_finance_recurring_rules_on_uuid", unique: true
    t.check_constraint "\"interval\" >= 1 AND \"interval\" <= 365", name: "finance_recurring_interval"
    t.check_constraint "frequency::text = ANY (ARRAY['daily'::character varying::text, 'weekly'::character varying::text, 'monthly'::character varying::text, 'yearly'::character varying::text])", name: "finance_recurring_frequency"
  end

  create_table "finance_sidebar_orders", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.jsonb "module_keys", default: [], null: false
    t.bigint "revision", default: 1, null: false
    t.datetime "changed_at", null: false
    t.uuid "updated_by_device_id"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["user_id"], name: "index_finance_sidebar_orders_on_user_id", unique: true
    t.check_constraint "jsonb_typeof(module_keys) = 'array'::text", name: "finance_sidebar_orders_keys_array"
    t.check_constraint "revision > 0", name: "finance_sidebar_orders_revision"
  end

  create_table "finance_statement_drafts", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.string "filename", null: false
    t.string "sha256", null: false
    t.string "currency", null: false
    t.jsonb "rows", default: [], null: false
    t.jsonb "warnings", default: [], null: false
    t.datetime "expires_at", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.decimal "closing_balance", precision: 15, scale: 2
    t.date "closing_balance_on"
    t.bigint "bank_account_id"
    t.date "balance_observed_on"
    t.index ["bank_account_id"], name: "index_finance_statement_drafts_on_bank_account_id"
    t.index ["expires_at"], name: "index_finance_statement_drafts_on_expires_at"
    t.index ["user_id"], name: "index_finance_statement_drafts_on_user_id"
  end

  create_table "finance_statements", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.string "filename", null: false
    t.string "currency", null: false
    t.string "sha256", null: false
    t.integer "transaction_count", default: 0, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.decimal "closing_balance", precision: 15, scale: 2
    t.date "closing_balance_on"
    t.bigint "bank_account_id"
    t.date "balance_observed_on"
    t.index ["bank_account_id"], name: "index_finance_statements_on_bank_account_id"
    t.index ["id", "user_id"], name: "index_finance_statements_on_id_and_owner", unique: true
    t.index ["user_id", "sha256"], name: "index_finance_statements_on_user_id_and_sha256", unique: true
    t.check_constraint "sha256::text ~ '^[0-9a-f]{64}$'::text", name: "finance_statements_sha256"
    t.check_constraint "transaction_count > 0", name: "finance_statements_rows"
  end

  create_table "finance_tags", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.uuid "uuid", default: -> { "gen_random_uuid()" }, null: false
    t.string "name", limit: 60, null: false
    t.text "note"
    t.integer "sort_order", default: 0, null: false
    t.datetime "archived_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index "user_id, lower((name)::text)", name: "index_finance_tags_on_user_and_lower_name", unique: true
    t.index ["id", "user_id"], name: "index_finance_tags_on_id_and_owner", unique: true
    t.index ["uuid"], name: "index_finance_tags_on_uuid", unique: true
  end

  create_table "finance_transaction_links", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.uuid "uuid", default: -> { "gen_random_uuid()" }, null: false
    t.string "link_type", null: false
    t.bigint "from_transaction_id", null: false
    t.bigint "to_transaction_id"
    t.decimal "amount", precision: 15, scale: 2
    t.string "status", default: "confirmed", null: false
    t.string "decided_by", default: "user", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["from_transaction_id"], name: "index_finance_transaction_links_on_from_transaction_id"
    t.index ["link_type", "from_transaction_id", "to_transaction_id"], name: "index_finance_links_unique", unique: true
    t.index ["to_transaction_id"], name: "index_finance_transaction_links_on_to_transaction_id"
    t.index ["user_id"], name: "index_finance_transaction_links_on_user_id"
    t.index ["uuid"], name: "index_finance_transaction_links_on_uuid", unique: true
    t.check_constraint "amount IS NULL OR amount >= 0::numeric", name: "finance_links_amount"
    t.check_constraint "decided_by::text = ANY (ARRAY['user'::character varying::text, 'rule'::character varying::text, 'auto'::character varying::text, 'ai'::character varying::text])", name: "finance_links_decided_by"
    t.check_constraint "link_type::text = ANY (ARRAY['transfer'::character varying::text, 'card_payment'::character varying::text, 'refund_of'::character varying::text, 'duplicate_of'::character varying::text, 'pending_to_posted'::character varying::text])", name: "finance_links_type"
    t.check_constraint "status::text = ANY (ARRAY['suggested'::character varying::text, 'confirmed'::character varying::text, 'rejected'::character varying::text])", name: "finance_links_status"
    t.check_constraint "to_transaction_id IS NULL OR to_transaction_id <> from_transaction_id", name: "finance_links_two_entries"
  end

  create_table "finance_transaction_tags", primary_key: ["transaction_id", "tag_id"], force: :cascade do |t|
    t.bigint "transaction_id", null: false
    t.bigint "tag_id", null: false
    t.bigint "user_id", null: false
    t.index ["tag_id"], name: "index_finance_transaction_tags_on_tag_id"
    t.index ["user_id", "tag_id"], name: "index_finance_transaction_tags_on_owner_tag"
  end

  create_table "finance_transactions", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.bigint "statement_id"
    t.date "booked_on", null: false
    t.string "description", limit: 500, null: false
    t.decimal "amount", precision: 15, scale: 2, null: false
    t.string "category", default: "Uncategorized", null: false
    t.boolean "tax_review", default: false, null: false
    t.boolean "excluded", default: false, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.uuid "uuid", default: -> { "gen_random_uuid()" }, null: false
    t.string "kind", default: "expense", null: false
    t.string "original_description", limit: 500, null: false
    t.bigint "bank_account_id"
    t.string "entry_origin", default: "import", null: false
    t.datetime "deleted_at"
    t.string "category_source", default: "legacy", null: false
    t.integer "category_confidence"
    t.string "category_model"
    t.jsonb "user_locked_fields", default: [], null: false
    t.text "note"
    t.bigint "merchant_id"
    t.bigint "project_id"
    t.string "occurred_at_time", limit: 5
    t.bigint "recurring_rule_id"
    t.date "recurring_on"
    t.bigint "superseded_by_id"
    t.index ["bank_account_id", "booked_on", "amount"], name: "index_finance_transactions_on_account_date_amount"
    t.index ["id", "user_id"], name: "index_finance_transactions_on_id_and_owner", unique: true
    t.index ["merchant_id"], name: "index_finance_transactions_on_merchant", where: "(merchant_id IS NOT NULL)"
    t.index ["project_id"], name: "index_finance_transactions_on_project", where: "(project_id IS NOT NULL)"
    t.index ["recurring_rule_id", "recurring_on", "bank_account_id"], name: "index_finance_transactions_recurring_once", unique: true, where: "(recurring_rule_id IS NOT NULL)"
    t.index ["statement_id"], name: "index_finance_transactions_on_statement_id"
    t.index ["superseded_by_id"], name: "index_finance_transactions_on_superseded_by", where: "(superseded_by_id IS NOT NULL)"
    t.index ["user_id", "booked_on", "id"], name: "index_finance_transactions_on_live_recent", order: { booked_on: :desc, id: :desc }, where: "(deleted_at IS NULL)"
    t.index ["user_id", "deleted_at"], name: "index_finance_transactions_on_trash", where: "(deleted_at IS NOT NULL)"
    t.index ["user_id", "kind"], name: "index_finance_transactions_on_user_id_and_kind"
    t.index ["uuid"], name: "index_finance_transactions_on_uuid", unique: true
    t.check_constraint "amount > '-10000000000000'::bigint::numeric AND amount < '10000000000000'::bigint::numeric", name: "finance_transactions_amount_range"
    t.check_constraint "category::text <> ''::text", name: "finance_transactions_category_present"
    t.check_constraint "category_source::text = ANY (ARRAY['user'::character varying::text, 'rule'::character varying::text, 'file'::character varying::text, 'auto'::character varying::text, 'region'::character varying::text, 'ai'::character varying::text, 'legacy'::character varying::text])", name: "finance_transactions_category_source"
    t.check_constraint "entry_origin::text = ANY (ARRAY['import'::character varying::text, 'manual'::character varying::text, 'web_copy'::character varying::text, 'upload'::character varying::text, 'recurring'::character varying::text, 'legacy'::character varying::text, 'receipt'::character varying::text])", name: "finance_transactions_entry_origin"
    t.check_constraint "jsonb_typeof(user_locked_fields) = 'array'::text", name: "finance_transactions_locked_fields_array"
    t.check_constraint "kind::text = ANY (ARRAY['expense'::character varying::text, 'income'::character varying::text, 'refund'::character varying::text, 'transfer'::character varying::text, 'card_payment'::character varying::text, 'opening_balance'::character varying::text, 'adjustment'::character varying::text, 'ignored'::character varying::text])", name: "finance_transactions_kind"
    t.check_constraint "occurred_at_time IS NULL OR occurred_at_time::text ~ '^[0-2][0-9]:[0-5][0-9]$'::text", name: "finance_transactions_time"
    t.check_constraint "original_description::text <> ''::text", name: "finance_transactions_original_present"
    t.check_constraint "statement_id IS NOT NULL OR (entry_origin::text = ANY (ARRAY['manual'::character varying::text, 'recurring'::character varying::text, 'receipt'::character varying::text]))", name: "finance_transactions_statement_or_manual"
    t.check_constraint "superseded_by_id IS NULL OR superseded_by_id <> id AND entry_origin::text = 'receipt'::text", name: "finance_transactions_superseded_receipt_only"
  end

  create_table "integrations_stripe_installations", force: :cascade do |t|
    t.bigint "team_id", null: false
    t.bigint "oauth_stripe_account_id", null: false
    t.string "name"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["oauth_stripe_account_id"], name: "index_stripe_installations_on_stripe_account_id"
    t.index ["team_id"], name: "index_integrations_stripe_installations_on_team_id"
  end

  create_table "invitations", id: :serial, force: :cascade do |t|
    t.string "email"
    t.string "uuid"
    t.integer "from_membership_id"
    t.datetime "created_at", precision: nil, null: false
    t.datetime "updated_at", precision: nil, null: false
    t.integer "team_id"
    t.bigint "invitation_list_id"
    t.index ["invitation_list_id"], name: "index_invitations_on_invitation_list_id"
    t.index ["team_id"], name: "index_invitations_on_team_id"
  end

  create_table "memberships", id: :serial, force: :cascade do |t|
    t.integer "user_id"
    t.integer "team_id"
    t.datetime "created_at", precision: nil, null: false
    t.datetime "updated_at", precision: nil, null: false
    t.bigint "invitation_id"
    t.string "user_first_name"
    t.string "user_last_name"
    t.string "user_profile_photo_id"
    t.string "user_email"
    t.bigint "added_by_id"
    t.bigint "platform_agent_of_id"
    t.jsonb "role_ids", default: []
    t.boolean "platform_agent", default: false
    t.index ["added_by_id"], name: "index_memberships_on_added_by_id"
    t.index ["invitation_id"], name: "index_memberships_on_invitation_id"
    t.index ["platform_agent_of_id"], name: "index_memberships_on_platform_agent_of_id"
    t.index ["team_id"], name: "index_memberships_on_team_id"
    t.index ["user_id"], name: "index_memberships_on_user_id"
  end

  create_table "oauth_access_grants", force: :cascade do |t|
    t.bigint "resource_owner_id", null: false
    t.bigint "application_id", null: false
    t.string "token", null: false
    t.integer "expires_in", null: false
    t.text "redirect_uri", null: false
    t.datetime "created_at", precision: nil, null: false
    t.datetime "revoked_at", precision: nil
    t.string "scopes", default: "", null: false
    t.index ["application_id"], name: "index_oauth_access_grants_on_application_id"
    t.index ["resource_owner_id"], name: "index_oauth_access_grants_on_resource_owner_id"
    t.index ["token"], name: "index_oauth_access_grants_on_token", unique: true
  end

  create_table "oauth_access_tokens", force: :cascade do |t|
    t.bigint "resource_owner_id"
    t.bigint "application_id", null: false
    t.string "token", null: false
    t.string "refresh_token"
    t.integer "expires_in"
    t.datetime "revoked_at", precision: nil
    t.datetime "created_at", precision: nil, null: false
    t.string "scopes"
    t.string "previous_refresh_token", default: "", null: false
    t.string "description"
    t.datetime "last_used_at"
    t.boolean "provisioned", default: false
    t.index ["application_id"], name: "index_oauth_access_tokens_on_application_id"
    t.index ["refresh_token"], name: "index_oauth_access_tokens_on_refresh_token", unique: true
    t.index ["resource_owner_id"], name: "index_oauth_access_tokens_on_resource_owner_id"
    t.index ["token"], name: "index_oauth_access_tokens_on_token", unique: true
  end

  create_table "oauth_applications", force: :cascade do |t|
    t.string "name", null: false
    t.string "uid", null: false
    t.string "secret", null: false
    t.text "redirect_uri"
    t.string "scopes", default: "", null: false
    t.boolean "confidential", default: true, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.bigint "team_id"
    t.index ["team_id"], name: "index_oauth_applications_on_team_id"
    t.index ["uid"], name: "index_oauth_applications_on_uid", unique: true
  end

  create_table "oauth_stripe_accounts", force: :cascade do |t|
    t.string "uid"
    t.jsonb "data"
    t.bigint "user_id"
    t.datetime "created_at", precision: nil, null: false
    t.datetime "updated_at", precision: nil, null: false
    t.index ["uid"], name: "index_oauth_stripe_accounts_on_uid", unique: true
    t.index ["user_id"], name: "index_oauth_stripe_accounts_on_user_id"
  end

  create_table "private_storage_files", force: :cascade do |t|
    t.string "key", null: false
    t.binary "data", null: false
    t.bigint "byte_size", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["key"], name: "index_private_storage_files_on_key", unique: true
  end

  create_table "scaffolding_absolutely_abstract_creative_concepts", force: :cascade do |t|
    t.bigint "team_id", null: false
    t.string "name"
    t.text "description"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["team_id"], name: "index_absolutely_abstract_creative_concepts_on_team_id"
  end

  create_table "scaffolding_completely_concrete_tangible_things", force: :cascade do |t|
    t.bigint "absolutely_abstract_creative_concept_id", null: false
    t.string "text_field_value"
    t.string "button_value"
    t.string "cloudinary_image_value"
    t.date "date_field_value"
    t.string "email_field_value"
    t.string "password_field_value"
    t.string "phone_field_value"
    t.string "super_select_value"
    t.text "text_area_value"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.integer "sort_order"
    t.datetime "date_and_time_field_value", precision: nil
    t.jsonb "multiple_button_values", default: []
    t.jsonb "multiple_super_select_values", default: []
    t.string "color_picker_value"
    t.boolean "boolean_button_value"
    t.string "option_value"
    t.jsonb "multiple_option_values", default: []
    t.boolean "boolean_checkbox_value"
    t.index ["absolutely_abstract_creative_concept_id"], name: "index_tangible_things_on_creative_concept_id"
  end

  create_table "scaffolding_completely_concrete_tangible_things_assignments", force: :cascade do |t|
    t.bigint "tangible_thing_id"
    t.bigint "membership_id"
    t.datetime "created_at", precision: nil, null: false
    t.datetime "updated_at", precision: nil, null: false
    t.index ["membership_id"], name: "index_tangible_things_assignments_on_membership_id"
    t.index ["tangible_thing_id"], name: "index_tangible_things_assignments_on_tangible_thing_id"
  end

  create_table "teams", id: :serial, force: :cascade do |t|
    t.string "name"
    t.string "slug"
    t.datetime "created_at", precision: nil, null: false
    t.datetime "updated_at", precision: nil, null: false
    t.boolean "being_destroyed"
    t.string "time_zone"
    t.string "locale"
  end

  create_table "user_sessions", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.string "kind", limit: 8, null: false
    t.string "token_digest", limit: 64, null: false
    t.string "credential_fingerprint", limit: 64, null: false
    t.datetime "expires_at", null: false
    t.datetime "last_used_at"
    t.datetime "revoked_at"
    t.string "revoke_reason", limit: 32
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["token_digest"], name: "index_user_sessions_on_token_digest", unique: true
    t.index ["user_id", "revoked_at"], name: "index_user_sessions_on_user_id_and_revoked_at"
    t.check_constraint "(revoked_at IS NULL) = (revoke_reason IS NULL)", name: "user_sessions_revocation"
    t.check_constraint "credential_fingerprint::text ~ '^[0-9a-f]{64}$'::text", name: "user_sessions_fingerprint"
    t.check_constraint "expires_at > created_at", name: "user_sessions_expiry"
    t.check_constraint "kind::text = ANY (ARRAY['app'::character varying::text, 'web'::character varying::text])", name: "user_sessions_kind"
    t.check_constraint "token_digest::text ~ '^[0-9a-f]{64}$'::text", name: "user_sessions_digest"
  end

  create_table "users", id: :serial, force: :cascade do |t|
    t.string "email", default: "", null: false
    t.string "encrypted_password", default: "", null: false
    t.string "reset_password_token"
    t.datetime "reset_password_sent_at", precision: nil
    t.datetime "remember_created_at", precision: nil
    t.integer "sign_in_count", default: 0, null: false
    t.datetime "current_sign_in_at", precision: nil
    t.datetime "last_sign_in_at", precision: nil
    t.inet "current_sign_in_ip"
    t.inet "last_sign_in_ip"
    t.datetime "created_at", precision: nil, null: false
    t.datetime "updated_at", precision: nil, null: false
    t.integer "current_team_id"
    t.string "first_name"
    t.string "last_name"
    t.string "time_zone"
    t.datetime "last_seen_at", precision: nil
    t.string "profile_photo_id"
    t.jsonb "ability_cache"
    t.datetime "last_notification_email_sent_at", precision: nil
    t.boolean "former_user", default: false, null: false
    t.string "encrypted_otp_secret"
    t.string "encrypted_otp_secret_iv"
    t.string "encrypted_otp_secret_salt"
    t.integer "consumed_timestep"
    t.boolean "otp_required_for_login"
    t.string "otp_backup_codes", array: true
    t.string "locale"
    t.bigint "platform_agent_of_id"
    t.string "otp_secret"
    t.integer "failed_attempts", default: 0, null: false
    t.string "unlock_token"
    t.datetime "locked_at"
    t.string "google_uid"
    t.string "usage_region", limit: 2
    t.boolean "usage_region_pending", default: false, null: false
    t.string "nickname", limit: 40
    t.boolean "supporter_recognition_public", default: false, null: false
    t.string "cloud_database_name", limit: 60
    t.datetime "finance_ai_categorized_at"
    t.uuid "finance_owner_uid", default: -> { "gen_random_uuid()" }, null: false
    t.datetime "finance_categories_seeded_at"
    t.index ["email"], name: "index_users_on_email", unique: true
    t.index ["finance_owner_uid"], name: "index_users_on_finance_owner_uid", unique: true
    t.index ["google_uid"], name: "index_users_on_google_uid", unique: true, where: "(google_uid IS NOT NULL)"
    t.index ["platform_agent_of_id"], name: "index_users_on_platform_agent_of_id"
    t.index ["reset_password_token"], name: "index_users_on_reset_password_token", unique: true
    t.index ["unlock_token"], name: "index_users_on_unlock_token", unique: true
    t.check_constraint "usage_region IS NOT NULL OR usage_region_pending OR platform_agent_of_id IS NOT NULL", name: "users_usage_region_required"
    t.check_constraint "usage_region IS NULL OR (usage_region::text = ANY (ARRAY['AE'::character varying::text, 'AR'::character varying::text, 'AT'::character varying::text, 'AU'::character varying::text, 'BD'::character varying::text, 'BE'::character varying::text, 'BG'::character varying::text, 'BR'::character varying::text, 'CA'::character varying::text, 'CH'::character varying::text, 'CL'::character varying::text, 'CN'::character varying::text, 'CO'::character varying::text, 'CY'::character varying::text, 'CZ'::character varying::text, 'DE'::character varying::text, 'DK'::character varying::text, 'EE'::character varying::text, 'EG'::character varying::text, 'ES'::character varying::text, 'FI'::character varying::text, 'FR'::character varying::text, 'GB'::character varying::text, 'GR'::character varying::text, 'HK'::character varying::text, 'HR'::character varying::text, 'HU'::character varying::text, 'ID'::character varying::text, 'IE'::character varying::text, 'IL'::character varying::text, 'IN'::character varying::text, 'IT'::character varying::text, 'JP'::character varying::text, 'KE'::character varying::text, 'KR'::character varying::text, 'KW'::character varying::text, 'LK'::character varying::text, 'LT'::character varying::text, 'LU'::character varying::text, 'LV'::character varying::text, 'MA'::character varying::text, 'MO'::character varying::text, 'MT'::character varying::text, 'MX'::character varying::text, 'MY'::character varying::text, 'NG'::character varying::text, 'NL'::character varying::text, 'NO'::character varying::text, 'NZ'::character varying::text, 'PE'::character varying::text, 'PH'::character varying::text, 'PK'::character varying::text, 'PL'::character varying::text, 'PR'::character varying::text, 'PT'::character varying::text, 'QA'::character varying::text, 'RO'::character varying::text, 'RU'::character varying::text, 'SA'::character varying::text, 'SE'::character varying::text, 'SG'::character varying::text, 'SI'::character varying::text, 'SK'::character varying::text, 'TH'::character varying::text, 'TR'::character varying::text, 'TW'::character varying::text, 'UA'::character varying::text, 'US'::character varying::text, 'VN'::character varying::text, 'ZA'::character varying::text, 'XG'::character varying::text, 'XO'::character varying::text]))", name: "users_usage_region_allowed"
  end

  create_table "webhooks_incoming_bullet_train_webhooks", force: :cascade do |t|
    t.jsonb "data"
    t.datetime "processed_at", precision: nil
    t.datetime "created_at", precision: nil, null: false
    t.datetime "updated_at", precision: nil, null: false
    t.datetime "verified_at", precision: nil
  end

  create_table "webhooks_incoming_oauth_stripe_account_webhooks", force: :cascade do |t|
    t.jsonb "data"
    t.datetime "processed_at", precision: nil
    t.datetime "verified_at", precision: nil
    t.bigint "oauth_stripe_account_id"
    t.datetime "created_at", precision: nil, null: false
    t.datetime "updated_at", precision: nil, null: false
    t.index ["oauth_stripe_account_id"], name: "index_stripe_webhooks_on_stripe_account_id"
  end

  create_table "webhooks_outgoing_deliveries", force: :cascade do |t|
    t.integer "endpoint_id"
    t.integer "event_id"
    t.text "endpoint_url"
    t.datetime "created_at", precision: nil, null: false
    t.datetime "updated_at", precision: nil, null: false
    t.datetime "delivered_at", precision: nil
    t.index ["endpoint_id", "event_id"], name: "index_webhooks_outgoing_deliveries_on_endpoint_id_and_event_id"
  end

  create_table "webhooks_outgoing_delivery_attempts", force: :cascade do |t|
    t.integer "delivery_id"
    t.integer "response_code"
    t.text "response_body"
    t.datetime "created_at", precision: nil, null: false
    t.datetime "updated_at", precision: nil, null: false
    t.text "response_message"
    t.text "error_message"
    t.integer "attempt_number"
    t.index ["delivery_id"], name: "index_webhooks_outgoing_delivery_attempts_on_delivery_id"
  end

  create_table "webhooks_outgoing_endpoints", force: :cascade do |t|
    t.bigint "team_id"
    t.text "url"
    t.datetime "created_at", precision: nil, null: false
    t.datetime "updated_at", precision: nil, null: false
    t.string "name"
    t.jsonb "event_type_ids", default: []
    t.bigint "scaffolding_absolutely_abstract_creative_concept_id"
    t.integer "api_version", null: false
    t.string "webhook_secret", null: false
    t.datetime "deactivation_limit_reached_at"
    t.datetime "deactivated_at"
    t.integer "consecutive_failed_deliveries", default: 0, null: false
    t.index ["scaffolding_absolutely_abstract_creative_concept_id"], name: "index_endpoints_on_abstract_creative_concept_id"
    t.index ["team_id", "deactivated_at"], name: "idx_on_team_id_deactivated_at_d8a33babf2"
    t.index ["team_id"], name: "index_webhooks_outgoing_endpoints_on_team_id"
  end

  create_table "webhooks_outgoing_events", force: :cascade do |t|
    t.integer "subject_id"
    t.string "subject_type"
    t.jsonb "data"
    t.datetime "created_at", precision: nil, null: false
    t.datetime "updated_at", precision: nil, null: false
    t.bigint "team_id"
    t.string "uuid"
    t.jsonb "payload"
    t.string "event_type_id"
    t.integer "api_version", null: false
    t.index ["team_id"], name: "index_webhooks_outgoing_events_on_team_id"
  end

  add_foreign_key "account_onboarding_invitation_lists", "teams"
  add_foreign_key "active_storage_attachments", "active_storage_blobs", column: "blob_id"
  add_foreign_key "active_storage_variant_records", "active_storage_blobs", column: "blob_id"
  add_foreign_key "community_honors", "users", column: "granted_by_id", on_delete: :nullify
  add_foreign_key "community_honors", "users", column: "revoked_by_id", on_delete: :nullify
  add_foreign_key "community_honors", "users", on_delete: :cascade
  add_foreign_key "community_payment_methods", "users", column: "updated_by_id", on_delete: :nullify
  add_foreign_key "community_support_accesses", "users", column: "granted_by_id", on_delete: :nullify
  add_foreign_key "community_support_accesses", "users", column: "revoked_by_id", on_delete: :nullify
  add_foreign_key "community_support_accesses", "users", on_delete: :cascade
  add_foreign_key "finance_audit_events", "users"
  add_foreign_key "finance_bank_accounts", "users"
  add_foreign_key "finance_books", "users", on_delete: :cascade
  add_foreign_key "finance_budgets", "finance_projects", column: ["project_id", "user_id"], primary_key: ["id", "user_id"], name: "fk_budgets_project_owner", on_delete: :cascade
  add_foreign_key "finance_budgets", "users"
  add_foreign_key "finance_capture_tokens", "users"
  add_foreign_key "finance_categories", "finance_categories", column: ["parent_id", "user_id"], primary_key: ["id", "user_id"], name: "fk_finance_categories_parent_same_user", on_delete: :restrict
  add_foreign_key "finance_categories", "users"
  add_foreign_key "finance_category_proposals", "users", on_delete: :cascade
  add_foreign_key "finance_category_settings", "users"
  add_foreign_key "finance_command_executions", "users"
  add_foreign_key "finance_custom_categories", "users"
  add_foreign_key "finance_insights", "users"
  add_foreign_key "finance_local_database_audits", "users", on_delete: :cascade
  add_foreign_key "finance_local_database_reports", "users", on_delete: :cascade
  add_foreign_key "finance_local_devices", "users", on_delete: :cascade
  add_foreign_key "finance_merchant_rules", "users"
  add_foreign_key "finance_merchants", "users"
  add_foreign_key "finance_module_preference_mutations", "users", on_delete: :cascade
  add_foreign_key "finance_module_preferences", "users", on_delete: :cascade
  add_foreign_key "finance_organize_runs", "users"
  add_foreign_key "finance_profiles", "users"
  add_foreign_key "finance_projects", "users"
  add_foreign_key "finance_receipt_matches", "finance_receipts", column: ["receipt_id", "user_id"], primary_key: ["id", "user_id"], name: "fk_finance_receipt_matches_receipt_id_owner", on_delete: :cascade
  add_foreign_key "finance_receipt_matches", "finance_transactions", column: ["transaction_id", "user_id"], primary_key: ["id", "user_id"], name: "fk_finance_receipt_matches_transaction_id_owner", on_delete: :cascade
  add_foreign_key "finance_receipt_matches", "users"
  add_foreign_key "finance_receipts", "finance_bank_accounts", column: ["bank_account_id", "user_id"], primary_key: ["id", "user_id"], name: "fk_finance_receipts_bank_account_id_owner"
  add_foreign_key "finance_receipts", "finance_receipts", column: ["duplicate_of_id", "user_id"], primary_key: ["id", "user_id"], name: "fk_finance_receipts_duplicate_of_id_owner"
  add_foreign_key "finance_receipts", "finance_transactions", column: ["transaction_id", "user_id"], primary_key: ["id", "user_id"], name: "fk_finance_receipts_transaction_id_owner"
  add_foreign_key "finance_receipts", "users"
  add_foreign_key "finance_recurring_rules", "users"
  add_foreign_key "finance_sidebar_orders", "users", on_delete: :cascade
  add_foreign_key "finance_statement_drafts", "finance_bank_accounts", column: ["bank_account_id", "user_id"], primary_key: ["id", "user_id"], name: "fk_statement_drafts_bank_account_owner"
  add_foreign_key "finance_statement_drafts", "users"
  add_foreign_key "finance_statements", "finance_bank_accounts", column: ["bank_account_id", "user_id"], primary_key: ["id", "user_id"], name: "fk_statements_bank_account_owner"
  add_foreign_key "finance_statements", "users"
  add_foreign_key "finance_tags", "users"
  add_foreign_key "finance_transaction_links", "finance_transactions", column: ["from_transaction_id", "user_id"], primary_key: ["id", "user_id"], name: "fk_transaction_links_from_transaction_owner", on_delete: :cascade
  add_foreign_key "finance_transaction_links", "finance_transactions", column: ["to_transaction_id", "user_id"], primary_key: ["id", "user_id"], name: "fk_transaction_links_to_transaction_owner", on_delete: :cascade
  add_foreign_key "finance_transaction_links", "users"
  add_foreign_key "finance_transaction_tags", "finance_tags", column: ["tag_id", "user_id"], primary_key: ["id", "user_id"], name: "fk_transaction_tags_tag_owner", on_delete: :cascade
  add_foreign_key "finance_transaction_tags", "finance_transactions", column: ["transaction_id", "user_id"], primary_key: ["id", "user_id"], name: "fk_transaction_tags_transaction_owner", on_delete: :cascade
  add_foreign_key "finance_transaction_tags", "users"
  add_foreign_key "finance_transactions", "finance_bank_accounts", column: ["bank_account_id", "user_id"], primary_key: ["id", "user_id"], name: "fk_transactions_bank_account_owner"
  add_foreign_key "finance_transactions", "finance_merchants", column: "merchant_id", on_delete: :nullify
  add_foreign_key "finance_transactions", "finance_merchants", column: ["merchant_id", "user_id"], primary_key: ["id", "user_id"], name: "fk_transactions_merchant_owner"
  add_foreign_key "finance_transactions", "finance_projects", column: "project_id", on_delete: :nullify
  add_foreign_key "finance_transactions", "finance_projects", column: ["project_id", "user_id"], primary_key: ["id", "user_id"], name: "fk_transactions_project_owner"
  add_foreign_key "finance_transactions", "finance_recurring_rules", column: "recurring_rule_id", on_delete: :nullify
  add_foreign_key "finance_transactions", "finance_recurring_rules", column: ["recurring_rule_id", "user_id"], primary_key: ["id", "user_id"], name: "fk_transactions_recurring_rule_owner"
  add_foreign_key "finance_transactions", "finance_statements", column: ["statement_id", "user_id"], primary_key: ["id", "user_id"], name: "fk_transactions_statement_owner"
  add_foreign_key "finance_transactions", "finance_transactions", column: ["superseded_by_id", "user_id"], primary_key: ["id", "user_id"], name: "fk_finance_transactions_superseded_by_id_owner"
  add_foreign_key "finance_transactions", "users"
  add_foreign_key "integrations_stripe_installations", "oauth_stripe_accounts"
  add_foreign_key "integrations_stripe_installations", "teams"
  add_foreign_key "invitations", "account_onboarding_invitation_lists", column: "invitation_list_id"
  add_foreign_key "invitations", "teams"
  add_foreign_key "memberships", "invitations"
  add_foreign_key "memberships", "memberships", column: "added_by_id"
  add_foreign_key "memberships", "oauth_applications", column: "platform_agent_of_id"
  add_foreign_key "memberships", "teams"
  add_foreign_key "memberships", "users"
  add_foreign_key "oauth_access_grants", "oauth_applications", column: "application_id"
  add_foreign_key "oauth_access_tokens", "oauth_applications", column: "application_id"
  add_foreign_key "oauth_applications", "teams"
  add_foreign_key "oauth_stripe_accounts", "users"
  add_foreign_key "scaffolding_absolutely_abstract_creative_concepts", "teams"
  add_foreign_key "scaffolding_completely_concrete_tangible_things", "scaffolding_absolutely_abstract_creative_concepts", column: "absolutely_abstract_creative_concept_id"
  add_foreign_key "scaffolding_completely_concrete_tangible_things_assignments", "memberships"
  add_foreign_key "scaffolding_completely_concrete_tangible_things_assignments", "scaffolding_completely_concrete_tangible_things", column: "tangible_thing_id"
  add_foreign_key "user_sessions", "users", on_delete: :cascade
  add_foreign_key "users", "oauth_applications", column: "platform_agent_of_id"
  add_foreign_key "webhooks_outgoing_endpoints", "scaffolding_absolutely_abstract_creative_concepts"
  add_foreign_key "webhooks_outgoing_endpoints", "teams"
  add_foreign_key "webhooks_outgoing_events", "teams"
end
