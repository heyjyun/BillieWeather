class TrimUsageRegions < ActiveRecord::Migration[8.1]
  # Snapshot of the supported regions: mainstream countries only. XG (Global Citizen) and
  # XO (Other, for everyone outside the list) are app-specific choices, not ISO regions.
  REGION_CODES = %w[
    AE AR AT AU BD BE BG BR CA CH CL CN CO CY CZ DE DK EE
    EG ES FI FR GB GR HK HR HU ID IE IL IN IT JP KE KR KW
    LK LT LU LV MA MO MT MX MY NG NL NO NZ PE PH PK PL PR
    PT QA RO RU SA SE SG SI SK TH TR TW UA US VN ZA XG XO
  ].freeze
  # The list before this migration, for rollback.
  PREVIOUS_CODES = %w[
    AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB
    BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY
    BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX
    CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK
    FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS
    GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR
    IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA
    LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK
    ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE
    NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM
    PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG
    SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF
    TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY
    UZ VA VC VE VG VI VN VU WF WS XG YE YT ZA ZM ZW
  ].freeze

  def up
    allowed = REGION_CODES.map { |code| connection.quote(code) }.join(", ")
    # People who picked a removed region move to Other.
    execute "UPDATE users SET usage_region = 'XO' WHERE usage_region IS NOT NULL AND usage_region NOT IN (#{allowed})"
    if table_exists?("identity.pending_registrations")
      execute "UPDATE identity.pending_registrations SET usage_region = 'XO' WHERE usage_region IS NOT NULL AND usage_region NOT IN (#{allowed})"
    end
    replace_allowed_regions(REGION_CODES)
  end

  def down
    # Other did not exist before; those people become Global Citizens.
    execute "UPDATE users SET usage_region = 'XG' WHERE usage_region = 'XO'"
    if table_exists?("identity.pending_registrations")
      execute "UPDATE identity.pending_registrations SET usage_region = 'XG' WHERE usage_region = 'XO'"
    end
    replace_allowed_regions(PREVIOUS_CODES)
  end

  private

  def replace_allowed_regions(codes)
    allowed = codes.map { |code| "'#{code}'" }.join(", ")
    remove_check_constraint :users, name: "users_usage_region_allowed"
    add_check_constraint :users, "usage_region IS NULL OR usage_region IN (#{allowed})",
      name: "users_usage_region_allowed"
  end
end
