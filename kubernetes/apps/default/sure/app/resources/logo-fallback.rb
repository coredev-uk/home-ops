# Sure points every merchant with a website at Brandfetch, which answers with a
# letter tile when it has no icon for the brand. For those, use the site's own
# favicon from Google's favicon service, when the site has one, and otherwise
# the same coloured initials avatar Sure draws for merchants without a logo
# (InitialsAvatar, mounted as an initializer). Sure keeps a logo it didn't
# generate from Brandfetch, so the swap sticks across syncs.
require "net/http"

# Brandfetch redirects non-browser user agents to its usage guidelines.
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0 Safari/537.36"

def final_status(url, redirects = 3)
  uri = URI(url)
  response = Net::HTTP.start(uri.host, uri.port, use_ssl: true, open_timeout: 5, read_timeout: 10) do |http|
    http.get(uri.request_uri, "User-Agent" => USER_AGENT)
  end
  return response.code.to_i unless response.is_a?(Net::HTTPRedirection) && redirects.positive?

  final_status(URI.join(url, response["location"]).to_s, redirects - 1)
end

client_id = Setting.brand_fetch_client_id
abort "No Brandfetch client ID configured" if client_id.blank?

checked = favicons = avatars = 0
Merchant.where.not(website_url: [nil, ""]).where("logo_url LIKE 'https://cdn.brandfetch.io/%'").find_each do |merchant|
  site = merchant.website_url
  domain = URI(site.start_with?("http") ? site : "https://#{site}").host&.delete_prefix("www.")
  next if domain.blank?

  checked += 1
  # fallback/404 instead of fallback/lettermark: a 404 means Brandfetch has no icon.
  next unless final_status("https://cdn.brandfetch.io/#{domain}/icon/fallback/404/w/40/h/40?c=#{client_id}") == 404

  # Google answers 404 (with a generic globe) when the site has no favicon.
  favicon = "https://www.google.com/s2/favicons?domain=#{domain}&sz=128"
  if final_status(favicon) == 200
    merchant.update!(logo_url: favicon)
    favicons += 1
    puts "#{merchant.name} (#{domain}): no Brandfetch icon, using its favicon"
  else
    merchant.update!(logo_url: InitialsAvatar.svg_data_uri(merchant.name))
    avatars += 1
    puts "#{merchant.name} (#{domain}): no icon anywhere, using initials"
  end
rescue StandardError => e
  puts "#{merchant.name}: skipped (#{e.class}: #{e.message})"
end

puts "Checked #{checked} Brandfetch logos: #{favicons} now favicons, #{avatars} now initials"
