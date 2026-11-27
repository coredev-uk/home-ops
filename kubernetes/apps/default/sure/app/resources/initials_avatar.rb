# Mounted into Sure's config/initializers. Where Sure has no logo to show it
# draws a letter avatar (DS::FilledIcon, text variant); this makes that avatar
# use a name's initials ("Acme Insurance" -> "AI") and a colour derived from
# the name, so different merchants and bills are told apart at a glance and the
# same name always gets the same colour. Avatars given an explicit colour
# (accounts, categories) keep it; only the initials change for them.
#
# The logo-fallback cronjob uses .svg_data_uri for merchants that neither
# Brandfetch nor Google has an icon for, so those match the in-app avatars.
require "zlib"
require "erb"

module InitialsAvatar
  # Sure's own palette (Tag::COLORS / Category::COLORS).
  PALETTE = %w[#e99537 #4da568 #6471eb #db5a54 #df4e92 #c44fe9 #eb5429 #61c9ea #805dee #6ad28a].freeze
  SKIPPED_WORDS = %w[the of for and a an to from at].freeze

  module_function

  # Up to two initials from the first significant words; nil when the text has
  # no letters or digits to take them from (a currency symbol, say).
  def initials(name)
    words = name.to_s.scan(/[[:alnum:]][[:alnum:]'’]*/).reject { |w| SKIPPED_WORDS.include?(w.downcase) }
    return nil if words.empty?

    words.first(2).map { |w| w[0] }.join.upcase
  end

  # Deterministic across processes and restarts, unlike String#hash.
  def color(name)
    PALETTE[Zlib.crc32(name.to_s.strip.downcase) % PALETTE.size]
  end

  # The same look as the in-app avatar: a 10% tint of the colour behind the
  # initials in that colour.
  def svg_data_uri(name)
    letters = initials(name) || "?"
    fill = color(name)
    svg = <<~SVG.gsub(/\s*\n\s*/, " ").strip
      <svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80">
        <rect width="80" height="80" rx="40" fill="#{fill}" fill-opacity="0.12"/>
        <text x="40" y="40" dy="0.35em" text-anchor="middle" fill="#{fill}"
              font-family="Inter, system-ui, sans-serif" font-size="30" font-weight="600">#{ERB::Util.html_escape(letters)}</text>
      </svg>
    SVG
    "data:image/svg+xml;charset=utf-8,#{ERB::Util.url_encode(svg)}"
  end

  module FilledIconInitials
    def text
      original = super
      return original unless variant == :text && original.present?

      InitialsAvatar.initials(original) || original
    end

    def text_length
      variant == :text && text.present? ? [ super, text.length ].max : super
    end

    def hex_color
      super || (variant == :text && @text.present? ? InitialsAvatar.color(@text) : nil)
    end
  end
end

Rails.application.config.to_prepare do
  DS::FilledIcon.prepend(InitialsAvatar::FilledIconInitials) unless DS::FilledIcon < InitialsAvatar::FilledIconInitials
end
