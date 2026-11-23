# frozen_string_literal: true

# Fixed region allowlist: standard ISO codes plus the app's Global Citizen choice.
# Codes: IANA tzdb iso3166.tab (public domain), cross-checked with UNSD M49
# https://unstats.un.org/unsd/methodology/m49/overview/ and the ISO index
# https://www.iso.org/iso-3166-country-codes.html (TW is also an ISO code).
# Update the database check constraint with a migration when changing this list.
class UsageRegion
  GLOBAL_CITIZEN_CODE = "XG"
  # For people outside the supported countries. App-specific, not an ISO region.
  OTHER_CODE = "XO"
  STANDARD_CODES = %w[
    AE AR AT AU BD BE BG BR CA CH CL CN CO CY CZ DE DK EE
    EG ES FI FR GB GR HK HR HU ID IE IL IN IT JP KE KR KW
    LK LT LU LV MA MO MT MX MY NG NL NO NZ PE PH PK PL PR
    PT QA RO RU SA SE SG SI SK TH TR TW UA US VN ZA
  ].freeze
  CODES = (STANDARD_CODES + [GLOBAL_CITIZEN_CODE, OTHER_CODE]).sort.freeze
end
