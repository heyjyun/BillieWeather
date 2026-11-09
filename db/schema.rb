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

ActiveRecord::Schema[8.1].define(version: 2026_11_09_000500) do
  # These are extensions that must be enabled in order to support this database
  enable_extension "pg_catalog.plpgsql"

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
    t.check_constraint "kind::text = ANY (ARRAY['founding_member'::character varying, 'founding_patron'::character varying]::text[])", name: "community_honors_kind_allowed"
    t.check_constraint "payment_method IS NULL OR (payment_method::text = ANY (ARRAY['alipay'::character varying, 'wechat_pay'::character varying, 'zelle'::character varying, 'venmo'::character varying, 'other'::character varying]::text[]))", name: "community_honors_payment_method_allowed"
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
    t.check_constraint "key::text = ANY (ARRAY['alipay'::character varying, 'wechat_pay'::character varying, 'zelle'::character varying, 'venmo'::character varying]::text[])", name: "community_payment_methods_key_allowed"
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

  create_table "finance_bank_accounts", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.string "identity_key", null: false
    t.string "bank_name", null: false
    t.string "name", null: false
    t.string "last4", null: false
    t.string "kind", default: "unknown", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.string "custom_name"
    t.index ["user_id", "identity_key"], name: "index_finance_bank_accounts_on_user_id_and_identity_key", unique: true
    t.index ["user_id"], name: "index_finance_bank_accounts_on_user_id"
  end

  create_table "finance_custom_categories", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.string "name", limit: 40, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index "user_id, lower((name)::text)", name: "index_finance_custom_categories_on_user_and_lower_name", unique: true
    t.index ["user_id"], name: "index_finance_custom_categories_on_user_id"
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
    t.index ["user_id"], name: "index_finance_insights_on_user_id"
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
    t.index ["user_id", "device_id", "database_id"], name: "index_local_database_reports_on_owner_device_database", unique: true
    t.index ["user_id"], name: "index_finance_local_database_reports_on_user_id"
  end

  create_table "finance_local_devices", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.string "device_id", limit: 36, null: false
    t.string "name", limit: 80
    t.bigint "purged_through", default: 0, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["user_id", "device_id"], name: "index_finance_local_devices_on_user_id_and_device_id", unique: true
    t.index ["user_id"], name: "index_finance_local_devices_on_user_id"
  end

  create_table "finance_merchant_rules", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.string "merchant_key", null: false
    t.boolean "income", default: false, null: false
    t.string "category", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["user_id", "merchant_key", "income"], name: "index_finance_merchant_rules_on_user_merchant_direction", unique: true
    t.index ["user_id"], name: "index_finance_merchant_rules_on_user_id"
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
    t.string "status", default: "imported", null: false
    t.integer "transaction_count", default: 0, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.decimal "closing_balance", precision: 15, scale: 2
    t.date "closing_balance_on"
    t.bigint "bank_account_id"
    t.date "balance_observed_on"
    t.index ["bank_account_id"], name: "index_finance_statements_on_bank_account_id"
    t.index ["user_id", "sha256"], name: "index_finance_statements_on_user_id_and_sha256", unique: true
    t.index ["user_id"], name: "index_finance_statements_on_user_id"
  end

  create_table "finance_transactions", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.bigint "statement_id", null: false
    t.date "booked_on", null: false
    t.string "description", limit: 500, null: false
    t.decimal "amount", precision: 15, scale: 2, null: false
    t.string "category", default: "Uncategorized", null: false
    t.boolean "tax_review", default: false, null: false
    t.boolean "excluded", default: false, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["statement_id"], name: "index_finance_transactions_on_statement_id"
    t.index ["user_id", "booked_on"], name: "index_finance_transactions_on_user_id_and_booked_on"
    t.index ["user_id"], name: "index_finance_transactions_on_user_id"
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
    t.index ["email"], name: "index_users_on_email", unique: true
    t.index ["google_uid"], name: "index_users_on_google_uid", unique: true, where: "(google_uid IS NOT NULL)"
    t.index ["platform_agent_of_id"], name: "index_users_on_platform_agent_of_id"
    t.index ["reset_password_token"], name: "index_users_on_reset_password_token", unique: true
    t.index ["unlock_token"], name: "index_users_on_unlock_token", unique: true
    t.check_constraint "usage_region IS NOT NULL OR usage_region_pending OR platform_agent_of_id IS NOT NULL", name: "users_usage_region_required"
    t.check_constraint "usage_region IS NULL OR (usage_region::text = ANY (ARRAY['AD'::character varying, 'AE'::character varying, 'AF'::character varying, 'AG'::character varying, 'AI'::character varying, 'AL'::character varying, 'AM'::character varying, 'AO'::character varying, 'AQ'::character varying, 'AR'::character varying, 'AS'::character varying, 'AT'::character varying, 'AU'::character varying, 'AW'::character varying, 'AX'::character varying, 'AZ'::character varying, 'BA'::character varying, 'BB'::character varying, 'BD'::character varying, 'BE'::character varying, 'BF'::character varying, 'BG'::character varying, 'BH'::character varying, 'BI'::character varying, 'BJ'::character varying, 'BL'::character varying, 'BM'::character varying, 'BN'::character varying, 'BO'::character varying, 'BQ'::character varying, 'BR'::character varying, 'BS'::character varying, 'BT'::character varying, 'BV'::character varying, 'BW'::character varying, 'BY'::character varying, 'BZ'::character varying, 'CA'::character varying, 'CC'::character varying, 'CD'::character varying, 'CF'::character varying, 'CG'::character varying, 'CH'::character varying, 'CI'::character varying, 'CK'::character varying, 'CL'::character varying, 'CM'::character varying, 'CN'::character varying, 'CO'::character varying, 'CR'::character varying, 'CU'::character varying, 'CV'::character varying, 'CW'::character varying, 'CX'::character varying, 'CY'::character varying, 'CZ'::character varying, 'DE'::character varying, 'DJ'::character varying, 'DK'::character varying, 'DM'::character varying, 'DO'::character varying, 'DZ'::character varying, 'EC'::character varying, 'EE'::character varying, 'EG'::character varying, 'EH'::character varying, 'ER'::character varying, 'ES'::character varying, 'ET'::character varying, 'FI'::character varying, 'FJ'::character varying, 'FK'::character varying, 'FM'::character varying, 'FO'::character varying, 'FR'::character varying, 'GA'::character varying, 'GB'::character varying, 'GD'::character varying, 'GE'::character varying, 'GF'::character varying, 'GG'::character varying, 'GH'::character varying, 'GI'::character varying, 'GL'::character varying, 'GM'::character varying, 'GN'::character varying, 'GP'::character varying, 'GQ'::character varying, 'GR'::character varying, 'GS'::character varying, 'GT'::character varying, 'GU'::character varying, 'GW'::character varying, 'GY'::character varying, 'HK'::character varying, 'HM'::character varying, 'HN'::character varying, 'HR'::character varying, 'HT'::character varying, 'HU'::character varying, 'ID'::character varying, 'IE'::character varying, 'IL'::character varying, 'IM'::character varying, 'IN'::character varying, 'IO'::character varying, 'IQ'::character varying, 'IR'::character varying, 'IS'::character varying, 'IT'::character varying, 'JE'::character varying, 'JM'::character varying, 'JO'::character varying, 'JP'::character varying, 'KE'::character varying, 'KG'::character varying, 'KH'::character varying, 'KI'::character varying, 'KM'::character varying, 'KN'::character varying, 'KP'::character varying, 'KR'::character varying, 'KW'::character varying, 'KY'::character varying, 'KZ'::character varying, 'LA'::character varying, 'LB'::character varying, 'LC'::character varying, 'LI'::character varying, 'LK'::character varying, 'LR'::character varying, 'LS'::character varying, 'LT'::character varying, 'LU'::character varying, 'LV'::character varying, 'LY'::character varying, 'MA'::character varying, 'MC'::character varying, 'MD'::character varying, 'ME'::character varying, 'MF'::character varying, 'MG'::character varying, 'MH'::character varying, 'MK'::character varying, 'ML'::character varying, 'MM'::character varying, 'MN'::character varying, 'MO'::character varying, 'MP'::character varying, 'MQ'::character varying, 'MR'::character varying, 'MS'::character varying, 'MT'::character varying, 'MU'::character varying, 'MV'::character varying, 'MW'::character varying, 'MX'::character varying, 'MY'::character varying, 'MZ'::character varying, 'NA'::character varying, 'NC'::character varying, 'NE'::character varying, 'NF'::character varying, 'NG'::character varying, 'NI'::character varying, 'NL'::character varying, 'NO'::character varying, 'NP'::character varying, 'NR'::character varying, 'NU'::character varying, 'NZ'::character varying, 'OM'::character varying, 'PA'::character varying, 'PE'::character varying, 'PF'::character varying, 'PG'::character varying, 'PH'::character varying, 'PK'::character varying, 'PL'::character varying, 'PM'::character varying, 'PN'::character varying, 'PR'::character varying, 'PS'::character varying, 'PT'::character varying, 'PW'::character varying, 'PY'::character varying, 'QA'::character varying, 'RE'::character varying, 'RO'::character varying, 'RS'::character varying, 'RU'::character varying, 'RW'::character varying, 'SA'::character varying, 'SB'::character varying, 'SC'::character varying, 'SD'::character varying, 'SE'::character varying, 'SG'::character varying, 'SH'::character varying, 'SI'::character varying, 'SJ'::character varying, 'SK'::character varying, 'SL'::character varying, 'SM'::character varying, 'SN'::character varying, 'SO'::character varying, 'SR'::character varying, 'SS'::character varying, 'ST'::character varying, 'SV'::character varying, 'SX'::character varying, 'SY'::character varying, 'SZ'::character varying, 'TC'::character varying, 'TD'::character varying, 'TF'::character varying, 'TG'::character varying, 'TH'::character varying, 'TJ'::character varying, 'TK'::character varying, 'TL'::character varying, 'TM'::character varying, 'TN'::character varying, 'TO'::character varying, 'TR'::character varying, 'TT'::character varying, 'TV'::character varying, 'TW'::character varying, 'TZ'::character varying, 'UA'::character varying, 'UG'::character varying, 'UM'::character varying, 'US'::character varying, 'UY'::character varying, 'UZ'::character varying, 'VA'::character varying, 'VC'::character varying, 'VE'::character varying, 'VG'::character varying, 'VI'::character varying, 'VN'::character varying, 'VU'::character varying, 'WF'::character varying, 'WS'::character varying, 'XG'::character varying, 'YE'::character varying, 'YT'::character varying, 'ZA'::character varying, 'ZM'::character varying, 'ZW'::character varying]::text[]))", name: "users_usage_region_allowed"
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
  add_foreign_key "finance_bank_accounts", "users"
  add_foreign_key "finance_custom_categories", "users"
  add_foreign_key "finance_insights", "users"
  add_foreign_key "finance_local_database_reports", "users", on_delete: :cascade
  add_foreign_key "finance_local_devices", "users", on_delete: :cascade
  add_foreign_key "finance_merchant_rules", "users"
  add_foreign_key "finance_profiles", "users"
  add_foreign_key "finance_statement_drafts", "finance_bank_accounts", column: "bank_account_id"
  add_foreign_key "finance_statement_drafts", "users"
  add_foreign_key "finance_statements", "finance_bank_accounts", column: "bank_account_id"
  add_foreign_key "finance_statements", "users"
  add_foreign_key "finance_transactions", "finance_statements", column: "statement_id"
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
  add_foreign_key "users", "oauth_applications", column: "platform_agent_of_id"
  add_foreign_key "webhooks_outgoing_endpoints", "scaffolding_absolutely_abstract_creative_concepts"
  add_foreign_key "webhooks_outgoing_endpoints", "teams"
  add_foreign_key "webhooks_outgoing_events", "teams"
end
