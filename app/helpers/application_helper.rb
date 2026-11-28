module ApplicationHelper
  include Helpers::Base

  def current_theme
    :light
  end

  def google_sign_in_enabled?
    GoogleSignIn.configured?
  end

  def usage_region_options
    standard = UsageRegion::STANDARD_CODES.map { |code| usage_region_option(code) }
      .sort_by { |label, _code, _data| label.downcase }
    # Global Citizen first and Other second (easy to reach when a country is missing), then the countries by name.
    [usage_region_option(UsageRegion::GLOBAL_CITIZEN_CODE), usage_region_option(UsageRegion::OTHER_CODE)] + standard
  end

  def usage_region_select(form, html_options = {})
    html_options = html_options.dup
    search_class = html_options.delete(:search_class)
    select_id = html_options.fetch(:id) { form.field_id(:usage_region) }
    select = form.select(:usage_region, usage_region_options,
      {selected: form.object.usage_region.presence || UsageRegion::GLOBAL_CITIZEN_CODE},
      {autocomplete: "country", "aria-describedby": "user_usage_region_help"}.merge(html_options).merge(id: select_id))
    searchable_select(select, id: select_id, type: "region", search_class: search_class,
      label: t("billie.account.region_search_label"), placeholder: t("billie.account.region_search_placeholder"),
      no_match: t("billie.account.region_search_empty"), disabled: html_options[:disabled])
  end

  # Without JavaScript the original select remains available at full width.
  def searchable_select(select, id:, label:, placeholder:, no_match:, type: "", search_class: nil, disabled: false)
    search_id = "#{id}_search"
    list_id = "#{id}_matches"
    search = tag.input(type: "search", id: search_id, class: search_class, hidden: true, disabled: disabled,
      placeholder: placeholder, role: "combobox", "aria-label": label,
      "aria-controls": list_id, "aria-expanded": "false", "aria-autocomplete": "list",
      autocomplete: "off", spellcheck: false)
    list = tag.ul(id: list_id, hidden: true, role: "listbox", "aria-labelledby": search_id)
    empty = tag.small(no_match, hidden: true, role: "status")
    tag.div(safe_join([search, select, list, empty]), class: "bw-searchable-select", data: {searchable_select: type})
  end

  def billie_language_path(locale)
    # Failed form submissions may render at a URL without a GET action.
    path = if request.get? || request.head?
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
    terms = [:en, :"zh-CN", :"zh-TW"].map { |locale| t("usage_regions.#{code}", locale: locale) }
    terms = [label, *terms, code].uniq.join(" ")
    [label, code, {data: {search: terms}}]
  end
end
