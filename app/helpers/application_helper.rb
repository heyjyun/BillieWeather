module ApplicationHelper
  include Helpers::Base

  def current_theme
    :light
  end

  def google_sign_in_enabled?
    GoogleSignIn.configured?
  end

  # Common short names people type that are not part of the region's display name.
  USAGE_REGION_SEARCH_ALIASES = {
    "US" => "usa america", "GB" => "uk britain england scotland wales", "AE" => "uae emirates",
    "KR" => "korea", "KP" => "korea", "CN" => "prc", "NL" => "holland", "CZ" => "czechia",
    "RU" => "russia", "VN" => "vietnam", "IR" => "iran", "SY" => "syria", "LA" => "laos",
    "BO" => "bolivia", "VE" => "venezuela", "TZ" => "tanzania", "MD" => "moldova", "TR" => "turkiye"
  }.freeze

  def usage_region_options
    standard = UsageRegion::STANDARD_CODES.map { |code| usage_region_option(code) }
      .sort_by { |label, _code, _data| label.downcase }
    [usage_region_option(UsageRegion::GLOBAL_CITIZEN_CODE)] + standard
  end

  # A searchable region picker. Without JavaScript it is the plain required select;
  # with /billie.js a search box filters the list as the person types.
  def usage_region_select(form, html_options = {})
    html_options = html_options.dup
    search_class = html_options.delete(:search_class)
    select_id = html_options[:id] || "#{form.object_name}_usage_region"
    select = form.select(:usage_region, usage_region_options,
      # Global Citizen is preselected until the person picks a specific region.
      # There is always a selection, so the field needs no blank option or `required` attribute;
      # the model still rejects a missing or unknown region.
      {selected: form.object.usage_region.presence || UsageRegion::GLOBAL_CITIZEN_CODE},
      {autocomplete: "country", "aria-describedby": "user_usage_region_help"}.merge(html_options).merge(id: select_id))
    search = tag.input(type: "search", class: ["bw-region-search", search_class].compact.join(" "), hidden: true,
      placeholder: t("billie.account.region_search_placeholder"), "aria-label": t("billie.account.region_search_label"),
      "aria-controls": select_id, autocomplete: "off", spellcheck: false, data: {region_search_input: ""})
    empty = tag.small(t("billie.account.region_search_empty"), hidden: true, role: "status", data: {region_search_empty: ""})
    tag.div(safe_join([search, select, empty]), class: "bw-region-picker", data: {region_search: ""})
  end

  def billie_language_path(locale)
    # Failed form submissions may render at a URL without a GET action.
    path = if request.get?
      request.path
    elsif controller_name == "google_regions"
      new_google_region_path
    elsif devise_controller?
      case controller_name
      when "registrations" then new_user_registration_path
      when "passwords" then new_user_password_path
      else new_user_session_path
      end
    else
      finance_dashboard_path
    end
    query = (request.get? ? request.query_parameters : {}).merge("locale" => locale)
    "#{path}?#{query.to_query}"
  end

  private

  def usage_region_option(code)
    label = t("usage_regions.#{code}")
    terms = [label, t("usage_regions.#{code}", locale: :en), code, USAGE_REGION_SEARCH_ALIASES[code]].compact.uniq.join(" ")
    [label, code, {data: {search: terms}}]
  end
end
