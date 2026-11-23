"""Country / Region allowlist. Must equal Rails' UsageRegion::CODES (app/models/usage_region.rb)
and the users_usage_region_allowed check constraint; tests/test_compat.py compares them."""

GLOBAL_CITIZEN_CODE = "XG"
OTHER_CODE = "XO"
STANDARD_CODES = tuple("""
AE AR AT AU BD BE BG BR CA CH CL CN CO CY CZ DE DK EE
EG ES FI FR GB GR HK HR HU ID IE IL IN IT JP KE KR KW
LK LT LU LV MA MO MT MX MY NG NL NO NZ PE PH PK PL PR
PT QA RO RU SA SE SG SI SK TH TR TW UA US VN ZA
""".split())
CODES = frozenset(STANDARD_CODES) | {GLOBAL_CITIZEN_CODE, OTHER_CODE}
