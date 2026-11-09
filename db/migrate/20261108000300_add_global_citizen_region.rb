class AddGlobalCitizenRegion < ActiveRecord::Migration[8.1]
  # Snapshot of the supported regions. XG is an app-specific choice, not an ISO region.
  REGION_CODES = %w[
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
    replace_allowed_regions(REGION_CODES)
  end

  def down
    # The transaction will reject rollback if a user still selected Global Citizen.
    replace_allowed_regions(REGION_CODES - ["XG"])
  end

  private

  def replace_allowed_regions(codes)
    allowed = codes.map { |code| "'#{code}'" }.join(", ")
    remove_check_constraint :users, name: "users_usage_region_allowed"
    add_check_constraint :users, "usage_region IS NULL OR usage_region IN (#{allowed})",
      name: "users_usage_region_allowed"
  end
end
